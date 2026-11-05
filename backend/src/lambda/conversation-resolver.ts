/**
 * Conversation Resolver Lambda
 * Handles sendMessage mutation - stores message and publishes to EventBridge
 *
 * CIT-268: clientMessageId dedup + TURN_ACCEPTED acknowledgement.
 * - When clientMessageId is provided, a conditional PutCommand prevents
 *   duplicate writes. If the condition fails (duplicate), the existing
 *   message is returned and no EventBridge event or TURN_ACCEPTED is
 *   published.
 * - After storing a USER_INPUT, a TURN_ACCEPTED message is published via
 *   the publishConversationMessage AppSync mutation (subscription-only,
 *   not stored) BEFORE the EventBridge dispatch.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { v4 as uuidv4 } from "uuid";
import { mintRunId, buildDispatchContext } from "../utils/run-id";
import { assertProjectAccess } from "../utils/project-access";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;

/** Cached credential provider — reused across invocations in the same
 *  Lambda container, same pattern as agent-message-handler. */
let cachedCredentials: ReturnType<typeof defaultProvider> | undefined;
function getCredentials() {
  if (!cachedCredentials) {
    cachedCredentials = defaultProvider();
  }
  return cachedCredentials;
}

interface ConversationMessageInput {
  agentId: string;
  message: string;
  messageType:
    | "USER_INPUT"
    | "AGENT_RESPONSE"
    | "SYSTEM_NOTIFICATION"
    | "PROGRESS_UPDATE"
    | "TURN_ACCEPTED";
  metadata?: string;
  correlationId?: string;
  clientMessageId?: string;
}

interface AppSyncEvent {
  arguments: {
    projectId: string;
    message: ConversationMessageInput;
  };
  identity: {
    sub: string;
    username?: string;
  };
  info: {
    fieldName: string;
  };
}

/**
 * Publish a TURN_ACCEPTED message via the publishConversationMessage
 * AppSync mutation. This fires the onConversationMessage subscription
 * WITHOUT storing a DynamoDB row (the publishConversationMessage resolver
 * is a pass-through that returns the input, triggering the subscription).
 */
async function publishTurnAccepted(
  projectId: string,
  agentId: string,
  originalMessageId: string,
): Promise<void> {
  // Guard: skip if APPSYNC_ENDPOINT is not configured (tests, local).
  if (!APPSYNC_ENDPOINT) return;

  const mutation = `
    mutation PublishMessage($input: PublishMessageInput!) {
      publishConversationMessage(input: $input) {
        id projectId agentId message messageType timestamp
      }
    }
  `;

  const variables = {
    input: {
      id: uuidv4(),
      projectId,
      agentId,
      message: "",
      messageType: "TURN_ACCEPTED",
      timestamp: new Date().toISOString(),
      metadata: JSON.stringify({ originalMessageId }),
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

  const response = await fetch(APPSYNC_ENDPOINT, {
    method: signedRequest.method,
    headers: signedRequest.headers,
    body: signedRequest.body,
  });

  const result = await response.json();
  if (!response.ok || result.errors) {
    console.error("TURN_ACCEPTED publish failed:", result);
    // Non-fatal: the user still gets the mutation return value.
  }
}

/**
 * Look up an existing message by (projectId, clientMessageId) using a
 * Query on the main table with a filter. This is a rare path (retries
 * only) so a scan-filter on a sparse attribute is acceptable without
 * a GSI.
 */
async function findByClientMessageId(
  projectId: string,
  clientMessageId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      KeyConditionExpression: "projectId = :pk",
      FilterExpression: "clientMessageId = :cmid",
      ExpressionAttributeValues: {
        ":pk": projectId,
        ":cmid": clientMessageId,
      },
      Limit: 1,
    }),
  );
  return result.Items?.[0];
}

/**
 * Send message mutation handler
 */
async function sendMessage(event: AppSyncEvent) {
  const { projectId, message } = event.arguments;
  const userId = event.identity.sub;

  // Security fix (finding 60a5a6ae, CRE item 1): projectId is client-supplied
  // and drives both the DynamoDB write and the EventBridge dispatch that
  // triggers another tenant's agents (prompt/message injection). Reconcile
  // it against the caller BEFORE any write — reusing the same gate
  // project-resolver.ts's getProject enforces. Fail closed on any
  // identity/lookup failure.
  await assertProjectAccess(projectId, userId, event);

  console.log("Sending message:", {
    projectId,
    agentId: message.agentId,
    userId,
  });

  // ── CIT-268: clientMessageId dedup ──────────────────────────────────
  // If the client supplied a clientMessageId (retry scenario), check
  // whether we already stored a message with that id for this project.
  // If so, return the existing record without emitting a second event.
  if (message.clientMessageId) {
    const existing = await findByClientMessageId(
      projectId,
      message.clientMessageId,
    );
    if (existing) {
      console.log("Dedup hit — returning existing message:", existing.id);
      return existing;
    }
  }

  // Create message record
  const messageId = uuidv4();
  const timestamp = new Date().toISOString();
  // Server-minted only (Pass 1, decision f1cbd5ef) — ConversationMessageInput
  // has no runId field, so there is nothing to strip; this mint is the sole
  // source. Chat is one of the 4 canonical entry points.
  const runId = mintRunId();

  const messageRecord: Record<string, unknown> = {
    projectId,
    timestamp,
    id: messageId,
    agentId: message.agentId,
    message: message.message,
    messageType: message.messageType,
    userId,
    runId,
    ...(message.metadata && { metadata: message.metadata }),
    ...(message.correlationId && { correlationId: message.correlationId }),
    ...(message.clientMessageId && {
      clientMessageId: message.clientMessageId,
    }),
  };

  // Store in DynamoDB
  await docClient.send(
    new PutCommand({
      TableName: CONVERSATIONS_TABLE,
      Item: messageRecord,
    }),
  );

  console.log("Message stored in DynamoDB:", messageRecord.id);

  // ── CIT-268: publish TURN_ACCEPTED before EventBridge dispatch ──────
  if (message.messageType === "USER_INPUT") {
    try {
      await publishTurnAccepted(projectId, message.agentId, messageId);
      console.log("TURN_ACCEPTED published for message:", messageId);
    } catch (error) {
      console.error("Failed to publish TURN_ACCEPTED:", error);
      // Non-fatal — the user still gets the mutation return.
    }
  }

  // Publish to EventBridge (async - don't wait for agent)
  if (message.messageType === "USER_INPUT") {
    try {
      // Check if metadata is already an object or a string
      let parsedMetadata;
      if (message.metadata) {
        if (typeof message.metadata === "string") {
          parsedMetadata = JSON.parse(message.metadata);
        } else {
          parsedMetadata = message.metadata;
        }
      }

      console.log("Publishing to EventBridge with metadata:", {
        metadataRaw: message.metadata,
        metadataType: typeof message.metadata,
        parsedMetadata,
        parsedType: typeof parsedMetadata,
      });

      // Build-time durability guard (Pass 1, decision f1cbd5ef, design §3
      // layer 1): route the outbound envelope through buildDispatchContext,
      // whose `runId` parameter is REQUIRED — a future refactor that drops
      // `runId` here fails `tsc`, not just a runtime check.
      const dispatchContext = buildDispatchContext({
        runId,
        projectId,
        agentId: message.agentId,
        message: message.message,
        messageId: messageRecord.id,
        userId,
        timestamp: messageRecord.timestamp,
        metadata: parsedMetadata,
      });

      await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: "citadel",
              DetailType: "message.sent_to_agent",
              Detail: JSON.stringify(dispatchContext),
              EventBusName: EVENT_BUS_NAME,
            },
          ],
        }),
      );

      console.log("Event published to EventBridge");
    } catch (error) {
      console.error("Failed to publish to EventBridge:", error);
      // Don't fail the mutation - message is already stored
    }
  }

  // Return message immediately (frontend gets it right away)
  return messageRecord;
}

/**
 * Get conversation history query handler
 */
async function getConversationHistory(event: AppSyncEvent) {
  const { projectId, limit, nextToken } = event.arguments as unknown as {
    projectId: string;
    limit?: number;
    nextToken?: string;
  };
  const userId = event.identity.sub;

  // Security fix (finding 60a5a6ae, CRE item 1): projectId is client-supplied
  // and drives the DynamoDB query — reconcile it against the caller BEFORE
  // any read (cross-tenant conversation disclosure otherwise). Reuses the
  // same gate as sendMessage.
  await assertProjectAccess(projectId, userId, event);

  console.log("Getting conversation history for project:", projectId);

  const effectiveLimit = Math.min(Math.max(limit || 50, 1), 200);

  const result = await docClient.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      KeyConditionExpression: "projectId = :projectId",
      ExpressionAttributeValues: {
        ":projectId": projectId,
      },
      ScanIndexForward: false, // newest first for pagination
      Limit: effectiveLimit,
      ...(nextToken && {
        ExclusiveStartKey: JSON.parse(
          Buffer.from(nextToken, "base64").toString(),
        ),
      }),
    }),
  );

  const items = (result.Items || []).reverse(); // return in chronological order
  const responseNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
    : null;

  return { items, nextToken: responseNextToken };
}

/**
 * Publish conversation message mutation handler (IAM auth only)
 * Called by agent-message-handler Lambda to trigger subscriptions
 */
async function publishConversationMessage(event: AppSyncEvent) {
  const { input } = event.arguments as unknown as {
    input: ConversationMessageInput & { id?: string };
  };

  console.log("Publishing conversation message:", input.id);

  // Simply return the input - AppSync will trigger the subscription
  // The message is already stored in DynamoDB by agent-message-handler
  return input;
}

/**
 * Send message to agent (simplified interface for direct calls)
 */
async function sendMessageToAgent(event: AppSyncEvent) {
  const { projectId, agentId, message } = event.arguments as unknown as {
    projectId: string;
    agentId: string;
    message: string;
  };

  // Convert to sendMessage format
  const convertedEvent = {
    ...event,
    arguments: {
      projectId,
      message: {
        agentId,
        message,
        messageType: "USER_INPUT" as const,
      },
    },
  };

  return await sendMessage(convertedEvent as AppSyncEvent);
}

/**
 * Lambda handler
 */
export const handler = async (event: AppSyncEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    switch (event.info.fieldName) {
      case "sendMessage":
        return await sendMessage(event);
      case "sendMessageToAgent":
        return await sendMessageToAgent(event);
      case "getConversationHistory":
        return await getConversationHistory(event);
      case "publishConversationMessage":
        return await publishConversationMessage(event);
      default:
        throw new Error(`Unknown field: ${event.info.fieldName}`);
    }
  } catch (error) {
    console.error("Error handling request:", error);
    throw error;
  }
};
