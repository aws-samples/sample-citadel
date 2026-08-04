/**
 * eval-scoring-io.ts (CIT-103 Pass A) — shared I/O helpers between
 * eval-case-scorer.ts (per-case, event-driven) and eval-run-aggregator.ts
 * (run-level, self-sufficient fallback scoring for any COMPLETED case
 * missing a scoreVector, design §2). Both Lambdas need the identical
 * "load case row + EvalCase + artifact + cost rows, map to scoreCase()
 * input shapes" sequence; extracting it here keeps that mapping
 * single-sourced rather than duplicated and risking drift between the
 * two consumers.
 *
 * This module itself performs I/O (DynamoDB/S3) — it is NOT pure, unlike
 * eval-scoring.ts/eval-score-aggregate.ts. It exists purely to be shared
 * plumbing for the two Lambda handlers.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  type EvalCaseForScoring,
  type EvalCaseRowForScoring,
  type ScoringArtifact,
  type ScoringCostRow,
  type ScoringFinding,
} from "./eval-scoring";
import type {
  ObservedTrajectory,
  ObservedTrajectoryStep,
  TrajectorySpecForScoring,
} from "./eval-trajectory";
import { resolveReplayBucketName } from "./eval-artifact-store";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

export interface EvalRunCaseRow {
  evalRunId: string;
  caseId: string;
  orgId: string;
  caseKind: "CONVERSATION" | "EXECUTION";
  targetAdapter: "execution" | "conversation";
  status: string;
  latencyMs?: number;
  dispatchedAt?: string;
  startedAt?: string;
  completedAt?: string;
  artifactRef?: string;
  suiteId: string;
  executionId?: string;
  conversationId?: string;
  scoreVector?: string;
}

export interface EvalCaseRow {
  suiteId: string;
  caseId: string;
  expectedOutcome?: EvalCaseForScoring["expectedOutcome"];
  requiredTools?: string[];
  forbiddenTools?: string[];
  expectedPolicyOutcome?: EvalCaseForScoring["expectedPolicyOutcome"];
  groundingRequirements?: EvalCaseForScoring["groundingRequirements"];
  maxLatencyMs?: number;
  maxCostUsd?: number;
  trajectorySpec?: TrajectorySpecForScoring;
}

interface ReplayEnvelopeNode {
  nodeId: string;
  outputs: unknown;
  /** Ordering anchors (Phase 1 additive nodes[] projection — see
   * replay-package-builder.ts). Absent on envelopes generated before this
   * projection extension; treated as "no order signal" (sorts last), not
   * guessed. */
  startedAt?: string | null;
  completedAt?: string | null;
  agentId?: string | null;
  status?: unknown;
}

interface ReplayEnvelopeSubset {
  kind?: "execution" | "conversation";
  sections?: {
    nodes?: ReplayEnvelopeNode[];
    findings?: unknown[] | { partial: true };
    messages?: Array<{ role: string; content: string }>;
  };
}

export async function getEvalRunCaseRow(
  tableName: string,
  evalRunId: string,
  caseId: string,
): Promise<EvalRunCaseRow | undefined> {
  const res = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { evalRunId, caseId } }),
  );
  return res.Item as EvalRunCaseRow | undefined;
}

export async function getEvalCaseDefinition(
  tableName: string,
  suiteId: string,
  caseId: string,
): Promise<EvalCaseRow | undefined> {
  const res = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { suiteId, caseId } }),
  );
  return res.Item as EvalCaseRow | undefined;
}

/**
 * Reads the replay-package artifact from S3, when present. NEVER throws:
 * any resolution/read/parse failure degrades to `undefined` (scoring
 * proceeds with empty findings/nodes/messages — the same graceful
 * degradation discipline as materializeArtifactIfCompleted).
 */
export async function readEvalArtifact(
  artifactRef: string | undefined,
): Promise<ReplayEnvelopeSubset | undefined> {
  if (!artifactRef) return undefined;
  try {
    const bucketName = await resolveReplayBucketName();
    if (!bucketName) return undefined;
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: artifactRef }),
    );
    const text = await res.Body?.transformToString();
    if (!text) return undefined;
    return JSON.parse(text) as ReplayEnvelopeSubset;
  } catch (err) {
    console.error(
      "eval-scoring-io: readEvalArtifact failed — scoring without artifact",
      {
        artifactRef,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}

function rowToScoringCostRow(row: Record<string, unknown>): ScoringCostRow {
  const priced = row.priced === true;
  const costMicros = typeof row.costMicros === "number" ? row.costMicros : null;
  return {
    priced,
    usd: priced && costMicros !== null ? costMicros / 1_000_000 : null,
  };
}

export async function readCostRows(
  costLedgerTable: string,
  executionId: string | undefined,
  conversationId: string | undefined,
): Promise<ScoringCostRow[]> {
  try {
    if (executionId) {
      const res = await docClient.send(
        new QueryCommand({
          TableName: costLedgerTable,
          IndexName: "WorkflowIndex",
          KeyConditionExpression: "GSI4PK = :pk",
          ExpressionAttributeValues: { ":pk": `WORKFLOW#${executionId}` },
        }),
      );
      return ((res.Items ?? []) as Array<Record<string, unknown>>).map(
        rowToScoringCostRow,
      );
    }
    if (conversationId) {
      const res = await docClient.send(
        new QueryCommand({
          TableName: costLedgerTable,
          IndexName: "ProjectIndex",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": `PROJECT#${conversationId}` },
        }),
      );
      return ((res.Items ?? []) as Array<Record<string, unknown>>).map(
        rowToScoringCostRow,
      );
    }
    return [];
  } catch (err) {
    console.error(
      "eval-scoring-io: readCostRows failed — treating cost as no rows (UNKNOWN)",
      {
        executionId,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return [];
  }
}

function findingsToScoringFindings(
  findings: unknown[] | { partial: true } | undefined,
): ScoringFinding[] {
  if (!findings || !Array.isArray(findings)) return [];
  return findings
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      decision: typeof f.decision === "string" ? f.decision : "",
      reason: typeof f.reason === "string" ? f.reason : "",
    }));
}

/** Timestamp -> epoch-ms, or +Infinity when absent/unparseable so nodes
 * without a startedAt anchor sort AFTER every anchored node (never
 * guessed as "first" or "concurrent"). */
function orderingKey(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Design §1.3: EXECUTION-kind ordered DAG steps, sorted by startedAt
 * (tiebreak completedAt, then nodeId — a fully deterministic total order
 * even when several nodes share identical timestamps). Nodes lacking a
 * startedAt anchor at all sort after every anchored node.
 */
function buildExecutionSteps(
  nodes: ReplayEnvelopeNode[],
): ObservedTrajectoryStep[] {
  const sorted = [...nodes].sort((a, b) => {
    const startDiff = orderingKey(a.startedAt) - orderingKey(b.startedAt);
    if (startDiff !== 0) return startDiff;
    const completeDiff =
      orderingKey(a.completedAt) - orderingKey(b.completedAt);
    if (completeDiff !== 0) return completeDiff;
    return a.nodeId.localeCompare(b.nodeId);
  });
  return sorted.map((n, i) => ({
    stepIndex: i,
    nodeId: n.nodeId,
    agentId: typeof n.agentId === "string" ? n.agentId : null,
    status: typeof n.status === "string" ? n.status : null,
  }));
}

const TOOL_PERMITTED_PREFIX = "tool_permitted:not_on_deny_list:";

/**
 * Design §1.3: toolSet is always reconstructable (set membership carries
 * no ordering requirement) — sorted + deduplicated from
 * tool_permitted findings. toolOrder stays `null` (the honest CIT-121
 * gap marker) because finding rows do not currently carry a per-finding
 * order/timestamp signal distinguishable from one another; this must
 * NEVER be backfilled from finding array position, since findings are
 * read via a Scan/Query with no guaranteed emission order (see
 * replay-package-builder.ts's own findings-ordering caveats).
 */
function buildToolSetAndOrder(findings: ScoringFinding[]): {
  toolSet: string[];
  toolOrder: string[] | null;
} {
  const tools = new Set<string>();
  for (const f of findings) {
    if (f.reason.startsWith(TOOL_PERMITTED_PREFIX)) {
      tools.add(f.reason.slice(TOOL_PERMITTED_PREFIX.length));
    }
  }
  return { toolSet: [...tools].sort(), toolOrder: null };
}

/**
 * Reconstructs ObservedTrajectory (design §1.3) from the replay envelope.
 * Pure mapping over already-fetched data — no I/O of its own. Returns a
 * fully-defined (never partially-undefined) shape even when the envelope
 * is absent, so scoreTrajectory() always receives a consistent input.
 */
function buildObservedTrajectory(
  caseKind: "CONVERSATION" | "EXECUTION",
  envelope: ReplayEnvelopeSubset | undefined,
): ObservedTrajectory {
  const nodes = envelope?.sections?.nodes ?? [];
  const messages = envelope?.sections?.messages ?? [];
  const findings = findingsToScoringFindings(envelope?.sections?.findings);
  const { toolSet, toolOrder } = buildToolSetAndOrder(findings);

  if (caseKind === "CONVERSATION") {
    const turnCount = messages.filter((m) => m.role === "assistant").length;
    return { steps: [], turnCount, toolSet, toolOrder };
  }

  return {
    steps: buildExecutionSteps(nodes),
    turnCount: 0,
    toolSet,
    toolOrder,
  };
}

/**
 * Maps a loaded case row + EvalCase definition + artifact envelope + cost
 * rows into the pure scoreCase() input shapes.
 */
export function buildScoringInputs(
  caseRow: EvalRunCaseRow,
  evalCase: EvalCaseRow,
  envelope: ReplayEnvelopeSubset | undefined,
  costRows: ScoringCostRow[],
): {
  caseRowForScoring: EvalCaseRowForScoring;
  artifact: ScoringArtifact;
  evalCaseForScoring: EvalCaseForScoring;
} {
  const caseRowForScoring: EvalCaseRowForScoring = {
    evalRunId: caseRow.evalRunId,
    caseId: caseRow.caseId,
    orgId: caseRow.orgId,
    caseKind: caseRow.caseKind,
    targetAdapter: caseRow.targetAdapter,
    status: caseRow.status,
    latencyMs: caseRow.latencyMs,
    dispatchedAt: caseRow.dispatchedAt,
    startedAt: caseRow.startedAt,
    completedAt: caseRow.completedAt,
  };

  const nodes = envelope?.sections?.nodes ?? [];
  const messages = envelope?.sections?.messages ?? [];
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  const artifact: ScoringArtifact = {
    kind: caseRow.targetAdapter,
    finalAnswerText:
      caseRow.targetAdapter === "conversation"
        ? (lastAssistantMessage?.content ?? null)
        : null,
    executionNodeOutputs: nodes.map((n) => ({
      nodeId: n.nodeId,
      outputs: n.outputs,
    })),
    findings: findingsToScoringFindings(envelope?.sections?.findings),
    costRows,
    observedTrajectory: buildObservedTrajectory(caseRow.caseKind, envelope),
  };

  const evalCaseForScoring: EvalCaseForScoring = {
    suiteId: evalCase.suiteId,
    caseId: evalCase.caseId,
    expectedOutcome: evalCase.expectedOutcome,
    requiredTools: evalCase.requiredTools ?? [],
    forbiddenTools: evalCase.forbiddenTools ?? [],
    expectedPolicyOutcome: evalCase.expectedPolicyOutcome,
    groundingRequirements: evalCase.groundingRequirements,
    maxLatencyMs: evalCase.maxLatencyMs,
    maxCostUsd: evalCase.maxCostUsd,
    trajectorySpec: evalCase.trajectorySpec,
  };

  return { caseRowForScoring, artifact, evalCaseForScoring };
}

/** Deterministic, reproducible rubric text derived ONLY from the case's
 * own definition (never free-form user text). */
export function rubricFor(
  dimension: "task_success" | "groundedness_faithfulness",
  evalCase: EvalCaseForScoring,
): string {
  if (dimension === "task_success") {
    return `Evaluate whether the response satisfies the expected outcome (mode=${evalCase.expectedOutcome?.mode ?? "unknown"}, target=${evalCase.expectedOutcome?.target ?? ""}). Score 0..1.`;
  }
  const requirement = (evalCase.groundingRequirements ?? []).find(
    (r) => r.mustNotHallucinate,
  );
  return `Evaluate whether the response avoids hallucinating claims not supported by the available context${requirement?.sourceUri ? ` (source: ${requirement.sourceUri})` : ""}. Score 0..1.`;
}
