/**
 * Replay package builder (CIT-026 design §4/§5).
 *
 * `assembleReplayPackage(orgId, kind, id)` reads the execution (execution
 * kind) or the conversation transcript + cost-ledger rollup (conversation
 * kind), and every related table, builds the versioned envelope, filters
 * every sourced row by the CALLER-RESOLVED orgId (defence in depth beyond
 * the handler's own ownership check), and runs the bundle through
 * sanitizeBundle + assertBundleSecretFree before returning it. The gate
 * throwing propagates straight out of this function — the handler
 * (replay-package-handler.ts) is what turns that into a fail-closed
 * "refuse to publish" HTTP response.
 *
 * CONVERSATION-KIND FEASIBILITY (read directly, not inferred):
 *   - conversationId == projectId: `resolveConversationOwnership` in
 *     trace-http-shared.ts resolves ownership via
 *     `PROJECTS_TABLE.GetItem(Key={id: conversationId})`.
 *   - Messages ARE queryable: `CONVERSATIONS_TABLE` (backend-stack.ts
 *     `conversationsTable`) is keyed `projectId` (partition) / `timestamp`
 *     (sort) — the same shape `conversation-resolver.ts`'s
 *     `getConversationHistory` already queries.
 *   - Usage/cost IS queryable: `service/agent_intake_single/tools/state.py`
 *     `publish_usage_event` stamps `projectId: session_id` on every
 *     `agent_intake.usage`/`intake.usage.captured` event; `cost-ledger-writer.ts`
 *     persists those rows with `GSI1PK = PROJECT#<projectId>` /
 *     `GSI1SK = <capturedAt>#<ledgerId>` (its `handleIntakeUsage` path) —
 *     a real, queryable, org-scoped join from conversationId to usage.
 *   - Governance findings do NOT join: the governance ledger
 *     (`arbiter/governance/ledger.py`) keys findings on `workflowId`
 *     (== `orchestrationId`, see `arbiter/supervisor/index.py`), and
 *     nothing ties a conversationId/projectId to an orchestrationId.
 *     `sections.findings` is therefore an explicit partial section with
 *     provenance for conversation kind — never invented, never guessed.
 *   - agentConfig/workflow/execSpec/modelConfig are execution-scoped
 *     concepts with no conversation-side equivalent row to read; they are
 *     `null` for conversation kind (not partial — genuinely absent, no
 *     placeholder to model).
 *
 * HONEST GAP (design §4, carried into the envelope's toolResults section,
 * applies to BOTH kinds): raw per-node-per-tool-call result payloads are
 * NOT persisted in a queryable store today. What we have is (a) the node's
 * final output (which may embed tool output) and (b) governance-ledger
 * findings that a tool ran + its governance decision. The dedicated
 * tool-execution ledger that would hold `key -> result` is CIT-121 (E12),
 * not yet built. This function NEVER reads CloudWatch logs to backfill
 * that gap — logs are not a reproducible artifact and would pull
 * unredacted data into scope outside this pipeline's sanitisation
 * guarantee. `sections.toolResults` is therefore always
 * `{ partial: true, results: [], provenance: "..." }` in this pass; a
 * future CIT-121-backed pass replaces `results` with real per-call data
 * without touching this shape's `partial`/`provenance` fields
 * (additive-safe schema evolution, design §5).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { sanitizeBundle, assertBundleSecretFree } from "./replay-sanitize";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/** Schema envelope version (design §5). Bumped only on a BREAKING section
 * change — additive fields never require a bump. */
export const REPLAY_SCHEMA_VERSION = "1.0.0";

export type ReplayKind = "execution" | "conversation";

/** Thrown when any sourced row's orgId does not match the caller-resolved
 * orgId. This is defence-in-depth beyond the handler's ownership check:
 * even if the handler's ownership resolution were ever bypassed or wrong,
 * a row-level org mismatch here still refuses to include that row. */
export class CrossOrgRowError extends Error {
  constructor(table: string, rowOrgId: string, expectedOrgId: string) {
    super(
      `Cross-org row encountered while building replay package: table=${table} rowOrgId=${rowOrgId} expectedOrgId=${expectedOrgId}`,
    );
    this.name = "CrossOrgRowError";
  }
}

export class ReplayNotFoundError extends Error {
  constructor(kind: ReplayKind, id: string) {
    super(`Replay package source not found: kind=${kind} id=${id}`);
    this.name = "ReplayNotFoundError";
  }
}

function assertRowOrg(
  table: string,
  row: { orgId?: unknown } | undefined,
  expectedOrgId: string,
): void {
  if (!row) return;
  const rowOrgId = typeof row.orgId === "string" ? row.orgId : undefined;
  if (rowOrgId !== undefined && rowOrgId !== expectedOrgId) {
    throw new CrossOrgRowError(table, rowOrgId, expectedOrgId);
  }
}

interface NodeResultRow {
  nodeId?: string;
  agentId?: string | null;
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  output?: unknown;
  error?: string | null;
  retryCount?: number | null;
  usageTotals?: unknown;
}

interface ToolResultsSection {
  partial: true;
  results: unknown[];
  provenance: string;
}

interface FindingsSection {
  partial: true;
  results: unknown[];
  provenance: string;
}

/** Always partial in this pass — see the module-level HONEST GAP comment. */
function buildToolResultsSection(): ToolResultsSection {
  return {
    partial: true,
    results: [],
    provenance:
      "Raw per-tool-call results are not persisted in a queryable store " +
      "(CIT-121, E12, not yet built). This section is derived from " +
      "tool-call governance findings and node final outputs only; it is " +
      "never backfilled from CloudWatch logs.",
  };
}

/** Conversation kind only: governance findings key on workflowId
 * (== orchestrationId) and nothing ties a conversationId/projectId to an
 * orchestrationId — there is no join key. Modelled as an explicit partial
 * section with provenance rather than an invented/empty findings array
 * that could be mistaken for "confirmed: no findings". */
function buildUnjoinableFindingsSection(): FindingsSection {
  return {
    partial: true,
    results: [],
    provenance:
      "Governance findings key on workflowId (== orchestrationId); no " +
      "table ties a conversationId/projectId to an orchestrationId, so " +
      "this section cannot be joined for conversation-kind packages. " +
      "Never invented, never guessed from unrelated rows.",
  };
}

async function readExecution(executionId: string) {
  const tableName = process.env.EXECUTIONS_TABLE!;
  const result = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { executionId } }),
  );
  return {
    tableName,
    item: result.Item as Record<string, unknown> | undefined,
  };
}

async function readWorkflow(workflowId: string | undefined) {
  if (!workflowId) return undefined;
  const tableName = process.env.WORKFLOWS_TABLE!;
  const result = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { workflowId } }),
  );
  return {
    tableName,
    item: result.Item as Record<string, unknown> | undefined,
  };
}

async function readAgentConfig(agentId: string | undefined) {
  if (!agentId) return undefined;
  const tableName = process.env.AGENT_CONFIG_TABLE!;
  const result = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { agentId } }),
  );
  return {
    tableName,
    item: result.Item as Record<string, unknown> | undefined,
  };
}

async function readExecSpec(specId: string | undefined) {
  if (!specId) return undefined;
  const tableName = process.env.EXECUTION_SPECS_TABLE!;
  const result = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { specId } }),
  );
  return {
    tableName,
    item: result.Item as Record<string, unknown> | undefined,
  };
}

async function readModelConfig(scope: string | undefined) {
  if (!scope) return undefined;
  const tableName = process.env.MODEL_CONFIG_TABLE!;
  const result = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { scope } }),
  );
  return {
    tableName,
    item: result.Item as Record<string, unknown> | undefined,
  };
}

async function readGovernanceFindings(workflowId: string | undefined) {
  const tableName = process.env.GOVERNANCE_LEDGER_TABLE!;
  if (!workflowId) return { tableName, items: [] as Record<string, unknown>[] };
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "workflow-index",
      KeyConditionExpression: "workflowId = :wid",
      ExpressionAttributeValues: { ":wid": workflowId },
    }),
  );
  return {
    tableName,
    items: (result.Items ?? []) as Record<string, unknown>[],
  };
}

async function readCostLedgerUsage(executionId: string) {
  const tableName = process.env.COST_LEDGER_TABLE!;
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "WorkflowIndex",
      KeyConditionExpression: "GSI4PK = :pk",
      ExpressionAttributeValues: { ":pk": `WORKFLOW#${executionId}` },
    }),
  );
  return {
    tableName,
    items: (result.Items ?? []) as Record<string, unknown>[],
  };
}

/** Conversation kind: `CONVERSATIONS_TABLE` is keyed `projectId` (partition)
 * / `timestamp` (sort) — the exact shape conversation-resolver.ts's
 * `getConversationHistory` already queries. conversationId == projectId
 * (see resolveConversationOwnership in trace-http-shared.ts). */
async function readConversationMessages(projectId: string) {
  const tableName = process.env.CONVERSATIONS_TABLE!;
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
    }),
  );
  return {
    tableName,
    items: (result.Items ?? []) as Record<string, unknown>[],
  };
}

/** Conversation kind: usage/cost rows are joined via COST_LEDGER_TABLE's
 * ProjectIndex GSI (GSI1PK = PROJECT#<projectId>), populated by
 * cost-ledger-writer.ts's handleIntakeUsage path from state.py's
 * publish_usage_event, which stamps `projectId: session_id` (session_id ==
 * projectId per the existing session/project convention documented in
 * state.py). */
async function readCostLedgerUsageByProject(projectId: string) {
  const tableName = process.env.COST_LEDGER_TABLE!;
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "ProjectIndex",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `PROJECT#${projectId}` },
    }),
  );
  return {
    tableName,
    items: (result.Items ?? []) as Record<string, unknown>[],
  };
}

export interface ReplayPackageEnvelope {
  schemaVersion: string;
  generatedAt: string;
  producerCommit: string | null;
  kind: ReplayKind;
  correlationId: string;
  orgId: string;
  sanitisation: {
    redactPiiVersion: string;
    secretPatternsVersion: string;
    gate: "passed";
  };
  sections: {
    agentConfig: unknown;
    workflow: unknown;
    execSpec: unknown;
    modelConfig: unknown;
    governanceMode: unknown;
    nodes: Array<{
      nodeId: string;
      inputs: unknown;
      outputs: unknown;
      status: unknown;
      retries: unknown;
      usage: unknown;
    }>;
    toolResults: ToolResultsSection;
    /** Execution kind: an array of governance-ledger finding rows.
     * Conversation kind: an explicit FindingsSection partial marker — no
     * join key exists from conversationId/projectId to orchestrationId. */
    findings: unknown[] | FindingsSection;
    /** Conversation kind only: transcript rows from CONVERSATIONS_TABLE,
     * queried by projectId (== conversationId), chronological order.
     * Absent (undefined) for execution kind — there is no per-execution
     * conversation transcript to attach. */
    messages?: Array<Record<string, unknown>>;
    usageTotals: unknown;
    traceIds: { correlationId: string };
  };
}

/**
 * Assembles, org-filters, sanitises, and gate-checks a full replay
 * package. Throws CrossOrgRowError on any cross-org row, ReplayNotFoundError
 * when the source entity does not exist, and ReplaySecretLeakError (from
 * assertBundleSecretFree, re-exported via replay-sanitize.ts) if the
 * fail-closed gate fires — callers must let all three propagate as
 * "refuse to build/publish", never swallow them.
 */
export async function assembleReplayPackage(
  orgId: string,
  kind: ReplayKind,
  id: string,
): Promise<ReplayPackageEnvelope> {
  if (kind === "conversation") {
    return assembleConversationReplayPackage(orgId, id);
  }

  const { tableName: executionsTable, item: execution } =
    await readExecution(id);
  if (!execution) {
    throw new ReplayNotFoundError(kind, id);
  }
  assertRowOrg(executionsTable, execution, orgId);

  const workflowId =
    typeof execution.workflowId === "string" ? execution.workflowId : undefined;
  const specId =
    typeof execution.specId === "string" ? execution.specId : undefined;
  const modelConfigScope =
    typeof execution.modelConfigScope === "string"
      ? execution.modelConfigScope
      : workflowId;

  const [workflow, execSpec, modelConfig, governance, costUsage] =
    await Promise.all([
      readWorkflow(workflowId),
      readExecSpec(specId),
      readModelConfig(modelConfigScope),
      readGovernanceFindings(workflowId),
      readCostLedgerUsage(id),
    ]);

  if (workflow) assertRowOrg(workflow.tableName, workflow.item, orgId);
  if (execSpec) assertRowOrg(execSpec.tableName, execSpec.item, orgId);
  if (modelConfig) assertRowOrg(modelConfig.tableName, modelConfig.item, orgId);
  for (const finding of governance.items) {
    assertRowOrg(governance.tableName, finding, orgId);
  }
  for (const usageRow of costUsage.items) {
    assertRowOrg(costUsage.tableName, usageRow, orgId);
  }

  const nodeResultsRaw = execution.nodeResults as
    Record<string, NodeResultRow> | undefined;
  const nodes = Object.entries(nodeResultsRaw ?? {}).map(([key, value]) => ({
    nodeId:
      typeof value?.nodeId === "string" && value.nodeId ? value.nodeId : key,
    inputs: null, // per-node raw INPUT is not separately persisted alongside output today.
    outputs: value?.output ?? null,
    status: value?.status ?? null,
    retries: value?.retryCount ?? 0,
    usage: value?.usageTotals ?? null,
  }));

  // agentConfig section is keyed off the first node's agentId, when present
  // — a single execution can span multiple agents, but the envelope's
  // top-level agentConfig section documents the primary/first one; per-node
  // agentId is still visible via nodes[].
  const firstAgentId =
    Object.values(nodeResultsRaw ?? {})[0]?.agentId ?? undefined;
  const agentConfig = firstAgentId
    ? await readAgentConfig(firstAgentId)
    : undefined;
  if (agentConfig) assertRowOrg(agentConfig.tableName, agentConfig.item, orgId);

  const envelope: ReplayPackageEnvelope = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    producerCommit: process.env.COMMIT_SHA || null,
    kind,
    correlationId: id,
    orgId,
    sanitisation: {
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    },
    sections: {
      agentConfig: agentConfig?.item ?? null,
      workflow: workflow?.item ?? null,
      execSpec: execSpec?.item ?? null,
      modelConfig: modelConfig?.item ?? null,
      governanceMode: execution.governanceMode ?? null,
      nodes,
      toolResults: buildToolResultsSection(),
      findings: governance.items,
      usageTotals: execution.usageTotals ?? null,
      traceIds: { correlationId: id },
    },
  };

  const sanitised = sanitizeBundle(envelope) as ReplayPackageEnvelope;
  assertBundleSecretFree(sanitised);
  return sanitised;
}

/**
 * Conversation-kind assembly. conversationId == projectId (see the
 * module-level CONVERSATION-KIND FEASIBILITY comment). Reuses the SAME
 * envelope shape, SAME per-row org filter, SAME toolResults honest-gap
 * modelling, and SAME sanitizeBundle + assertBundleSecretFree gate as the
 * execution path — only the section SOURCES differ.
 */
async function assembleConversationReplayPackage(
  orgId: string,
  conversationId: string,
): Promise<ReplayPackageEnvelope> {
  const [messages, costUsage] = await Promise.all([
    readConversationMessages(conversationId),
    readCostLedgerUsageByProject(conversationId),
  ]);

  for (const messageRow of messages.items) {
    assertRowOrg(messages.tableName, messageRow, orgId);
  }
  for (const usageRow of costUsage.items) {
    assertRowOrg(costUsage.tableName, usageRow, orgId);
  }

  // Chronological order — CONVERSATIONS_TABLE's sort key is `timestamp`
  // (ISO-8601 string), so a lexicographic sort is a correct chronological
  // sort, mirroring conversation-resolver.ts's getConversationHistory
  // (which queries ScanIndexForward:false then .reverse()s to chronological).
  const orderedMessages = [...messages.items].sort((a, b) => {
    const ta = typeof a.timestamp === "string" ? a.timestamp : "";
    const tb = typeof b.timestamp === "string" ? b.timestamp : "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  interface UsageTotalsAcc {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    callCount: number;
  }

  const usageTotals = costUsage.items.reduce<UsageTotalsAcc>(
    (acc, row) => {
      acc.inputTokens += coerceNonNegativeNumber(row.inputTokens);
      acc.outputTokens += coerceNonNegativeNumber(row.outputTokens);
      acc.totalTokens += coerceNonNegativeNumber(row.totalTokens);
      acc.callCount += 1;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0 },
  );

  const envelope: ReplayPackageEnvelope = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    producerCommit: process.env.COMMIT_SHA || null,
    kind: "conversation",
    correlationId: conversationId,
    orgId,
    sanitisation: {
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    },
    sections: {
      // No conversation-side equivalent row exists for these
      // execution-scoped concepts — genuinely absent, not partial.
      agentConfig: null,
      workflow: null,
      execSpec: null,
      modelConfig: null,
      governanceMode: null,
      nodes: [],
      toolResults: buildToolResultsSection(),
      findings: buildUnjoinableFindingsSection(),
      messages: orderedMessages,
      usageTotals,
      traceIds: { correlationId: conversationId },
    },
  };

  const sanitised = sanitizeBundle(envelope) as ReplayPackageEnvelope;
  assertBundleSecretFree(sanitised);
  return sanitised;
}

/** Defensive numeric coercion for cost-ledger rows crossing a table-read
 * boundary — mirrors cost-ledger-writer.ts's coerceNonNegativeInt intent
 * without importing that Lambda's module (kept dependency-free here). */
function coerceNonNegativeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return 0;
}
