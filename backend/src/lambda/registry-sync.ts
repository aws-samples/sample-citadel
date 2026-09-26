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
import {
  RegistryService,
  TypeMismatchError,
} from "../services/registry-service";
import type { RegistryRecord } from "../services/registry-service";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;
const TOOLS_CONFIG_TABLE = process.env.TOOLS_CONFIG_TABLE!;
const DLQ_URL = process.env.DLQ_URL!;
const REGISTRY_ID = process.env.REGISTRY_ID!;
const REGION = process.env.AWS_REGION || "us-east-1";

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

/** Lazy RegistryService singleton — same pattern as other lambdas (e.g. agent-code-resolver.ts). */
let _registryService: RegistryService | undefined;
function getRegistryService(): RegistryService {
  if (!_registryService) {
    _registryService = new RegistryService({
      registryId: REGISTRY_ID,
      region: REGION,
    });
  }
  return _registryService;
}

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

/**
 * GA record-lifecycle event detail. GA's "Registry Record State changed to
 * <State>" detail-types carry only `registryRecordId` + `registryId` — no
 * inline resource payload, no resourceType/eventType. The handler hydrates
 * the full record via RegistryService.getResource before it can route it
 * through the existing cache-write path.
 */
export interface GaRegistryEventDetail {
  registryRecordId: string;
  registryId: string;
}

export interface RegistryEvent {
  source: string;
  "detail-type": string;
  detail: RegistryEventDetail | GaRegistryEventDetail;
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

// GA namespace migration: event source moved from 'aws.bedrock-agentcore' to
// 'aws.agent-registry'. Per the agent-registry GA FAQ, record-lifecycle
// events are emitted under several detail-type strings (creation, update,
// status transitions incl. "Pending Approval", plus GA additions) rather
// than the single legacy "AgentCore Registry Resource Change" string. This
// handler only processes RECORD events (it needs resourceId/resourceType,
// which registry-lifecycle events like "Registry Ready" do not carry) — the
// CDK rule (registry-stack.ts RegistrySyncRule) already filters on
// source + detail.registryId only and forwards every detail-type, so this
// set is the handler-side allowlist of the record detail types it knows how
// to route; anything else (e.g. a future registry-lifecycle detail-type)
// is rejected here as unexpected rather than silently mis-processed.
const VALID_RECORD_DETAIL_TYPES: ReadonlySet<unknown> = new Set([
  "Agent Registry Record Created",
  "Agent Registry Record Updated",
  "Agent Registry Record Deleted",
  "Agent Registry Record Status Changed",
  "Agent Registry Record Pending Approval",
  "Agent Registry Record Approved",
  "Agent Registry Record Rejected",
]);

// GA additions (observed live, diag 2026-09-26): GA emits record-lifecycle
// events under "Registry Record State changed to <State>" rather than the
// legacy allowlist above. Exact strings observed: "Registry Record State
// changed to Draft" and "... to Approved". Kept as its own allowlist
// (rather than merged into VALID_RECORD_DETAIL_TYPES) because these events
// carry a materially different detail shape (GaRegistryEventDetail) that
// requires a record fetch, not an inline payload.
const VALID_GA_RECORD_DETAIL_TYPES: ReadonlySet<unknown> = new Set([
  "Registry Record State changed to Draft",
  "Registry Record State changed to Approved",
]);

/** True if `detailType` is one of the GA "State changed to <X>" strings. */
export function isGaRecordDetailType(detailType: unknown): boolean {
  return VALID_GA_RECORD_DETAIL_TYPES.has(detailType);
}

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

  if (event.source !== "aws.agent-registry") {
    return `Unexpected event source: ${event.source}`;
  }

  const detailType = event["detail-type"];
  const isGa = isGaRecordDetailType(detailType);
  if (!isGa && !VALID_RECORD_DETAIL_TYPES.has(detailType)) {
    return `Unexpected detail-type: ${detailType}`;
  }

  const detail = event.detail;
  if (!detail) {
    return "Event detail is missing";
  }

  if (isGa) {
    const gaDetail = detail as UnvalidatedEventDetail;
    if (
      !gaDetail.registryRecordId ||
      typeof gaDetail.registryRecordId !== "string"
    ) {
      return "Event detail missing required field: registryRecordId";
    }
    return null;
  }

  const legacyDetail = detail as UnvalidatedEventDetail;
  if (!legacyDetail.resourceId || typeof legacyDetail.resourceId !== "string") {
    return "Event detail missing required field: resourceId";
  }

  if (!VALID_RESOURCE_TYPES.has(legacyDetail.resourceType)) {
    return `Invalid resourceType: ${legacyDetail.resourceType}`;
  }

  if (!VALID_EVENT_TYPES.has(legacyDetail.eventType)) {
    return `Invalid eventType: ${legacyDetail.eventType}`;
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
  state: "APPROVED" as string,
  appId: undefined as string | undefined,
  manifest: undefined as Record<string, unknown> | undefined,
  // Deliberately `undefined`, NOT `''` — the cache-record builder below must
  // distinguish "no orgId in the manifest at all" (undefined, e.g. a
  // malformed/legacy record) from "explicitly system-shared" (''), mirroring
  // RegistryService.AGENT_METADATA_DEFAULTS. Collapsing the two would let a
  // record that merely omits orgId fail OPEN as globally visible.
  orgId: undefined as string | undefined,
  config: undefined as Record<string, unknown> | undefined,
  createdBy: undefined as string | undefined,
  sourceProjectId: undefined as string | undefined,
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

/**
 * Coerces a deserialized meta.config value into a plain object, or
 * `undefined` if it is absent / not representable as one. Accepts either an
 * already-parsed object (the common case, since customDescriptorContent as a
 * whole is JSON-parsed upstream) or a JSON-string-encoded object (in case the
 * registry nests config as a serialized string within the metadata). Never
 * falls back to prose — logs a WARN naming the record instead.
 */
export function coerceAgentConfig(
  recordId: string,
  rawConfig: unknown,
): Record<string, unknown> | undefined {
  if (rawConfig == null) {
    console.warn(
      `Agent record "${recordId}": meta.config is missing, leaving config undefined`,
    );
    return undefined;
  }

  let candidate: unknown = rawConfig;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      console.warn(
        `Agent record "${recordId}": meta.config is a non-JSON string, leaving config undefined`,
      );
      return undefined;
    }
  }

  if (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
  ) {
    return candidate as Record<string, unknown>;
  }

  console.warn(
    `Agent record "${recordId}": meta.config is not a JSON object, leaving config undefined`,
  );
  return undefined;
}

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
  config: Record<string, unknown> | undefined;
  description: string;
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
  createdBy: string | undefined;
  sourceProjectId: string | undefined;
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
    config: coerceAgentConfig(resourceId, meta.config),
    description: resource.description ?? "",
    state: toInternalState(meta.state),
    categories: meta.categories,
    icon: meta.icon,
    appId: meta.appId,
    manifest: meta.manifest,
    name: typeof resource.name === "string" ? resource.name : "",
    orgId: meta.orgId,
    createdBy: meta.createdBy,
    sourceProjectId: meta.sourceProjectId,
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

/**
 * Maps a GA record `status` (e.g. "DRAFT", "APPROVED", or the lowercase
 * lifecycle values observed in real records, e.g. "active") to the internal
 * application state. Unlike `toInternalState` (used by the legacy
 * resourceType/eventType path, which always resolves to a concrete state),
 * this returns `undefined` for an unrecognized value so the caller can
 * PRESERVE whatever state already exists in DDB instead of forcing
 * "inactive" — logs a WARN either way.
 */
export function toInternalStateFromGaStatus(
  status: string | undefined,
): string | undefined {
  switch (status) {
    case "APPROVED":
    case "active":
      return "active";
    case "DEPRECATED":
    case "inactive":
      return "inactive";
    case "DRAFT":
    case "maintenance":
      return "maintenance";
    case "PENDING_APPROVAL":
    case "pending":
      return "pending";
    default:
      console.warn(
        `Unknown GA registry status "${status}", preserving existing state`,
      );
      return undefined;
  }
}

/**
 * Builds the set of fields the GA upsert path is allowed to write, derived
 * strictly from the hydrated record. Fields with no source in the record
 * (config, createdBy, sourceProjectId, appId, manifest when absent, etc.)
 * are omitted entirely so the merge UpdateCommand never SETs — and thus
 * never overwrites or removes — an attribute the record doesn't carry.
 */
function buildGaMergeFields(
  resourceType: ResourceType,
  record: RegistryRecord,
): Record<string, unknown> {
  const now = new Date().toISOString();
  if (resourceType === "tool") {
    const meta = deserializeCustomMetadata(
      record.customDescriptorContent ?? null,
      TOOL_METADATA_DEFAULTS,
    );
    const fields: Record<string, unknown> = {
      config: record.description ?? "",
      categories: meta.categories,
      icon: meta.icon,
      updatedAt: now,
    };
    if (meta.appId !== undefined) fields.appId = meta.appId;
    if (meta.integrationBindings !== undefined)
      fields.integrationBindings = meta.integrationBindings;
    if (meta.dataStoreBindings !== undefined)
      fields.dataStoreBindings = meta.dataStoreBindings;
    const mappedState = toInternalStateFromGaStatus(record.status);
    if (mappedState !== undefined) fields.state = mappedState;
    return fields;
  }

  const meta = deserializeCustomMetadata(
    record.customDescriptorContent ?? null,
    AGENT_METADATA_DEFAULTS,
  );

  const fields: Record<string, unknown> = {
    description: record.description ?? "",
    categories: meta.categories,
    icon: meta.icon,
    updatedAt: now,
  };
  if (typeof record.name === "string") fields.name = record.name;
  if (meta.appId !== undefined) fields.appId = meta.appId;
  if (meta.manifest !== undefined) fields.manifest = meta.manifest;
  if (meta.orgId !== undefined) fields.orgId = meta.orgId;
  // Deliberately NOT setting config/createdBy/sourceProjectId here — the GA
  // record carries no reliable source for them (see diag: `config` and
  // `sourceProjectId` are absent from GA entirely; GA's `createdBy` is a
  // numeric AWS account ID, a different form than DDB's value). Existing
  // DDB values for these attributes must survive untouched.
  const mappedState = toInternalStateFromGaStatus(record.status);
  if (mappedState !== undefined) fields.state = mappedState;
  return fields;
}

/**
 * GA upsert — MERGE semantics via UpdateCommand. Only SETs fields derived
 * from the hydrated record; never REMOVEs or overwrites attributes with no
 * source in the record (config, createdBy, sourceProjectId when absent),
 * and preserves the existing DDB state on an unrecognized descriptor state
 * instead of forcing "inactive".
 */
export async function handleGaUpsert(
  tableName: string,
  resourceType: ResourceType,
  resourceId: string,
  record: RegistryRecord,
): Promise<void> {
  const fields = buildGaMergeFields(resourceType, record);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setClauses: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    setClauses.push(`#${key} = :${key}`);
  }

  const params: UpdateCommandInput = {
    TableName: tableName,
    Key: getKeyForResource(resourceType, resourceId),
    UpdateExpression: `SET ${setClauses.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };

  await docClient.send(new UpdateCommand(params));
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

// ---------------------------------------------------------------------------
// GA record hydration
// ---------------------------------------------------------------------------

/**
 * Maps a hydrated RegistryRecord (from RegistryService.getResource) onto the
 * RegistryResourcePayload shape the existing cache-record builders expect,
 * so the GA path reuses buildAgentCacheRecord/buildToolCacheRecord unchanged.
 */
export function recordToResourcePayload(
  record: RegistryRecord,
): RegistryResourcePayload {
  return {
    name: record.name,
    description: record.description,
    customDescriptorContent: record.customDescriptorContent ?? null,
    createdAt: record.createdAt?.toISOString(),
    updatedAt: record.updatedAt?.toISOString(),
  };
}

/**
 * Resolves the resourceType for a GA record by attempting an agent fetch
 * first, falling back to tool on TypeMismatchError. Returns null if the
 * record does not exist (deleted before the event was processed, or a
 * transient GA read-after-write gap).
 */
export async function resolveGaRecord(
  recordId: string,
): Promise<{ resourceType: ResourceType; record: RegistryRecord } | null> {
  const registry = getRegistryService();
  try {
    const record = await registry.getResource("agent", recordId);
    if (record) {
      return { resourceType: "agent", record };
    }
  } catch (err) {
    if (!(err instanceof TypeMismatchError)) {
      throw err;
    }
  }

  const toolRecord = await registry.getResource("tool", recordId);
  if (!toolRecord) {
    return null;
  }
  return { resourceType: "tool", record: toolRecord };
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

  if (isGaRecordDetailType(event["detail-type"])) {
    await handleGaEvent(event);
    return;
  }

  const { resourceId, resourceType, eventType, resource, newStatus } =
    event.detail as RegistryEventDetail;
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

/**
 * Handles GA "Registry Record State changed to <State>" events: hydrates
 * the record via RegistryService, then routes it through the existing
 * create-or-update cache path (a Draft/Approved state change always maps
 * to an upsert — there is no separate DELETED signal in this GA detail-type
 * family, and STATUS_CHANGED-only updates are naturally idempotent via the
 * same conditional PutCommand used for CREATED/UPDATED).
 */
async function handleGaEvent(event: RegistryEvent): Promise<void> {
  const { registryRecordId } = event.detail as GaRegistryEventDetail;

  let resolved: { resourceType: ResourceType; record: RegistryRecord } | null;
  try {
    resolved = await resolveGaRecord(registryRecordId);
  } catch (err) {
    console.error(
      `Failed to hydrate GA registry record "${registryRecordId}":`,
      err,
    );
    await sendToDlq(
      event,
      `Registry hydration failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitSyncFailureMetric();
    throw err;
  }

  if (!resolved) {
    console.warn(
      `GA registry record "${registryRecordId}" not found, sending to DLQ`,
    );
    await sendToDlq(event, `Registry record not found: ${registryRecordId}`);
    return;
  }

  const { resourceType, record } = resolved;
  const tableName = getTableForResourceType(resourceType);

  try {
    await handleGaUpsert(tableName, resourceType, registryRecordId, record);
    console.log(
      `Cache merge-upsert for ${resourceType} "${registryRecordId}" in ${tableName} (GA event)`,
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      console.log(
        `Conditional check failed for ${resourceType} "${registryRecordId}" — record already current, skipping`,
      );
      return;
    }

    console.error(
      `DynamoDB write failure for ${resourceType} "${registryRecordId}":`,
      err,
    );
    await sendToDlq(
      event,
      `DynamoDB write failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitSyncFailureMetric();
    throw err;
  }
}
