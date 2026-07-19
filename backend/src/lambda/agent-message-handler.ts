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
import { sanitizeUntrustedAgentOutput } from "../utils/sanitize-agent-output";
import { RegistryService } from "../services/registry-service";
import type {
  AgentCustomMetadata,
  AgentInvocationBlock,
  AgentOrigin,
} from "../services/registry-service";
import { UnknownProtocolError } from "../adapters/agent-source/base";
import type {
  AgentCapabilityDescriptor,
  AgentSourceAdapter,
  AgentSourceAdapterRegistry,
  InvokeRequest,
} from "../adapters/agent-source/base";
import { buildDefaultAgentSourceRegistry } from "../adapters/agent-source/registry-factory";
import { isCrossAccountRoleArn } from "../utils/trust-path";
import {
  vendImportCredentials,
  toInvokeCredentials,
} from "../adapters/agent-source/invoke-support";
import type { InvokeCredentials } from "../adapters/agent-source/invoke-support";

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
type SigV4Credentials = Awaited<ReturnType<ReturnType<typeof defaultProvider>>>;
let _cachedCredentials: SigV4Credentials | null = null;

// ── Agent-source adapter registry (import dispatch) ─────────────────
// Lazily built so the legacy path pays nothing when import is disabled.
let _agentSourceRegistry: AgentSourceAdapterRegistry | null = null;

function getAgentSourceRegistry(): AgentSourceAdapterRegistry {
  if (!_agentSourceRegistry) {
    _agentSourceRegistry = buildImportRegistry();
  }
  return _agentSourceRegistry;
}

/**
 * Build an agent-source registry wired with the invoke-side secret resolver
 * and, optionally, CROSS-ACCOUNT invoke credentials threaded into the AWS-native
 * adapters (AGENTCORE_RUNTIME / LAMBDA_INVOKE / BEDROCK_AGENT).
 *
 * credential-manager is required HERE (not at module load) so its module-scope
 * SDK-client construction stays OFF the legacy AgentCore cold-start path — the
 * legacy path loads it only if/when an imported agent is actually dispatched.
 * The HTTP + MCP adapters use the resolver to turn an invocation `auth.secretRef`
 * (API_KEY / OAUTH2 / COGNITO) into the request Authorization header, run under
 * THIS handler Lambda's identity (secretsmanager:GetSecretValue on
 * /citadel/agents/*). When `credentialProvider` is set (cross-account invoke),
 * the AWS-native adapters build their protocol SDK client with those assumed
 * credentials instead of the handler's identity.
 */
function buildImportRegistry(
  credentialProvider?: InvokeCredentials,
): AgentSourceAdapterRegistry {
  const { getAgentInvocationSecret } =
    require("../utils/credential-manager") as typeof import("../utils/credential-manager");
  return buildDefaultAgentSourceRegistry({
    resolveSecret: (ref: string) => getAgentInvocationSecret(ref),
    credentialProvider,
  });
}

/**
 * Choose the adapter registry for an imported invocation.
 *
 * CROSS-ACCOUNT (invocation.roleArn's account != ACCOUNT_ID): assume the
 * customer-provided invoke role via {@link vendImportCredentials} (externalId-
 * gated) and build a fresh registry whose AWS-native adapters use the assumed
 * credentials. If the assume FAILS (or yields no usable credentials) for a
 * cross-account target, THROW — we must NOT silently fall back to the handler's
 * own identity, which would invoke with the wrong account's credentials. The
 * assumed credentials are NEVER logged.
 *
 * SAME-ACCOUNT (or no roleArn): return the cached default registry — the
 * handler's own identity, byte-identical to today.
 */
async function resolveImportRegistry(
  invocation: AgentInvocationBlock,
  agentId: string,
): Promise<AgentSourceAdapterRegistry> {
  const roleArn = invocation.roleArn;
  if (!roleArn || !isCrossAccountRoleArn(roleArn, process.env.ACCOUNT_ID)) {
    return getAgentSourceRegistry();
  }

  let credentialProvider: InvokeCredentials | undefined;
  try {
    const vended = await vendImportCredentials(invocation);
    credentialProvider = toInvokeCredentials(vended);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: "error",
        msg: "import-dispatch: cross-account invoke-role assume failed; not falling back to handler identity",
        agentId,
        protocol: invocation.protocol,
        error: message,
      })
    );
    throw new Error(
      `Cross-account invoke-role assume failed for imported agent ${agentId}: ${message}`
    );
  }

  if (!credentialProvider) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "import-dispatch: cross-account invoke-role assume produced no credentials; not falling back to handler identity",
        agentId,
        protocol: invocation.protocol,
      })
    );
    throw new Error(
      `Cross-account invoke-role assume produced no credentials for imported agent ${agentId}`
    );
  }

  return buildImportRegistry(credentialProvider);
}

/** True only when the agent-import dispatcher is explicitly enabled. */
export function isImportEnabled(): boolean {
  return process.env.IMPORT_ENABLED === "true";
}

export function _resetCaches(): void {
  _agentConfigCache = {};
  _cachedCredentials = null;
  _agentSourceRegistry = null;
}

export async function getCredentials(): Promise<SigV4Credentials> {
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
  metadata?: Record<string, unknown>;
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
  sessionAttributes?: Record<string, unknown>
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
        const stream = response.response as unknown as AsyncIterable<Uint8Array>;

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

/** Conversation row persisted for an agent response. */
interface StoredAgentMessage {
  projectId: string;
  timestamp: string;
  id: string;
  agentId: string;
  message: string;
  messageType: string;
  correlationId: string;
  metadata?: string;
}

/**
 * Store agent response in DynamoDB
 */
async function storeAgentResponse(
  projectId: string,
  agentId: string,
  message: string,
  correlationId: string,
  metadata?: Record<string, unknown>
): Promise<StoredAgentMessage> {
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
async function triggerAppSyncMutation(messageRecord: StoredAgentMessage): Promise<void> {
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
    headers: signedRequest.headers,
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

// ── Imported-invocation dispatch (additive + gated) ───────────────────────
// Safe metadata defaults for deserializing an agent's Registry record. Records
// that predate the import feature carry no `invocation` block and are treated
// as legacy AGENTCORE_RUNTIME agents (back-compat).
const IMPORT_AGENT_META_DEFAULTS: AgentCustomMetadata = {
  categories: [],
  icon: "",
  state: "active",
};

/**
 * Build the minimal capability descriptor an adapter needs to invoke an
 * imported agent. Only the invocation/origin blocks are meaningful here; the
 * descriptive fields are placeholders until describe() is implemented.
 */
function buildImportedDescriptor(
  name: string,
  invocation: AgentInvocationBlock,
  origin: AgentOrigin | undefined
): AgentCapabilityDescriptor {
  return {
    name,
    description: "",
    version: "1.0.0",
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation,
    origin:
      origin ?? {
        substrate: invocation.protocol,
        discoveredAt: new Date().toISOString(),
        ownership: "external",
      },
  };
}

/**
 * Additively dispatch a message to an imported agent when (a) IMPORT_ENABLED is
 * on, (b) REGISTRY_ID is configured, and (c) the agent's Registry record
 * carries an `invocation` block. On success it stores + publishes the response
 * exactly as the legacy path does and returns `true`.
 *
 * Returns `false` (caller falls back to the UNCHANGED SSM -> InvokeAgentRuntime
 * path) when import is disabled, REGISTRY_ID is missing, the record/invocation
 * is absent, or the Registry read throws.
 *
 * Throws when the invocation block names an unregistered protocol — an explicit
 * but unknown protocol is a real configuration error, NOT a legacy agent, so it
 * must NOT silently fall through to the legacy path.
 */
async function dispatchImportedInvocation(
  projectId: string,
  agentId: string,
  message: string,
  userId: string,
  messageId: string,
  metadata: Record<string, unknown> | undefined
): Promise<boolean> {
  if (!isImportEnabled()) return false;

  const registryId = process.env.REGISTRY_ID;
  if (!registryId) return false;

  let invocation: AgentInvocationBlock | undefined;
  let origin: AgentOrigin | undefined;
  let descriptorName = agentId;
  try {
    const region = process.env.AWS_REGION || "ap-southeast-2";
    const registryService = new RegistryService({ registryId, region });
    const record = await registryService.getResource("agent", agentId);
    if (!record) return false;
    const meta = registryService.deserializeCustomMetadata<AgentCustomMetadata>(
      record.customDescriptorContent ?? null,
      IMPORT_AGENT_META_DEFAULTS
    );
    invocation = meta.invocation;
    origin = meta.origin;
    descriptorName = record.name || agentId;
  } catch (error) {
    // A Registry read failure must not break an import-unaware agent.
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "import-dispatch: registry read failed; falling back to legacy AgentCore path",
        agentId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return false;
  }

  // No invocation block => legacy agent. Fall back unchanged.
  if (!invocation) return false;

  // ── Cross-account invoke selection (Phase 2, agent-import) ────────────────
  // CROSS-ACCOUNT (invocation.roleArn account != ACCOUNT_ID) => assume the
  // invoke role (externalId-gated) and build the AWS-native adapters with the
  // assumed credentials; a failed assume FAILS the invoke (handled by the
  // surrounding catch) rather than silently falling back to the handler
  // identity. SAME-ACCOUNT (or no roleArn) => the cached registry + handler
  // identity, byte-identical to today.
  //
  // TODO(agent-import): only the AWS-native protocol invoke consumes the
  // assumed credentials here. Cross-account wiring for the test-invoke
  // (testImportedAgent), cross-account discovery, and HTTP/MCP SIGV4
  // cross-account signing are deliberate follow-ups.
  const registry = await resolveImportRegistry(invocation, agentId);

  // Explicit invocation block: resolve the protocol adapter. An unknown
  // protocol is a real configuration error, so log a structured error and
  // rethrow — we must NOT fall back to the legacy path.
  let adapter: AgentSourceAdapter;
  try {
    adapter = registry.resolve(invocation.protocol);
  } catch (error) {
    if (error instanceof UnknownProtocolError) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "import-dispatch: unknown invocation protocol; not falling back to legacy path",
          agentId,
          protocol: invocation.protocol,
          error: error.message,
        })
      );
    }
    throw error;
  }

  const sessionId = projectId;
  const sessionAttributes: Record<string, unknown> = {
    projectId,
    userId,
    messageId,
    ...(metadata && { metadata }),
  };

  const descriptor = buildImportedDescriptor(descriptorName, invocation, origin);
  const req: InvokeRequest = {
    prompt: message,
    sessionId,
    attributes: sessionAttributes,
  };

  // Notify the frontend, invoke via the adapter, then store + publish exactly
  // as the legacy path does.
  await sendProgressUpdate(
    projectId,
    agentId,
    "Agent is processing your request...",
    messageId
  );

  const response = await adapter.invoke(req, descriptor);

  // ── Untrusted-output boundary ───────────────────────────────────────────
  // A FOREIGN (imported) agent's response re-enters Citadel orchestration
  // here, so it is untrusted data. Neutralize prompt-injection / instruction-
  // like content BEFORE it is stored or published downstream. The trusted
  // legacy AgentCore path (below) is intentionally NOT sanitized.
  const { sanitized, modified, matches } = sanitizeUntrustedAgentOutput(
    response.output
  );
  if (modified) {
    // Log the matched pattern IDS only — never the raw (untrusted) payload.
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "import-dispatch: sanitized untrusted imported-agent output before store/publish",
        agentId,
        protocol: invocation.protocol,
        matches,
      })
    );
  }

  console.log(
    `Imported agent ${agentId} responded via ${invocation.protocol} adapter`
  );

  const responseRecord = await storeAgentResponse(
    projectId,
    agentId,
    sanitized,
    messageId,
    metadata
  );
  await triggerAppSyncMutation(responseRecord);

  console.log(
    `Successfully processed imported message for agent ${agentId} for project ${projectId}`
  );
  return true;
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

    // ── Imported-invocation dispatch (additive + gated) ──────────────────
    // When IMPORT_ENABLED and the agent's Registry record carries an
    // `invocation` block, route through the protocol adapter registry and
    // store the response exactly as the legacy path does. Returns false to
    // fall back to the UNCHANGED AgentCore path below (flag off, no
    // REGISTRY_ID, no record/invocation, or a Registry read error). An unknown
    // protocol throws and is handled by the surrounding catch — it must NOT
    // fall through to the legacy path.
    if (
      await dispatchImportedInvocation(
        projectId,
        agentId,
        message,
        userId,
        messageId,
        metadata
      )
    ) {
      return;
    }

    // Get agent configuration from SSM
    const agentConfig = await getAgentConfig(agentId);
    console.log(`Retrieved agent config:`, agentConfig);

    // Use projectId as sessionId to maintain conversation context
    const sessionId = projectId;

    // Prepare session attributes
    const sessionAttributes: Record<string, unknown> = {
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
