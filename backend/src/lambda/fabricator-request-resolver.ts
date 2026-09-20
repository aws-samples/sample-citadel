import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import type { RegistryRecord } from "../services/registry-service";
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  hasRoleFromEvent,
  canCallerSeeRow,
} from "../utils/auth-event";

const sqsClient = new SQSClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const FABRICATOR_QUEUE_URL = process.env.FABRICATOR_QUEUE_URL!;
// Optional — when set, we look up the app row to pull its
// sourceProjectId and forward it into agent_input.projectId. If the env var
// is unset, we skip the lookup entirely and the fabricator gate stays a no-op,
// which preserves backward compatibility for environments that haven't wired
// the apps table into this resolver yet. Read at call-time (not module-load
// time) so unit tests can toggle the env var per case.
function getAppsTable(): string | undefined {
  return process.env.APPS_TABLE;
}

// Durable per-agent fabrication status table (citadel-fabrication-jobs-${env}).
// Read at call-time (not module-load) so unit tests can toggle the env var per
// case. When unset, the status write is skipped entirely so the resolver stays
// backward-compatible in environments that haven't wired the table yet.
function getFabricationJobsTable(): string | undefined {
  return process.env.FABRICATION_JOBS_TABLE;
}

// ~7 day TTL in epoch seconds — keeps the queue table self-pruning so old
// terminal rows don't accumulate. DynamoDB TTL deletes are best-effort/async.
const FABRICATION_JOBS_TTL_SECONDS = 7 * 24 * 60 * 60;
// DynamoDB row stores at most this many chars of the task description so the
// UI has enough context without bloating the item.
const TASK_DESCRIPTION_MAX = 500;

/**
 * Derive a human-readable agent/tool name from the composed taskDetails block.
 * The resolver builds taskDetails with an "Agent Name:" / "Tool Name:" line,
 * so we prefer that; otherwise fall back to the first non-empty line.
 */
function deriveAgentName(taskDetails: string): string {
  const match = taskDetails.match(/(?:Agent|Tool) Name:\s*(.+)/);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  const firstLine = taskDetails.split("\n").find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim() : "Unknown Agent";
}

/**
 * Best-effort PENDING-row write to the durable fabrication-jobs table.
 *
 * Mirrors the UI producer path: orchestrationId is '0' (direct request, not
 * part of an intake orchestration) and agentUseId is the generated requestId.
 * A status-write failure NEVER fails the enqueue — the SQS message is already
 * accepted, so we log and swallow rather than re-raising.
 */
async function writePendingFabricationStatus(
  requestId: string,
  taskDetails: string,
  requestType: "agent-creation" | "tool-creation",
  requestedBy: string,
  orgId: string,
): Promise<void> {
  const table = getFabricationJobsTable();
  if (!table) {
    console.log(
      "FABRICATION_JOBS_TABLE unset; skipping fabrication status write",
    );
    return;
  }
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new PutCommand({
        TableName: table,
        Item: {
          orchestrationId: "0",
          agentUseId: requestId,
          // Server-derived caller org (requireOrgId, fail-closed — never
          // null) — stamped onto the row so the org-scoped
          // getFabricatorQueue GSI query can find it.
          orgId,
          status: "PENDING",
          agentName: deriveAgentName(taskDetails),
          taskDescription: taskDetails.slice(0, TASK_DESCRIPTION_MAX),
          requestType,
          requestedBy: requestedBy || "unknown",
          submittedAt: now,
          updatedAt: now,
          ttl: Math.floor(Date.now() / 1000) + FABRICATION_JOBS_TTL_SECONDS,
        },
      }),
    );
  } catch (error) {
    // Eventually-consistent: never block the enqueue on a status-write error.
    console.error(
      "Failed to write PENDING fabrication status (continuing):",
      error,
    );
  }
}

/**
 * Extract the governance sourceProjectId (branch's AgentApp.sourceProjectId
 * field) from the registry record's customDescriptorContent JSON. Used by
 * the fabricator design-assessment gate when resolving projectId from an
 * appId that has already been migrated to the registry.
 *
 * PR 6a: inlined here from the deleted `agent-record-factory.ts` module.
 * Kept as a file-private helper to avoid re-introducing a cross-module
 * dependency; the `projectIdFromRegistryRecord` surface is used by this
 * resolver only.
 */
function _projectIdFromRegistryRecord(
  record: RegistryRecord,
): string | undefined {
  if (!record.customDescriptorContent) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(record.customDescriptorContent);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.sourceProjectId === "string"
    ) {
      return parsed.sourceProjectId;
    }
  } catch {
    // Malformed JSON — treat as absent.
  }
  return undefined;
}

interface CreateAgentRequest {
  agentName: string;
  taskDescription: string;
  tools?: string[];
  integrations?: string[];
  dataStores?: string[];
  appId?: string;
}

interface CreateToolRequest {
  toolName: string;
  toolDescription: string;
  integrations?: string[];
  dataStores?: string[];
  appId?: string;
}

/**
 * Extract the AppSync caller's user id from the event identity.
 *
 * AppSync `event.identity` shape varies by auth mode:
 *  - Cognito (AppSyncIdentityCognito): has `sub` (JWT sub) and `username`.
 *  - IAM (AppSyncIdentityIAM): has `username` but no `sub`.
 *  - API key / no identity: `event.identity` is undefined.
 *
 * We check property presence rather than relying on a specific type so both
 * Cognito and IAM callers are attributed correctly. Falls back to
 * `'unknown'` when no identity is available. The value is forwarded to the
 * Python fabricator via `requested_by` on the SQS body, where it becomes
 * `createdBy` on the Registry record.
 */
function extractRequestedBy(event: FabricatorRequestResolverEvent): string {
  return ((event.identity &&
    ("sub" in event.identity ? event.identity.sub : undefined)) ||
    (event.identity &&
      ("username" in event.identity ? event.identity.username : undefined)) ||
    "unknown") as string;
}

/** AppSync event slice this resolver reads. */
interface FabricatorRequestResolverEvent {
  info: { fieldName: string };
  identity?: Record<string, unknown>;
  arguments: Record<string, unknown>;
}

/**
 * Fail-closed server-side organisation derivation (mirrors
 * `task-runner-resolver.ts`'s `requireOrgId` exactly — same primitive
 * (`extractOrgFromEvent`, JWT `custom:organization` claim with a Cognito
 * AdminGetUser fallback), same error message, same fail-closed contract).
 *
 * Replaces the prior null-tolerant `extractOrgFromEvent` call ("Null is
 * acceptable during the transition") now that the transition window is
 * over (design evidence, section C): both `requestAgentCreation` and
 * `requestToolCreation` must derive org BEFORE any SQS send / status
 * write, and never fall back to client input or a default org.
 *
 * Throws (fails closed) when no organisation resolves — never returns
 * null.
 */
async function requireOrgId(
  event: FabricatorRequestResolverEvent,
): Promise<string> {
  const orgId = await extractOrgFromEvent(event);
  if (!orgId) {
    throw new Error(
      "Access denied: no organization is provisioned for your account. Contact an administrator.",
    );
  }
  return orgId;
}

/**
 * Platform-role gate (decision 2763e85f, 2026-09-18): requestAgentCreation
 * and requestToolCreation require the caller be an admin or hold the
 * architect role, in addition to the server-derived org check above.
 * Fabrication drives Bedrock spend and creates agent/tool Registry
 * records, the same trust tier already required for comparable
 * agent-lifecycle mutations elsewhere in this codebase (see
 * agent-code-resolver.ts's `assertAgentCodeAccess`
 * `requiredWriteRole`/`REQUIRED_WRITE_ROLE` gate and
 * agent-import-resolver.ts's `requireDiscoveryRole`, both of which gate on
 * `isAdminFromEvent(event) || hasRoleFromEvent(event, "architect")`).
 *
 * Applied AFTER the org check (`requireOrgId`) in both operations, so a
 * cross-org caller never learns whether they merely lack the right role.
 * `action` names the operation in the error message so a rejected caller
 * knows which mutation was denied.
 */
function requireArchitectOrAdmin(
  event: FabricatorRequestResolverEvent,
  action: "request agent creation" | "request tool creation",
): void {
  if (isAdminFromEvent(event) || hasRoleFromEvent(event, "architect")) {
    return;
  }
  throw new Error(
    `Access denied: requires architect or admin role to ${action}`,
  );
}

export const handler = async (event: FabricatorRequestResolverEvent) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;
  const requestedBy = extractRequestedBy(event);
  // Fail closed BEFORE any SQS send / status write — an unresolved
  // organisation must never reach the queue (design evidence, section C).
  // Never derived from client input (`event.arguments.input`).
  const orgId = await requireOrgId(event);

  try {
    if (fieldName === "requestAgentCreation") {
      return await requestAgentCreation(
        event.arguments.input as CreateAgentRequest,
        requestedBy,
        orgId,
        event,
      );
    }

    if (fieldName === "requestToolCreation") {
      return await requestToolCreation(
        event.arguments.input as CreateToolRequest,
        requestedBy,
        orgId,
        event,
      );
    }

    throw new Error(`Unknown field: ${fieldName}`);
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
};

async function sendToFabricatorQueue(
  requestId: string,
  taskDetails: string,
  requestType: "agent-creation" | "tool-creation",
  requestedBy: string,
  orgId: string,
  sourceProjectId?: string,
) {
  const agent_input: Record<string, unknown> = { taskDetails };
  if (sourceProjectId) {
    // Picked up by arbiter/fabricator/index.py:928 where the
    // design_assessment_gate enforces preconditions.
    agent_input.projectId = sourceProjectId;
  }

  const fabricatorMessage = {
    orchestration_id: "0", // Direct request, not part of orchestration
    agent_use_id: requestId,
    node: "fabricator",
    agent_input,
    requested_by: requestedBy,
    // Server-derived caller org (requireOrgId, fail-closed) — never null,
    // never client input. The Python fabricator now requires this to be
    // non-empty and refuses to process otherwise.
    org_id: orgId,
  };

  console.log("Sending message to Fabricator queue:", fabricatorMessage);

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: FABRICATOR_QUEUE_URL,
        MessageBody: JSON.stringify(fabricatorMessage),
        MessageAttributes: {
          requestType: {
            DataType: "String",
            StringValue: requestType,
          },
          requestId: {
            DataType: "String",
            StringValue: requestId,
          },
        },
      }),
    );

    console.log("Message sent successfully to Fabricator queue");
  } catch (error) {
    console.error("Error sending message to Fabricator queue:", error);
    throw new Error(`Failed to send request to Fabricator: ${error}`);
  }

  // Durable PENDING status row so the queue UI reflects this request even
  // after the consumer pulls the SQS message. Best-effort — never fails the
  // enqueue.
  await writePendingFabricationStatus(
    requestId,
    taskDetails,
    requestType,
    requestedBy,
    orgId,
  );
}

/**
 * Look up the source project id for an app, if any.
 * Degraded-mode safe: returns undefined on any failure and logs a warning.
 * A missing projectId means the fabricator design-assessment gate is a no-op,
 * which is the forward-compatible default.
 *
 * Org-reconciled (finding ce470ab0): the apps row is verified against the
 * caller's server-derived org via the shared `canCallerSeeRow` helper
 * BEFORE its `sourceProjectId` is forwarded. Without this, a caller could
 * supply another tenant's `appId` and have THAT app's sourceProjectId
 * threaded into `agent_input.projectId`, letting a cross-org caller ride
 * on that project's fabricator design-assessment gate context. A cross-org
 * or org-less-row appId is treated the same as "not found" — degrades to
 * undefined rather than throwing, since a failed lookup here must never
 * block the (already separately authorized) creation request itself.
 */
async function resolveSourceProjectId(
  appId: string | undefined,
  event: FabricatorRequestResolverEvent,
): Promise<string | undefined> {
  if (!appId) return undefined;
  const appsTable = getAppsTable();
  if (!appsTable) {
    console.warn(
      "APPS_TABLE env var unset; skipping sourceProjectId lookup for app",
      appId,
    );
    return undefined;
  }
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: appsTable,
        Key: { appId },
      }),
    );
    const row = result.Item;
    if (!row) {
      console.warn("App row not found for sourceProjectId lookup:", appId);
      return undefined;
    }
    if (!(await canCallerSeeRow(row, event))) {
      console.warn(
        "App row org mismatch for sourceProjectId lookup; skipping:",
        appId,
      );
      return undefined;
    }
    return row.sourceProjectId || undefined;
  } catch (error) {
    console.warn(
      "Failed to look up sourceProjectId for app (continuing without):",
      appId,
      error,
    );
    return undefined;
  }
}

async function requestAgentCreation(
  input: CreateAgentRequest,
  requestedBy: string,
  orgId: string,
  event: FabricatorRequestResolverEvent,
) {
  requireArchitectOrAdmin(event, "request agent creation");

  const requestId = randomUUID();

  // Build the task details with all the information
  let taskDetails = `Create an agent with the following specifications:

Agent Name: ${input.agentName}

Task Description:
${input.taskDescription}`;

  if (input.tools && input.tools.length > 0) {
    taskDetails += `\n\nRequired Tools:\n${input.tools.map((t) => `- ${t}`).join("\n")}`;
  }

  if (input.integrations && input.integrations.length > 0) {
    taskDetails += `\n\nRequired Integrations:\n${input.integrations.map((i) => `- ${i}`).join("\n")}`;
  }

  if (input.dataStores && input.dataStores.length > 0) {
    taskDetails += `\n\nRequired Data Stores:\n${input.dataStores.map((d) => `- ${d}`).join("\n")}`;
  }

  const sourceProjectId = await resolveSourceProjectId(input.appId, event);
  await sendToFabricatorQueue(
    requestId,
    taskDetails,
    "agent-creation",
    requestedBy,
    orgId,
    sourceProjectId,
  );

  return {
    success: true,
    requestId,
    message: "Agent creation request sent to Fabricator successfully",
  };
}

async function requestToolCreation(
  input: CreateToolRequest,
  requestedBy: string,
  orgId: string,
  event: FabricatorRequestResolverEvent,
) {
  requireArchitectOrAdmin(event, "request tool creation");

  const requestId = randomUUID();

  // Build the task details for tool creation
  let taskDetails = `Create a tool with the following specifications:

Tool Name: ${input.toolName}

Tool Description:
${input.toolDescription}`;

  if (input.integrations && input.integrations.length > 0) {
    taskDetails += `\n\nRequired Integrations:\n${input.integrations.map((i) => `- ${i}`).join("\n")}`;
  }

  if (input.dataStores && input.dataStores.length > 0) {
    taskDetails += `\n\nRequired Data Stores:\n${input.dataStores.map((d) => `- ${d}`).join("\n")}`;
  }

  const sourceProjectId = await resolveSourceProjectId(input.appId, event);
  await sendToFabricatorQueue(
    requestId,
    taskDetails,
    "tool-creation",
    requestedBy,
    orgId,
    sourceProjectId,
  );

  return {
    success: true,
    requestId,
    message: "Tool creation request sent to Fabricator successfully",
  };
}
