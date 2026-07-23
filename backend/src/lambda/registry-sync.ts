/**
 * EventBridge Sync Lambda — Registry → DynamoDB Cache
 *
 * Triggered by EventBridge when AgentCore Registry records change.
 * Routes events to the appropriate DynamoDB cache table (agents or tools)
 * based on the resourceType in the event detail.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  PutCommandInput,
  DeleteCommandInput,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;
const TOOLS_CONFIG_TABLE = process.env.TOOLS_CONFIG_TABLE!;
const DLQ_URL = process.env.DLQ_URL!;

// ---------------------------------------------------------------------------
// DynamoDB client
// ---------------------------------------------------------------------------

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// ---------------------------------------------------------------------------
// SQS + CloudWatch clients
// ---------------------------------------------------------------------------

const sqsClient = new SQSClient({});
const cwClient = new CloudWatchClient({});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceType = "agent" | "tool";
export type EventType = "CREATED" | "UPDATED" | "DELETED" | "STATUS_CHANGED";

/**
 * Registry resource payload carried in EventBridge event details. Known fields
 * are typed; everything else is passed through untyped (index signature).
 */
export interface RegistryResourcePayload {
  [key: string]: unknown;
  name?: string;
  description?: string;
  customDescriptorContent?: string | null;
  createdAt?: string | number;
  updatedAt?: string | number;
}

export interface RegistryEventDetail {
  resourceId: string;
  resourceType: ResourceType;
  eventType: EventType;
  resource?: RegistryResourcePayload;
  previousStatus?: string;
  newStatus?: string;
}

export interface RegistryEvent {
  source: string;
  "detail-type": string;
  detail: RegistryEventDetail;
}

/**
 * Structural view of a not-yet-validated event as seen by validateEvent.
 * All fields are unknown until validation succeeds.
 */
export interface UnvalidatedEventDetail {
  [key: string]: unknown;
}

export interface UnvalidatedEvent {
  [key: string]: unknown;
  detail?: UnvalidatedEventDetail | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_RESOURCE_TYPES: ReadonlySet<unknown> = new Set(["agent", "tool"]);
const VALID_EVENT_TYPES: ReadonlySet<unknown> = new Set([
  "CREATED",
  "UPDATED",
  "DELETED",
  "STATUS_CHANGED",
]);

/**
 * Validates the incoming EventBridge event structure.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateEvent(
  event: RegistryEvent | UnvalidatedEvent | null | undefined,
): string | null {
  if (!event) {
    return "Event is null or undefined";
  }

  if (event.source !== "aws.bedrock-agentcore") {
    return `Unexpected event source: ${event.source}`;
  }

  if (event["detail-type"] !== "AgentCore Registry Resource Change") {
    return `Unexpected detail-type: ${event["detail-type"]}`;
  }

  const detail = event.detail;
  if (!detail) {
    return "Event detail is missing";
  }

  if (!detail.resourceId || typeof detail.resourceId !== "string") {
    return "Event detail missing required field: resourceId";
  }

  if (!VALID_RESOURCE_TYPES.has(detail.resourceType)) {
    return `Invalid resourceType: ${detail.resourceType}`;
  }

  if (!VALID_EVENT_TYPES.has(detail.eventType)) {
    return `Invalid eventType: ${detail.eventType}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Returns the DynamoDB table name for the given resource type.
 */
export function getTableForResourceType(resourceType: ResourceType): string {
  switch (resourceType) {
    case "agent":
      return AGENT_CONFIG_TABLE;
    case "tool":
      return TOOLS_CONFIG_TABLE;
    default:
      throw new Error(`Unknown resourceType: ${resourceType}`);
  }
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Maps a Registry record status to the internal application state.
 * Mirrors RegistryService.toInternalState.
 */
export function toInternalState(registryStatus: string): string {
  switch (registryStatus) {
    case "APPROVED":
      return "active";
    case "DEPRECATED":
      return "inactive";
    case "DRAFT":
      return "maintenance";
    case "PENDING_APPROVAL":
      return "pending";
    default:
      console.warn(
        `Unknown registry status "${registryStatus}", mapping to "inactive"`,
      );
      return "inactive";
  }
}

// ---------------------------------------------------------------------------
// Custom metadata deserialization
// ---------------------------------------------------------------------------

const AGENT_METADATA_DEFAULTS = {
  categories: [] as string[],
  icon: "",
  state: "active" as string,
  appId: undefined as string | undefined,
  manifest: undefined as Record<string, unknown> | undefined,
  // Deliberately `undefined`, NOT `''` — the cache-record builder below must
  // distinguish "no orgId in the manifest at all" (undefined, e.g. a
  // malformed/legacy record) from "explicitly system-shared" (''), mirroring
  // RegistryService.AGENT_METADATA_DEFAULTS. Collapsing the two would let a
  // record that merely omits orgId fail OPEN as globally visible.
  orgId: undefined as string | undefined,
};

const TOOL_METADATA_DEFAULTS = {
  categories: [] as string[],
  icon: "",
  state: "active" as string,
  integrationBindings: undefined as unknown[] | undefined,
  dataStoreBindings: undefined as unknown[] | undefined,
  appId: undefined as string | undefined,
};

/**
 * Deserializes custom metadata JSON, returning defaults on failure.
 * Mirrors RegistryService.deserializeCustomMetadata.
 */
export function deserializeCustomMetadata<T extends Record<string, unknown>>(
  json: string | null | undefined,
  defaults: T,
): T {
  if (json == null || json === "") {
    return defaults;
  }
  try {
    const parsed = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      console.warn(
        "Custom metadata JSON is not a plain object, returning defaults",
      );
      return defaults;
    }
    return { ...defaults, ...parsed };
  } catch {
    console.warn("Failed to parse custom metadata JSON, returning defaults");
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// DynamoDB key helpers
// ---------------------------------------------------------------------------

function getKeyForResource(
  resourceType: ResourceType,
  resourceId: string,
): Record<string, string> {
  return resourceType === "agent"
    ? { agentId: resourceId }
    : { toolId: resourceId };
}

// ---------------------------------------------------------------------------
// Cache record builders
// ---------------------------------------------------------------------------

/**
 * DynamoDB item shape for an agent cache record.
 */
export type AgentCacheRecord = {
  agentId: string;
  config: string;
  state: string;
  categories: string[];
  icon: string;
  appId: string | undefined;
  manifest: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
  /**
   * Registry record `name` (from the event's `resource.name`), denormalized
   * here so registry-agent-record-resolver's agentBindings[].name enrichment
   * can resolve names via a single BatchGetItem against this table instead
   * of one Registry GetRegistryRecord per binding (the N+1 fix).
   */
  name: string;
  /**
   * The agent's own manifest orgId, denormalized for the same reason. Kept
   * as `undefined` (NOT coerced to `''`) when the source manifest omits
   * orgId entirely — the resolver's tenant check must treat "no orgId"
   * as NOT system-shared, only an explicit `''` counts as shared.
   */
  orgId: string | undefined;
};

/**
 * DynamoDB item shape for a tool cache record.
 */
export type ToolCacheRecord = {
  toolId: string;
  config: string;
  state: string;
  categories: string[];
  icon: string;
  integrationBindings: unknown[] | undefined;
  dataStoreBindings: unknown[] | undefined;
  appId: string | undefined;
  createdAt: string;
  updatedAt: string;
};

/**
 * Builds a DynamoDB item for an agent cache record from the Registry event
 * resource payload.
 */
export function buildAgentCacheRecord(
  resourceId: string,
  resource: RegistryResourcePayload,
): AgentCacheRecord {
  const meta = deserializeCustomMetadata(
    resource.customDescriptorContent ?? null,
    AGENT_METADATA_DEFAULTS,
  );

  return {
    agentId: resourceId,
    config: resource.description ?? "",
    state: meta.state,
    categories: meta.categories,
    icon: meta.icon,
    appId: meta.appId,
    manifest: meta.manifest,
    name: typeof resource.name === "string" ? resource.name : "",
    orgId: meta.orgId,
    createdAt: resource.createdAt
      ? new Date(resource.createdAt).toISOString()
      : new Date().toISOString(),
    updatedAt: resource.updatedAt
      ? new Date(resource.updatedAt).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Builds a DynamoDB item for a tool cache record from the Registry event
 * resource payload.
 */
export function buildToolCacheRecord(
  resourceId: string,
  resource: RegistryResourcePayload,
): ToolCacheRecord {
  const meta = deserializeCustomMetadata(
    resource.customDescriptorContent ?? null,
    TOOL_METADATA_DEFAULTS,
  );

  return {
    toolId: resourceId,
    config: resource.description ?? "",
    state: meta.state,
    categories: meta.categories,
    icon: meta.icon,
    integrationBindings: meta.integrationBindings,
    dataStoreBindings: meta.dataStoreBindings,
    appId: meta.appId,
    createdAt: resource.createdAt
      ? new Date(resource.createdAt).toISOString()
      : new Date().toISOString(),
    updatedAt: resource.updatedAt
      ? new Date(resource.updatedAt).toISOString()
      : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cache operations
// ---------------------------------------------------------------------------

/**
 * Handles CREATED and UPDATED events — full PutItem with conditional write
 * for idempotency. Only writes if the record doesn't exist or the incoming
 * updatedAt is newer.
 */
export async function handleCreateOrUpdate(
  tableName: string,
  resourceType: ResourceType,
  resourceId: string,
  resource: RegistryResourcePayload,
): Promise<void> {
  const item =
    resourceType === "agent"
      ? buildAgentCacheRecord(resourceId, resource)
      : buildToolCacheRecord(resourceId, resource);

  const keyAttr = resourceType === "agent" ? "agentId" : "toolId";

  const params: PutCommandInput = {
    TableName: tableName,
    Item: item,
    // Idempotency: only write if record doesn't exist or incoming updatedAt is newer
    ConditionExpression: `attribute_not_exists(#key) OR #updatedAt < :newUpdatedAt`,
    ExpressionAttributeNames: {
      "#key": keyAttr,
      "#updatedAt": "updatedAt",
    },
    ExpressionAttributeValues: {
      ":newUpdatedAt": item.updatedAt,
    },
  };

  await docClient.send(new PutCommand(params));
}

/**
 * Handles DELETED events — DeleteItem by resource ID.
 */
export async function handleDelete(
  tableName: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<void> {
  const params: DeleteCommandInput = {
    TableName: tableName,
    Key: getKeyForResource(resourceType, resourceId),
  };

  await docClient.send(new DeleteCommand(params));
}

/**
 * Handles STATUS_CHANGED events — updates only the state field using the
 * status mapping. Uses a conditional write for idempotency.
 */
export async function handleStatusChanged(
  tableName: string,
  resourceType: ResourceType,
  resourceId: string,
  newStatus: string,
): Promise<void> {
  const mappedState = toInternalState(newStatus);
  const keyAttr = resourceType === "agent" ? "agentId" : "toolId";
  const now = new Date().toISOString();

  const params: UpdateCommandInput = {
    TableName: tableName,
    Key: getKeyForResource(resourceType, resourceId),
    UpdateExpression: "SET #state = :newState, #updatedAt = :now",
    // Idempotency: only update if the state is actually different
    ConditionExpression: `attribute_exists(#key) AND (attribute_not_exists(#state) OR #state <> :newState)`,
    ExpressionAttributeNames: {
      "#key": keyAttr,
      "#state": "state",
      "#updatedAt": "updatedAt",
    },
    ExpressionAttributeValues: {
      ":newState": mappedState,
      ":now": now,
    },
  };

  await docClient.send(new UpdateCommand(params));
}

// ---------------------------------------------------------------------------
// DLQ + CloudWatch helpers
// ---------------------------------------------------------------------------

/**
 * Sends a failed event to the dead-letter queue for later inspection.
 */
export async function sendToDlq(event: unknown, reason: string): Promise<void> {
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: DLQ_URL,
        MessageBody: JSON.stringify({
          event,
          reason,
          timestamp: new Date().toISOString(),
        }),
      }),
    );
    console.log(`Event sent to DLQ: ${reason}`);
  } catch (dlqErr) {
    // Best-effort — log but don't mask the original error
    console.error("Failed to send event to DLQ:", dlqErr);
  }
}

/**
 * Emits a CloudWatch `SyncFailure` metric so alarms can fire.
 */
export async function emitSyncFailureMetric(): Promise<void> {
  try {
    await cwClient.send(
      new PutMetricDataCommand({
        Namespace: "RegistrySync",
        MetricData: [
          {
            MetricName: "SyncFailure",
            Value: 1,
            Unit: "Count",
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (metricErr) {
    // Best-effort — log but don't mask the original error
    console.error("Failed to emit SyncFailure metric:", metricErr);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: RegistryEvent): Promise<void> => {
  console.log("Registry sync event received:", JSON.stringify(event, null, 2));

  // Validate event structure — malformed events go to DLQ, no retry
  const validationError = validateEvent(event);
  if (validationError) {
    console.error(`Invalid event: ${validationError}`);
    await sendToDlq(event, `Malformed event: ${validationError}`);
    throw new Error(`Malformed registry sync event: ${validationError}`);
  }

  const { resourceId, resourceType, eventType, resource, newStatus } =
    event.detail;
  const tableName = getTableForResourceType(resourceType);

  console.log(
    `Processing ${eventType} event for ${resourceType} "${resourceId}" → table "${tableName}"`,
  );

  try {
    switch (eventType) {
      case "CREATED":
      case "UPDATED": {
        if (!resource) {
          console.warn(
            `No resource payload in ${eventType} event for "${resourceId}", skipping`,
          );
          return;
        }
        await handleCreateOrUpdate(
          tableName,
          resourceType,
          resourceId,
          resource,
        );
        console.log(
          `Cache ${eventType.toLowerCase()} for ${resourceType} "${resourceId}" in ${tableName}`,
        );
        break;
      }
      case "DELETED": {
        await handleDelete(tableName, resourceType, resourceId);
        console.log(
          `Cache deleted for ${resourceType} "${resourceId}" from ${tableName}`,
        );
        break;
      }
      case "STATUS_CHANGED": {
        if (!newStatus) {
          console.warn(
            `No newStatus in STATUS_CHANGED event for "${resourceId}", skipping`,
          );
          return;
        }
        await handleStatusChanged(
          tableName,
          resourceType,
          resourceId,
          newStatus,
        );
        console.log(
          `Cache status updated for ${resourceType} "${resourceId}" to "${newStatus}"`,
        );
        break;
      }
      default:
        console.warn(`Unhandled eventType: ${eventType}`);
    }
  } catch (err: unknown) {
    // Swallow ConditionalCheckFailedException — idempotency, record already current
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      console.log(
        `Conditional check failed for ${resourceType} "${resourceId}" — record already current, skipping`,
      );
      return;
    }

    // DynamoDB write failure — route to DLQ and emit metric, then re-throw
    console.error(
      `DynamoDB write failure for ${resourceType} "${resourceId}":`,
      err,
    );
    await sendToDlq(
      event,
      `DynamoDB write failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitSyncFailureMetric();
    throw err;
  }
};
