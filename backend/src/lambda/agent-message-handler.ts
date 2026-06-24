/**
 * Agent Message Handler Lambda
 * Handles "message.sent_to_agent" events from EventBridge
 * Sends messages to the agentCore runtime via SSM parameter lookup
 * Stores responses and triggers AppSync subscriptions
 */

import { EventBridgeEvent } from "aws-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { v4 as uuidv4 } from "uuid";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { IdempotencyGuard } from "../utils/idempotency";

const ssmClient = new SSMClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE!;
const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;
const idempotencyGuard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

// ── SSM Cache (persists across warm Lambda invocations) ──────────────
let _agentConfigCache: Record<string, { config: AgentCoreConfig; cachedAt: number }> = {};
const SSM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── SigV4 Credential Cache (per invocation) ─────────────────────────
let _cachedCredentials: any = null;

export function _resetCaches(): void {
  _agentConfigCache = {};
  _cachedCredentials = null;
}

export async function getCredentials(): Promise<any> {
  if (!_cachedCredentials) {
    _cachedCredentials = await defaultProvider()();
  }
  return _cachedCredentials;
}

interface MessageSentToAgentEvent {
  projectId: string;
  agentId: string;
  message: string;
  messageId: string;
  userId: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

interface AgentCoreConfig {
  agentRuntimeArn: string;
  region?: string;
}

/**
 * Get agent configuration from SSM Parameter Store
 */
export async function getAgentConfig(agentId: string): Promise<AgentCoreConfig> {
  // Check cache
  const now = Date.now();
  const cached = _agentConfigCache[agentId];
  if (cached && now - cached.cachedAt < SSM_CACHE_TTL) {
    console.log(`SSM cache hit for agent ${agentId}`);
    return cached.config;
  }

  const environment = process.env.ENVIRONMENT || 'dev';
  const parameterName = `/citadel/agents/${agentId}-${environment}`;

  try {
    const command = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    });

    const response = await ssmClient.send(command);

    if (!response.Parameter?.Value) {
      throw new Error(`No value found for parameter: ${parameterName}`);
    }

    // Parse the parameter value (expecting JSON with agentRuntimeArn)
    const config = JSON.parse(response.Parameter.Value);

    if (!config.agentRuntimeArn) {
      throw new Error(
        `Invalid agent configuration in parameter: ${parameterName}. Missing agentRuntimeArn`
      );
    }

    _agentConfigCache[agentId] = { config, cachedAt: Date.now() };

    return config;
  } catch (error) {
    console.error(`Failed to get agent config for ${agentId}:`, error);
    throw error;
  }
}

/**
 * Send message to AgentCore Runtime
 * Uses the bedrock-agentcore service API
 */
async function sendMessageToAgentCore(
  config: AgentCoreConfig,
  message: string,
  sessionId: string,
  sessionAttributes?: Record<string, any>
): Promise<string> {
  try {
    const region = config.region || process.env.AWS_REGION || "ap-southeast-2";
    const client = new BedrockAgentCoreClient({ region });

    // Prepare payload for AgentCore - simple format matching Python CLI
    const payload = JSON.stringify({
      prompt: message,
      session_id: sessionId,
      ...(sessionAttributes &&
        Object.keys(sessionAttributes).length > 0 && { sessionAttributes }),
    });

    console.log("Invoking AgentCore:", {
      agentRuntimeArn: config.agentRuntimeArn,
      sessionId: sessionId,
      region: region,
      payload: payload,
    });

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: config.agentRuntimeArn,
      runtimeSessionId: sessionId,
      payload: payload,
      qualifier: "DEFAULT",
    });

    const response = await client.send(command);

    console.log("AgentCore invocation response:", {
      statusCode: response.$metadata.httpStatusCode,
      requestId: response.$metadata.requestId,
      contentType: response.contentType,
    });

    // Handle the streaming response
    let responseText = "";

    if (response.response) {
      // Check if it's a streaming response
      if (
        response.contentType &&
        response.contentType.includes("text/event-stream")
      ) {
        console.log("Processing streaming response...");

        // Read the stream
        const chunks: string[] = [];
        const stream = response.response as any;

        // Convert stream to string
        for await (const chunk of stream) {
          if (chunk) {
            const chunkStr = Buffer.from(chunk).toString("utf-8");
            chunks.push(chunkStr);
          }
        }

        const fullResponse = chunks.join("");
        console.log("Raw stream response:", fullResponse);

        // Parse event-stream format
        const lines = fullResponse.split("\n");
        const dataChunks: string[] = [];

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.substring(6);
            try {
              // Try to parse as JSON
              const parsed = JSON.parse(data);
              if (typeof parsed === "string") {
                dataChunks.push(parsed);
              } else if (parsed.text) {
                dataChunks.push(parsed.text);
              } else {
                dataChunks.push(JSON.stringify(parsed));
              }
            } catch {
              // If not JSON, use as-is
              dataChunks.push(data);
            }
          }
        }

        responseText = dataChunks.join("");
      } else {
        // Non-streaming response
        const buffer = await response.response.transformToByteArray();
        responseText = Buffer.from(buffer).toString("utf-8");

        // Try to parse as JSON
        try {
          const parsed = JSON.parse(responseText);
          if (parsed.response) {
            responseText = parsed.response;
          } else if (parsed.output) {
            responseText = parsed.output;
          }
        } catch {
          // Use as-is if not JSON
        }
      }
    }

    if (!responseText) {
      responseText = "Agent processing completed (no response text)";
    }

    console.log(
      "Agent response:",
      responseText.substring(0, 200) + (responseText.length > 200 ? "..." : "")
    );
    console.log("AgentCore invocation completed successfully");
    return responseText;
  } catch (error) {
    console.error("Failed to send message to AgentCore:", error);
    throw error;
  }
}

/**
 * Send a progress update message to notify frontend that agent is processing
 */
async function sendProgressUpdate(
  projectId: string,
  agentId: string,
  message: string,
  correlationId: string
): Promise<void> {
  const messageId = uuidv4();
  const timestamp = new Date().toISOString();

  const progressRecord = {
    projectId,
    timestamp,
    id: messageId,
    agentId,
    message,
    messageType: "PROGRESS_UPDATE",
    correlationId,
  };

  console.log("Progress update stored in DynamoDB:", progressRecord.id);

  // Trigger AppSync mutation to fire subscriptions
  await triggerAppSyncMutation(progressRecord);

  console.log("Progress update sent to frontend");
}

/**
 * Store agent response in DynamoDB
 */
async function storeAgentResponse(
  projectId: string,
  agentId: string,
  message: string,
  correlationId: string,
  metadata?: Record<string, any>
): Promise<any> {
  const messageId = uuidv4();
  const timestamp = new Date().toISOString();

  const responseRecord = {
    projectId,
    timestamp,
    id: messageId,
    agentId,
    message,
    messageType: "AGENT_RESPONSE",
    correlationId,
    ...(metadata && { metadata: JSON.stringify(metadata) }),
  };

  await docClient.send(
    new PutCommand({
      TableName: CONVERSATIONS_TABLE,
      Item: responseRecord,
    })
  );

  console.log("Agent response stored in DynamoDB:", responseRecord.id);
  return responseRecord;
}

/**
 * Trigger AppSync mutation to fire subscriptions
 */
async function triggerAppSyncMutation(messageRecord: any): Promise<void> {
  const mutation = `
    mutation PublishMessage($input: PublishMessageInput!) {
      publishConversationMessage(input: $input) {
        id
        projectId
        agentId
        message
        messageType
        timestamp
      }
    }
  `;

  const variables = {
    input: {
      id: messageRecord.id,
      projectId: messageRecord.projectId,
      agentId: messageRecord.agentId,
      message: messageRecord.message,
      messageType: messageRecord.messageType,
      timestamp: messageRecord.timestamp,
      ...(messageRecord.metadata && { metadata: messageRecord.metadata }),
      ...(messageRecord.correlationId && {
        correlationId: messageRecord.correlationId,
      }),
    },
  };

  const body = JSON.stringify({ query: mutation, variables });
  const url = new URL(APPSYNC_ENDPOINT);

  const request = new HttpRequest({
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: url.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    service: "appsync",
    region: process.env.AWS_REGION || "us-east-1",
    credentials: await getCredentials(),
    sha256: Sha256,
  });

  const signedRequest = await signer.sign(request);

  console.log("Triggering AppSync mutation:", {
    endpoint: APPSYNC_ENDPOINT,
    messageId: messageRecord.id,
  });

  const response = await fetch(APPSYNC_ENDPOINT, {
    method: signedRequest.method,
    headers: signedRequest.headers as any,
    body: signedRequest.body,
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    console.error("AppSync mutation failed:", result);
    throw new Error(
      `AppSync mutation failed: ${JSON.stringify(result.errors)}`
    );
  }

  console.log("AppSync mutation triggered successfully");
}

/**
 * Lambda handler for EventBridge events
 */
export const handler = async (
  event: EventBridgeEvent<"message.sent_to_agent", MessageSentToAgentEvent>
): Promise<void> => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // Idempotency key: prefer the logical message id (deterministic for the
  // document-indexed trigger, a unique uuid for every other producer) so that
  // duplicate emits of the same logical message collapse to one execution.
  // Fall back to the EventBridge envelope id for any producer that omits a
  // messageId (events.ts publishEvent does not set one), preserving today's
  // behaviour for those.
  const idempotencyKey = event.detail?.messageId ?? event.id;

  // Idempotency check using the logical message id (falls back to event.id).
  const { executed } = await idempotencyGuard.withIdempotency(idempotencyKey, async () => {
    const { projectId, agentId, message, messageId, userId, metadata } =
      event.detail;

    try {
      // Validate required fields
      if (!projectId || !agentId || !message) {
        throw new Error(
          "Missing required fields: projectId, agentId, or message"
        );
      }

      console.log(
        `Processing message for project ${projectId}, agent ${agentId}`
      );

    // Get agent configuration from SSM
    const agentConfig = await getAgentConfig(agentId);
    console.log(`Retrieved agent config:`, agentConfig);

    // Use projectId as sessionId to maintain conversation context
    const sessionId = projectId;

    // Prepare session attributes
    const sessionAttributes: Record<string, any> = {
      projectId: projectId,
      userId: userId,
      messageId: messageId,
      ...(metadata && { metadata }),
    };

    console.log(
      "Session attributes:",
      JSON.stringify(sessionAttributes, null, 2)
    );
    console.log("Metadata type:", typeof metadata);
    console.log("Metadata value:", metadata);

    // Send progress update to frontend (agent is thinking)
    await sendProgressUpdate(
      projectId,
      agentId,
      "Agent is processing your request...",
      messageId
    );

    // Send message to AgentCore
    const agentResponse = await sendMessageToAgentCore(
      agentConfig,
      message,
      sessionId,
      sessionAttributes
    );

    console.log(`Successfully received response from agent ${agentId}`);

    // Store agent response in DynamoDB
    const responseRecord = await storeAgentResponse(
      projectId,
      agentId,
      agentResponse,
      messageId,
      metadata
    );

    // Trigger AppSync mutation to fire subscriptions
    await triggerAppSyncMutation(responseRecord);

    console.log(
      `Successfully processed message for agent ${agentId} for project ${projectId}`
    );
  } catch (error: unknown) {
    console.error("Error processing message:", error);

    // Store error as agent response so frontend gets notified
    try {
      const errorMessage = `⚠️ Sorry, I encountered an error processing your request. Please try again.\n\n_Error: ${(error instanceof Error ? error.message : '') || 'Unknown error'}_`;
      const errorRecord = await storeAgentResponse(
        projectId,
        agentId,
        errorMessage,
        messageId,
        metadata
      );
      await triggerAppSyncMutation(errorRecord);
    } catch (notifyError) {
      console.error("Failed to notify frontend of error:", notifyError);
    }
  }
  }); // end idempotency guard

  if (!executed) {
    console.log("Skipping duplicate event:", idempotencyKey);
  }
};
