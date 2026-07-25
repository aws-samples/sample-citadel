/**
 * Cost Ledger Writer — Lambda
 *
 * Consumes 3 EventBridge event shapes (task.completion,
 * agent_intake.usage/intake.usage.captured, citadel.workflows/
 * workflow.node.completed), applies the dedupe rule, resolves per-row
 * pricing from the model-catalog table, computes cost, and writes
 * idempotent rows to the cost-ledger table.
 *
 * DEDUPE RULE (binding, per architect design):
 *   - `workflow.node.completed` is authoritative for ALL workflow-node model
 *     calls.
 *   - `task.completion` is authoritative ONLY for standalone (non-workflow)
 *     worker tasks. If a task.completion event carries workflow correlation
 *     (`workflowExecutionId`/`nodeId`), it is DROPPED — the node.completed
 *     event owns those calls.
 *   - `intake.usage.captured` is unique (intake runtime) — always authoritative.
 *
 * IDEMPOTENCY: `PutCommand` with `ConditionExpression: attribute_not_exists(PK)`.
 * `ConditionalCheckFailedException` is swallowed (logged at debug) — every
 * other error is logged and rethrown so EventBridge retry/DLQ semantics apply.
 *
 * PRICING / COST (pass 2): for each usage record, the modelId is resolved to
 * a catalog `modelKey` (same slug logic as `model-catalog-sync.ts`) and a
 * `GetItem` reads pricing from the model-catalog table. `cost-compute.ts`'s
 * pure `computeTokenCost` turns tokens + pricing into `tokenCost`/`costMicros`.
 *
 * UNPRICED POLICY (never fabricate a price): if the catalog row is missing,
 * OR present but lacking `inputPer1kTokens`/`outputPer1kTokens`/`currency`,
 * OR the catalog read itself fails (transient DynamoDB error), the row is
 * STILL WRITTEN with `priced:false`, `tokenCost:null`, `costMicros:null`,
 * an `unpricedReason`, and a `console.warn`/`console.error` — a catalog-read
 * failure must never drop a ledger row.
 *
 * DECOMPOSITION: `tokenCost` is populated (or null when unpriced);
 * `compute`/`idle`/`memory` are always null this pass (AgentCore split is
 * deferred to the reconciler story), with `runtimeComponentsPending:true`.
 * Every row carries `estimate:true`.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EventBridgeEvent } from "aws-lambda";
import { modelKeyFromId } from "./model-catalog-sync";
import {
  computeTokenCost,
  type PricingInfo,
  type UnpricedReason,
} from "./utils/cost-compute";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;
const MODEL_CATALOG_TABLE = process.env.MODEL_CATALOG_TABLE!;

/** Thrown internally to make the conditional-check-failed branch explicit and testable. */
export class ConditionalCheckFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionalCheckFailedError";
  }
}

/**
 * Usage record schema — TS mirror of `arbiter/common/usage.py`'s
 * `UsageRecord` dict. Numeric fields are defensively coerced; never trust
 * an event payload blindly (it crossed a process/event boundary).
 */
export interface UsageRecord {
  modelId?: string;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  latencyMs?: unknown;
  callIndex?: unknown;
  capturedAt?: string;
  source?: "worker" | "supervisor" | "intake" | "workflow_node";
}

interface TaskCompletionDetail {
  taskId?: string;
  orgId?: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  workflowExecutionId?: string;
  nodeId?: string;
  usage?: UsageRecord[];
}

interface IntakeUsageDetail {
  orgId?: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  usage?: UsageRecord | UsageRecord[];
}

interface WorkflowNodeCompletedDetail {
  orgId?: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  workflowExecutionId?: string;
  nodeId?: string;
  usage?: UsageRecord[];
}

export type IncomingDetail =
  | TaskCompletionDetail
  | IntakeUsageDetail
  | WorkflowNodeCompletedDetail;

/** Non-negative-int coercion mirroring `usage.py`'s `_coerce_non_negative_int`. Never throws. */
function coerceNonNegativeInt(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

/** Sanitize an arbitrary value into an array of usage-record-shaped dicts. */
function parseUsageArray(raw: unknown): UsageRecord[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (entry): entry is UsageRecord =>
        typeof entry === "object" && entry !== null,
    );
  }
  if (typeof raw === "object" && raw !== null) {
    return [raw as UsageRecord];
  }
  return [];
}

interface Dimensions {
  orgId?: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  workflowExecutionId?: string;
  nodeId?: string;
}

interface Decomposition {
  currency: string | null;
  tokenCost: number | null;
  compute: null;
  idle: null;
  memory: null;
  runtimeComponentsPending: true;
}

interface LedgerRow {
  PK: string;
  SK: string;
  ledgerId: string;
  eventId: string;
  callIndex: number;
  orgId: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  workflowExecutionId?: string;
  nodeId?: string;
  modelId: string;
  modelKey: string;
  source: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  capturedAt: string;
  ingestedAt: string;
  // Pricing fields (pass 2): populated when the catalog row resolves to a
  // usable price; null + unpricedReason when it does not.
  currency: string | null;
  tokenCost: number | null;
  costMicros: number | null;
  priced: boolean;
  unpricedReason?: UnpricedReason;
  decomposition: Decomposition;
  estimate: true;
  schemaVersion: 1;
  // Sparse GSI keys — present only when the dimension is present.
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
  GSI3PK?: string;
  GSI3SK?: string;
  GSI4PK?: string;
  GSI4SK?: string;
}

/** Shape of the catalog row fields this writer reads — a narrow, defensive view. */
interface CatalogPricingRow {
  inputPer1kTokens?: unknown;
  outputPer1kTokens?: unknown;
  currency?: unknown;
}

/**
 * Resolves pricing for a raw modelId via the model-catalog table.
 *
 * NEVER throws and NEVER drops the caller's row: a missing row, a row
 * without usable pricing, or a transient DynamoDB read failure all resolve
 * to `{pricing: undefined, reason}` — the caller (buildLedgerRow) passes
 * that straight into `computeTokenCost`, which produces the unpriced shape.
 * A catalog-read failure is logged at `error`; a missing/unpriced row is
 * logged at `warn` (per design: "unpriced rows still written + warn log").
 */
async function resolvePricing(
  modelId: string,
): Promise<{
  pricing: PricingInfo | undefined;
  reason: UnpricedReason;
  modelKey: string;
}> {
  const modelKey = modelId ? modelKeyFromId(modelId) : "";

  let item: CatalogPricingRow | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: MODEL_CATALOG_TABLE,
        Key: { modelKey },
      }),
    );
    item = result.Item as CatalogPricingRow | undefined;
  } catch (err: unknown) {
    console.error(
      "cost-ledger-writer: model-catalog read failed; writing row unpriced (never dropped)",
      { modelKey, error: err instanceof Error ? err.message : String(err) },
    );
    return { pricing: undefined, reason: "pricing_absent", modelKey };
  }

  if (!item) {
    console.warn(
      `cost-ledger-writer: modelKey not found in catalog, writing unpriced row: ${modelKey}`,
    );
    return { pricing: undefined, reason: "model_not_in_catalog", modelKey };
  }

  const usable =
    typeof item.inputPer1kTokens === "number" &&
    typeof item.outputPer1kTokens === "number" &&
    typeof item.currency === "string" &&
    item.currency.length > 0;

  if (!usable) {
    console.warn(
      `cost-ledger-writer: catalog row for ${modelKey} has no usable pricing, writing unpriced row`,
    );
    return { pricing: undefined, reason: "pricing_absent", modelKey };
  }

  return {
    pricing: {
      inputPer1kTokens: item.inputPer1kTokens as number,
      outputPer1kTokens: item.outputPer1kTokens as number,
      currency: item.currency as string,
    },
    reason: "pricing_absent", // unused when pricing is defined
    modelKey,
  };
}

/** Builds one idempotent ledger row from a usage record + shared dimensions. */
async function buildLedgerRow(
  eventId: string,
  callIndex: number,
  usage: UsageRecord,
  dims: Dimensions,
  source: string,
  ingestedAt: string,
): Promise<LedgerRow> {
  const capturedAt = usage.capturedAt || ingestedAt;
  const orgId = dims.orgId && dims.orgId.length > 0 ? dims.orgId : "UNKNOWN";
  const ledgerId = `${eventId}:${callIndex}`;
  const inputTokens = coerceNonNegativeInt(usage.inputTokens);
  const outputTokens = coerceNonNegativeInt(usage.outputTokens);
  const totalTokens =
    usage.totalTokens !== undefined
      ? coerceNonNegativeInt(usage.totalTokens)
      : inputTokens + outputTokens;

  const modelId =
    typeof usage.modelId === "string" && usage.modelId ? usage.modelId : "";

  const { pricing, reason, modelKey } = await resolvePricing(modelId);
  const cost = computeTokenCost(inputTokens, outputTokens, pricing, reason);

  const decomposition: Decomposition = {
    currency: cost.currency,
    tokenCost: cost.tokenCost,
    compute: null,
    idle: null,
    memory: null,
    runtimeComponentsPending: true,
  };

  const row: LedgerRow = {
    PK: `ORG#${orgId}`,
    SK: `${capturedAt}#${ledgerId}`,
    ledgerId,
    eventId,
    callIndex,
    orgId,
    modelId,
    modelKey,
    source,
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs: coerceNonNegativeInt(usage.latencyMs),
    capturedAt,
    ingestedAt,
    currency: cost.currency,
    tokenCost: cost.tokenCost,
    costMicros: cost.costMicros,
    priced: cost.priced,
    decomposition,
    estimate: true,
    schemaVersion: 1,
  };

  if (!cost.priced && cost.unpricedReason) {
    row.unpricedReason = cost.unpricedReason;
  }

  if (dims.projectId) {
    row.projectId = dims.projectId;
    row.GSI1PK = `PROJECT#${dims.projectId}`;
    row.GSI1SK = `${capturedAt}#${ledgerId}`;
  }
  if (dims.appId) {
    row.appId = dims.appId;
    row.GSI2PK = `APP#${dims.appId}`;
    row.GSI2SK = `${capturedAt}#${ledgerId}`;
  }
  if (dims.agentId) {
    row.agentId = dims.agentId;
    row.GSI3PK = `AGENT#${dims.agentId}`;
    row.GSI3SK = `${capturedAt}#${ledgerId}`;
  }
  if (dims.workflowExecutionId) {
    row.workflowExecutionId = dims.workflowExecutionId;
    if (dims.nodeId) row.nodeId = dims.nodeId;
    row.GSI4PK = `WORKFLOW#${dims.workflowExecutionId}`;
    row.GSI4SK = `${capturedAt}#${dims.nodeId || ""}#${ledgerId}`;
  }

  return row;
}

/** Idempotent conditional write. Swallows ONLY ConditionalCheckFailedException. */
async function writeLedgerRow(row: LedgerRow): Promise<void> {
  try {
    await docClient.send(
      new PutCommand({
        TableName: COST_LEDGER_TABLE,
        Item: row,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      console.debug(
        `cost-ledger-writer: duplicate delivery skipped, ledgerId=${row.ledgerId}`,
      );
      return;
    }
    console.error(
      "cost-ledger-writer: write failed, rethrowing for retry/DLQ",
      {
        ledgerId: row.ledgerId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    throw err;
  }
}

async function handleTaskCompletion(
  eventId: string,
  detail: TaskCompletionDetail,
  ingestedAt: string,
): Promise<LedgerRow[]> {
  // DEDUPE RULE: task.completion carrying workflow correlation is owned by
  // workflow.node.completed — drop it to avoid double-billing.
  if (detail.workflowExecutionId && detail.nodeId) {
    console.debug(
      `cost-ledger-writer: dropping task.completion with workflow correlation (owned by node.completed), taskId=${detail.taskId}`,
    );
    return [];
  }

  const usageRecords = parseUsageArray(detail.usage);
  const dims: Dimensions = {
    orgId: detail.orgId,
    projectId: detail.projectId,
    appId: detail.appId,
    agentId: detail.agentId,
  };

  return Promise.all(
    usageRecords.map((usage, idx) =>
      buildLedgerRow(
        eventId,
        coerceNonNegativeInt(usage.callIndex) || idx,
        usage,
        dims,
        usage.source || "worker",
        ingestedAt,
      ),
    ),
  );
}

async function handleIntakeUsage(
  eventId: string,
  detail: IntakeUsageDetail,
  ingestedAt: string,
): Promise<LedgerRow[]> {
  const usageRecords = parseUsageArray(detail.usage);
  const dims: Dimensions = {
    orgId: detail.orgId,
    projectId: detail.projectId,
    appId: detail.appId,
    agentId: detail.agentId,
  };

  return Promise.all(
    usageRecords.map((usage, idx) =>
      buildLedgerRow(
        eventId,
        coerceNonNegativeInt(usage.callIndex) || idx,
        usage,
        dims,
        "intake",
        ingestedAt,
      ),
    ),
  );
}

async function handleWorkflowNodeCompleted(
  eventId: string,
  detail: WorkflowNodeCompletedDetail,
  ingestedAt: string,
): Promise<LedgerRow[]> {
  const usageRecords = parseUsageArray(detail.usage);
  const dims: Dimensions = {
    orgId: detail.orgId,
    projectId: detail.projectId,
    appId: detail.appId,
    agentId: detail.agentId,
    workflowExecutionId: detail.workflowExecutionId,
    nodeId: detail.nodeId,
  };

  return Promise.all(
    usageRecords.map((usage, idx) =>
      buildLedgerRow(
        eventId,
        coerceNonNegativeInt(usage.callIndex) || idx,
        usage,
        dims,
        "workflow_node",
        ingestedAt,
      ),
    ),
  );
}

export const handler = async (
  event: EventBridgeEvent<string, IncomingDetail>,
): Promise<void> => {
  const eventId = event.id || `no-id-${Date.now()}`;
  const detailType = event["detail-type"];
  const source = event.source;
  const ingestedAt = new Date().toISOString();

  let rows: LedgerRow[];

  if (source === "task.completion" && detailType === "task.completion") {
    rows = await handleTaskCompletion(
      eventId,
      event.detail as TaskCompletionDetail,
      ingestedAt,
    );
  } else if (
    source === "agent_intake.usage" &&
    detailType === "intake.usage.captured"
  ) {
    rows = await handleIntakeUsage(
      eventId,
      event.detail as IntakeUsageDetail,
      ingestedAt,
    );
  } else if (
    source === "citadel.workflows" &&
    detailType === "workflow.node.completed"
  ) {
    rows = await handleWorkflowNodeCompleted(
      eventId,
      event.detail as WorkflowNodeCompletedDetail,
      ingestedAt,
    );
  } else {
    console.error(
      `cost-ledger-writer: unrecognized event shape, source=${source}, detailType=${detailType}`,
    );
    return;
  }

  for (const row of rows) {
    await writeLedgerRow(row);
  }
};
