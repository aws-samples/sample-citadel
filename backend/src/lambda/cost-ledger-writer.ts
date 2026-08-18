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
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { EventBridgeEvent } from "aws-lambda";
import { resolvePricing } from "./utils/cost-pricing";
import { computeTokenCost, type UnpricedReason } from "./utils/cost-compute";
import {
  annotateFromCarried,
  extractCarried,
  logFields,
} from "../utils/trace-context";

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
  /** Additive, nullable: only present when the SDK reported a request id. Never fabricated. */
  bedrockRequestId?: string;
  /** Canary attribution (decision D2/D3), additive and omit-when-absent —
   * the TS mirror of the `releaseId`/`releaseArm` keys usage.py writes onto
   * its usage record. Propagated verbatim onto the ledger row below so the
   * auto-rollback evaluator can compute per-arm cost-per-invocation and
   * model-call latency from the ledger (the ONLY per-arm-attributable
   * signal today). `releaseArm` is validated to one of the two arm
   * literals on the ledger row; a malformed value is dropped, never
   * persisted. */
  releaseId?: string;
  releaseArm?: unknown;
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
  /** Additive, nullable (Pass 1, decision f1cbd5ef): server-minted correlation id. */
  runId?: string;
  /** Additive, nullable (CIT-102 §5): eval-run correlation id + context flag. */
  evalRunId?: string;
  evalContext?: boolean;
}

interface IntakeUsageDetail {
  orgId?: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  usage?: UsageRecord | UsageRecord[];
  /** Additive, nullable (Pass 1, decision f1cbd5ef): server-minted correlation id. */
  runId?: string;
  /** Additive, nullable (CIT-102 §5): eval-run correlation id + context flag. */
  evalRunId?: string;
  evalContext?: boolean;
}

interface WorkflowNodeCompletedDetail {
  orgId?: string;
  projectId?: string;
  appId?: string;
  agentId?: string;
  workflowExecutionId?: string;
  nodeId?: string;
  usage?: UsageRecord[];
  /** Additive, nullable (Pass 1, decision f1cbd5ef): server-minted correlation id. */
  runId?: string;
  /** Additive, nullable (CIT-102 §5): eval-run correlation id + context flag. */
  evalRunId?: string;
  evalContext?: boolean;
}

/**
 * Phase 2 §2.6: emitted by the arbiter judge handler after a judge
 * invocation (Bedrock `converse` call scoring an eval case or a
 * production sample). Distinct from Phase 1's `evalContext` (dispatch-
 * time tagging of eval-RUN spend, e.g. a CONVERSATION-kind eval case's
 * own agent invocation) — this event tags the JUDGE's own token usage,
 * which is always `costContext:"eval"` unconditionally (a judge
 * invocation is never customer-billable spend, whether it judged an
 * eval-suite case or a production sample).
 */
interface EvalUsageCapturedDetail {
  orgId?: string;
  agentId?: string;
  modelId?: string;
  inputTokens?: unknown;
  outputTokens?: unknown;
  capturedAt?: string;
  /** evalRunId (eval-suite case) or sampleId/runId (prod sample) — carried
   * through as a plain attribute for traceability; not a GSI key. */
  correlationId?: string;
}

export type IncomingDetail =
  | TaskCompletionDetail
  | IntakeUsageDetail
  | WorkflowNodeCompletedDetail
  | EvalUsageCapturedDetail;

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
  /** Additive, nullable (Pass 1, decision f1cbd5ef): server-minted correlation id. No new GSI this pass. */
  runId?: string;
  /** Additive, nullable (CIT-102 §5): eval-run correlation id + context flag. No new GSI this pass. */
  evalRunId?: string;
  /** Phase 2 §2.6, additive/nullable: "eval" tags a judge invocation's
   * own token usage. Sparse GSI6 (EvalContextIndex) written only when
   * present. */
  costContext?: "eval";
  evalContext?: boolean;
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
  /** Additive, nullable: only present when the usage record carried one. Enables Tier-B matching. */
  bedrockRequestId?: string;
  /** Canary attribution (decision D2/D3), additive/omit-when-absent —
   * copied from the usage record. `releaseId` is the release the resolved
   * arm points at; `releaseArm` is "stable"|"candidate". Consumed by the
   * auto-rollback evaluator (rollback-metrics-reader.ts) to derive per-arm
   * cost-per-invocation + model-call latency. A malformed/unknown arm is
   * dropped (never persisted) so a present value can be trusted. No new
   * GSI this pass — the evaluator reads the base-table window Query and
   * filters by releaseId/releaseArm in memory (the same window
   * cost-budget-evaluator.ts already scans). */
  releaseId?: string;
  releaseArm?: "stable" | "candidate";
  /** Additive, nullable (Pass 1, decision f1cbd5ef): server-minted correlation id, copied from detail.runId when present. No new GSI this pass. */
  runId?: string;
  /** Additive, nullable (CIT-102 §5): eval-run correlation id + context flag,
   * copied from detail.evalRunId/detail.evalContext when present. Consumed
   * by cost-aggregate.ts/cost-budget-evaluator.ts to exclude eval-run spend
   * from org rollups/budget sums. No new GSI this pass. */
  evalRunId?: string;
  evalContext?: boolean;
  /** Phase 2 §2.6, additive/nullable: "eval" when this row is a judge
   * invocation's own token usage (never customer-billable). Distinct
   * from evalContext (Phase 1, eval-RUN dispatch spend) — a row can in
   * principle carry both if a future pass needs to, but today only
   * handleEvalUsageCaptured sets costContext. */
  costContext?: "eval";
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
  /** Phase 2 §2.6, sparse: written ONLY on costContext==="eval" rows —
   * EvalContextIndex GSI, PK=EVALCTX#<orgId>, SK time-prefixed like every
   * other GSI in this table so a per-org eval-cost time-range read stays
   * a plain Query, never a Scan. */
  GSI6PK?: string;
  GSI6SK?: string;
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

  if (typeof usage.bedrockRequestId === "string" && usage.bedrockRequestId) {
    row.bedrockRequestId = usage.bedrockRequestId;
  }

  // Canary attribution (D2/D3), additive/omit-when-absent — copied from the
  // usage record so a pre-canary usage row produces a byte-identical ledger
  // row. releaseArm is written ONLY when it is one of the two valid arm
  // literals (a malformed/unknown arm is dropped, never persisted), so the
  // per-arm rollback reader can trust a present value.
  if (typeof usage.releaseId === "string" && usage.releaseId) {
    row.releaseId = usage.releaseId;
  }
  if (usage.releaseArm === "stable" || usage.releaseArm === "candidate") {
    row.releaseArm = usage.releaseArm;
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
  // Additive, nullable (Pass 1, decision f1cbd5ef): server-minted
  // correlation id, copied straight through from the incoming detail. No
  // new GSI in this pass (deferred per design) — a plain top-level
  // attribute only. Omitted entirely (not a null key) when absent, so a
  // pre-runId event produces a byte-identical row.
  if (dims.runId) {
    row.runId = dims.runId;
  }
  // Additive, nullable (CIT-102 §5): eval-run correlation id + context
  // flag, copied straight through when present. evalContext is copied
  // via an explicit `!== undefined` check (not truthiness) because
  // `false` is a meaningful, intentional value here — a row explicitly
  // NOT in eval context is distinct from a row that never mentions eval
  // context at all (byte-identical omission for the latter).
  if (dims.evalRunId) {
    row.evalRunId = dims.evalRunId;
  }
  if (dims.evalContext !== undefined) {
    row.evalContext = dims.evalContext;
  }
  // Phase 2 §2.6: costContext:"eval" + sparse GSI6 EvalContextIndex,
  // written ONLY when the incoming detail is tagged eval (i.e. only via
  // handleEvalUsageCaptured below) — a pre-Phase-2 row never gains these
  // keys, byte-identical omission preserved.
  if (dims.costContext === "eval") {
    row.costContext = "eval";
    row.GSI6PK = `EVALCTX#${orgId}`;
    row.GSI6SK = `${capturedAt}#${ledgerId}`;
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
    runId: detail.runId,
    evalRunId: detail.evalRunId,
    evalContext: detail.evalContext,
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
    runId: detail.runId,
    evalRunId: detail.evalRunId,
    evalContext: detail.evalContext,
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
    runId: detail.runId,
    evalRunId: detail.evalRunId,
    evalContext: detail.evalContext,
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

/**
 * Phase 2 §2.6: judge-invocation token usage. Always tagged
 * costContext:"eval" unconditionally — there is no case where a judge's
 * own usage is customer-billable spend, whether it judged an eval-suite
 * case or a production sample. Single usage record per event (a judge
 * invocation is one Bedrock `converse` call), unlike the array-shaped
 * usage on the other three event sources.
 */
async function handleEvalUsageCaptured(
  eventId: string,
  detail: EvalUsageCapturedDetail,
  ingestedAt: string,
): Promise<LedgerRow[]> {
  const usage: UsageRecord = {
    modelId: detail.modelId,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    capturedAt: detail.capturedAt,
    source: "worker",
  };
  const dims: Dimensions = {
    orgId: detail.orgId,
    agentId: detail.agentId,
    costContext: "eval",
  };

  return [
    await buildLedgerRow(eventId, 0, usage, dims, "eval_judge", ingestedAt),
  ];
}

export const handler = async (
  event: EventBridgeEvent<string, IncomingDetail>,
): Promise<void> => {
  const eventId = event.id || `no-id-${Date.now()}`;
  const detailType = event["detail-type"];
  const source = event.source;
  const ingestedAt = new Date().toISOString();

  // Consumer parse+annotate (design §"Annotation-key contract", file-list
  // item 4): no-op-safe when event.detail carries no traceContext
  // (property-tested).
  const carried = extractCarried(event.detail);
  annotateFromCarried(carried);
  console.log(
    JSON.stringify({
      level: "info",
      message: "cost-ledger-writer received event",
      detailType,
      source,
      eventId,
      ...logFields(carried),
    }),
  );

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
  } else if (
    source === "citadel.eval.usage" &&
    detailType === "eval.usage.captured"
  ) {
    rows = await handleEvalUsageCaptured(
      eventId,
      event.detail as EvalUsageCapturedDetail,
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
