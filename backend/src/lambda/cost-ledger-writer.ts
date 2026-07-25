/**
 * Cost Ledger Writer — Lambda
 *
 * Pass 1 (usage-only, no pricing yet): consumes 3 EventBridge event shapes
 * (task.completion, agent_intake.usage/intake.usage.captured,
 * citadel.workflows/workflow.node.completed), applies the dedupe rule, and
 * writes idempotent usage rows to the cost-ledger table.
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
 * No pricing/cost math this pass: rows are written with `priced: false`,
 * `tokenCost: null`, `costMicros: null`, `estimate: true`.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { EventBridgeEvent } from "aws-lambda";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;

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
  source: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  capturedAt: string;
  ingestedAt: string;
  // Pricing fields: intentionally null/false this pass — populated in pass 2.
  currency: null;
  tokenCost: null;
  costMicros: null;
  priced: false;
  decomposition: null;
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

/** Builds one idempotent ledger row from a usage record + shared dimensions. */
function buildLedgerRow(
  eventId: string,
  callIndex: number,
  usage: UsageRecord,
  dims: Dimensions,
  source: string,
  ingestedAt: string,
): LedgerRow {
  const capturedAt = usage.capturedAt || ingestedAt;
  const orgId = dims.orgId && dims.orgId.length > 0 ? dims.orgId : "UNKNOWN";
  const ledgerId = `${eventId}:${callIndex}`;
  const inputTokens = coerceNonNegativeInt(usage.inputTokens);
  const outputTokens = coerceNonNegativeInt(usage.outputTokens);
  const totalTokens =
    usage.totalTokens !== undefined
      ? coerceNonNegativeInt(usage.totalTokens)
      : inputTokens + outputTokens;

  const row: LedgerRow = {
    PK: `ORG#${orgId}`,
    SK: `${capturedAt}#${ledgerId}`,
    ledgerId,
    eventId,
    callIndex,
    orgId,
    modelId:
      typeof usage.modelId === "string" && usage.modelId ? usage.modelId : "",
    source,
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs: coerceNonNegativeInt(usage.latencyMs),
    capturedAt,
    ingestedAt,
    currency: null,
    tokenCost: null,
    costMicros: null,
    priced: false,
    decomposition: null,
    estimate: true,
    schemaVersion: 1,
  };

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

function handleTaskCompletion(
  eventId: string,
  detail: TaskCompletionDetail,
  ingestedAt: string,
): LedgerRow[] {
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

  return usageRecords.map((usage, idx) =>
    buildLedgerRow(
      eventId,
      coerceNonNegativeInt(usage.callIndex) || idx,
      usage,
      dims,
      usage.source || "worker",
      ingestedAt,
    ),
  );
}

function handleIntakeUsage(
  eventId: string,
  detail: IntakeUsageDetail,
  ingestedAt: string,
): LedgerRow[] {
  const usageRecords = parseUsageArray(detail.usage);
  const dims: Dimensions = {
    orgId: detail.orgId,
    projectId: detail.projectId,
    appId: detail.appId,
    agentId: detail.agentId,
  };

  return usageRecords.map((usage, idx) =>
    buildLedgerRow(
      eventId,
      coerceNonNegativeInt(usage.callIndex) || idx,
      usage,
      dims,
      "intake",
      ingestedAt,
    ),
  );
}

function handleWorkflowNodeCompleted(
  eventId: string,
  detail: WorkflowNodeCompletedDetail,
  ingestedAt: string,
): LedgerRow[] {
  const usageRecords = parseUsageArray(detail.usage);
  const dims: Dimensions = {
    orgId: detail.orgId,
    projectId: detail.projectId,
    appId: detail.appId,
    agentId: detail.agentId,
    workflowExecutionId: detail.workflowExecutionId,
    nodeId: detail.nodeId,
  };

  return usageRecords.map((usage, idx) =>
    buildLedgerRow(
      eventId,
      coerceNonNegativeInt(usage.callIndex) || idx,
      usage,
      dims,
      "workflow_node",
      ingestedAt,
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
    rows = handleTaskCompletion(
      eventId,
      event.detail as TaskCompletionDetail,
      ingestedAt,
    );
  } else if (
    source === "agent_intake.usage" &&
    detailType === "intake.usage.captured"
  ) {
    rows = handleIntakeUsage(
      eventId,
      event.detail as IntakeUsageDetail,
      ingestedAt,
    );
  } else if (
    source === "citadel.workflows" &&
    detailType === "workflow.node.completed"
  ) {
    rows = handleWorkflowNodeCompleted(
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
