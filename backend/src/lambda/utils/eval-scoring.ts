/**
 * eval-scoring.ts (CIT-103 Pass A + Phase 1 trajectory) — pure per-case
 * multi-dimensional scoring. Design §3 (7 dimensions v1) + §5
 * (determinism mechanics) + Phase 1 §1 (trajectory, 8th dimension).
 *
 * `scoreCase(caseRow, artifact, evalCase)` is a PURE function: no
 * `Date.now()`, no `Math.random()`, no I/O, no global/module-level mutable
 * state. Every time/cost/finding input the scorers need is passed in by
 * the caller Lambda (eval-case-scorer.ts) — this module never reaches out
 * to DynamoDB/S3/EventBridge itself. Determinism (design §5) is provable
 * because every dimension is a pure data join over its inputs; the fast-check
 * property test (eval-scoring.determinism.property.test.ts) asserts
 * byte-equal deterministic output across repeated calls on identical
 * inputs.
 *
 * State semantics (design §3):
 *  - SCORED: verdict present (boolean pass/fail, or a 0..1 score).
 *  - UNKNOWN: cannot be honestly determined (e.g. an unpriced cost row,
 *    unrecoverable latency anchors). Verdict absent. EXCLUDED from
 *    pass-rate/mean aggregation (never fabricated as zero/fail).
 *  - NOT_APPLICABLE: the case has no requirement for this dimension.
 *    Verdict absent. EXCLUDED from aggregation (a case without a
 *    requirement must never drag the aggregate).
 *  - PENDING: an opt-in judge dimension has been requested but the judge
 *    result has not yet landed (governance.eval.case.judged, Pass B).
 *
 * tool_accuracy is scored EXCLUSIVELY from governance findings
 * (`tool_permitted:not_on_deny_list:{tool}` / `tool_denied:explicit_deny_
 * list:{tool}`, see arbiter/workerWrapper/governed_tool_handler.py). The
 * replay-package artifact's `toolResults` section is ALWAYS
 * `{partial:true, results:[]}` (CIT-121/E12 not yet built) and MUST NEVER
 * be read by this module — reading it would silently regress to a
 * fabricated always-empty signal. This is a pinned, tested invariant (see
 * "never reads a toolResults field" in eval-scoring.test.ts).
 */

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

import {
  scoreTrajectory,
  type ObservedTrajectory,
  type TrajectorySpecForScoring,
} from "./eval-trajectory";

export type { ObservedTrajectory, TrajectorySpecForScoring };

export type DimensionName =
  | "task_success"
  | "policy_compliance"
  | "tool_accuracy"
  | "latency"
  | "cost"
  | "groundedness_citation"
  | "groundedness_faithfulness"
  | "trajectory";

export type DimensionStatus =
  "SCORED" | "UNKNOWN" | "NOT_APPLICABLE" | "PENDING";

export type ScoreBasis = "DETERMINISTIC" | "JUDGE";

export type DimensionVerdict =
  { kind: "boolean"; pass: boolean } | { kind: "score"; score: number };

export interface DimensionScore {
  dimension: DimensionName;
  status: DimensionStatus;
  basis: ScoreBasis;
  /** Present iff status === 'SCORED'. */
  verdict?: DimensionVerdict;
  /** Raw observed native-unit quantity (ms | usd | fraction); present when
   * measurable even if not SCORED (e.g. latency measurement with no
   * budget set still feeds p50/p95 aggregation). */
  measurement?: number | null;
  /** REQUIRED iff basis === 'JUDGE' AND status !== 'PENDING' (a judge
   * result that has landed carries the reproducibility stamp). PENDING
   * judge dims (not yet returned) omit these — there is no judge
   * response to stamp yet. */
  judgeModelId?: string;
  judgeModelVersion?: string;
  judgePromptHash?: string;
  /** Bounded (<=1KiB) deterministic text — sorted, no timestamps, no
   * locale formatting — so it participates in the byte-equal determinism
   * guarantee for DETERMINISTIC-basis dimensions. */
  detail: string;
}

export type ScoreVector = DimensionScore[];

/** Fixed canonical dimension order — the source of truth for
 * canonicalScoreVector()'s output ordering. Position 8 ("trajectory") is
 * appended, not inserted, so aggregation over old persisted vectors
 * (which lack a trajectory entry) stays additive-safe (design §0.5). */
export const DIMENSION_ORDER: readonly DimensionName[] = [
  "task_success",
  "policy_compliance",
  "tool_accuracy",
  "latency",
  "cost",
  "groundedness_citation",
  "groundedness_faithfulness",
  "trajectory",
];

const MAX_DETAIL_LENGTH = 1024;

// ─────────────────────────────────────────────────────────────────────────
// Caller-supplied input shapes (narrow views; the Lambda maps its own
// richer DDB/S3 row shapes down to these before calling scoreCase).
// ─────────────────────────────────────────────────────────────────────────

export interface EvalCaseRowForScoring {
  evalRunId: string;
  caseId: string;
  orgId: string;
  caseKind: "CONVERSATION" | "EXECUTION";
  targetAdapter: "execution" | "conversation";
  status: string;
  /** CONVERSATION kind: set directly on the case row by the worker. */
  latencyMs?: number;
  /** EXECUTION kind: anchors for deriving latency (design §3 dimension 4). */
  dispatchedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export type MatchSpecMode = "EXACT" | "CONTAINS" | "REGEX" | "JSON_SUBSET";

export interface MatchSpecForScoring {
  mode: MatchSpecMode;
  /** AWSJSON-encoded target — string-encoded when the target is structured. */
  target: string;
  path?: string;
  /** Opt-in judge fallback flag (design §3 dimension 1: "a `judge`
   * flag/rubric on expectedOutcome"). Additive/optional — absent on every
   * pre-CIT-103 case. */
  judge?: boolean;
}

export interface ExpectedPolicyOutcomeForScoring {
  decision: "PERMIT" | "DENY" | "ESCALATE";
  findingTypes: string[];
  minSeverity?: string;
}

export interface GroundingRequirementForScoring {
  sourceUri?: string;
  mustCiteAnyOf: string[];
  mustNotHallucinate: boolean;
}

export interface EvalCaseForScoring {
  suiteId: string;
  caseId: string;
  expectedOutcome?: MatchSpecForScoring;
  requiredTools: string[];
  forbiddenTools: string[];
  expectedPolicyOutcome?: ExpectedPolicyOutcomeForScoring;
  groundingRequirements?: GroundingRequirementForScoring[];
  maxLatencyMs?: number;
  maxCostUsd?: number;
  /** Design §1.2: optional per-case trajectory assertions (toolSequence,
   * dagPath, maxSteps, noLoop, noRedundantCalls). Absent => trajectory
   * dimension is NOT_APPLICABLE (case opted out entirely). */
  trajectorySpec?: TrajectorySpecForScoring;
}

/** Narrow view of one governance-ledger finding row (see
 * arbiter/governance/models.py GovernanceFinding + ledger.py
 * _serialize_finding — dataclass field names, snake->camel key-schema
 * aliases). Only the fields the scorers actually consult. */
export interface ScoringFinding {
  decision: "permit" | "deny" | "escalate" | "halt" | string;
  reason: string;
}

/** Narrow view of one cost-ledger row contributing to a case's spend. */
export interface ScoringCostRow {
  priced: boolean;
  /** USD amount; null/absent when unpriced. Never fabricated as 0. */
  usd?: number | null;
}

export interface ScoringExecutionNode {
  nodeId: string;
  outputs: unknown;
}

export interface ScoringArtifact {
  kind: "execution" | "conversation";
  /** CONVERSATION kind: the final assistant message content.
   * EXECUTION kind (no single "final answer"): null — task_success for
   * EXECUTION reads executionNodeOutputs + expectedOutcome.path instead. */
  finalAnswerText: string | null;
  executionNodeOutputs: ScoringExecutionNode[];
  findings: ScoringFinding[];
  costRows: ScoringCostRow[];
  /** Design §1.3: reconstructed by the I/O layer (eval-scoring-io.ts)
   * from `sections.nodes[]` + tool-signal findings. Optional so existing
   * callers/fixtures that predate trajectory scoring keep compiling —
   * absence is treated identically to an empty/unknown observation
   * (trajectory dimension degrades to UNKNOWN/NOT_APPLICABLE, never a
   * fabricated score). */
  observedTrajectory?: ObservedTrajectory;
  /** Intentionally typed as unknown/never-read — see module doc. Present
   * only so tests can pin the "never read" invariant against a realistic
   * artifact shape; scorers must not access this field. */
  toolResults?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

function truncateDetail(s: string): string {
  return s.length > MAX_DETAIL_LENGTH ? s.slice(0, MAX_DETAIL_LENGTH) : s;
}

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function parseMatchTarget(target: string): unknown {
  try {
    return JSON.parse(target);
  } catch {
    // Not JSON-encoded — treat the raw string as the target verbatim
    // (MatchSpec.target is documented as "AWSJSON-encoded when the target
    // is structured", implying a plain string is valid unencoded too).
    return target;
  }
}

function getByPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  const segments = path.split(".").filter((s) => s.length > 0);
  let current: unknown = value;
  for (const seg of segments) {
    if (
      current &&
      typeof current === "object" &&
      seg in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Deep subset check: every key/value in `subset` must be present and
 * equal (recursively for objects) in `full`. Arrays require exact
 * element-wise equality (index-aligned) — the design does not specify
 * array-subset semantics, so exact match is the conservative choice. */
function isJsonSubset(subset: unknown, full: unknown): boolean {
  if (subset === full) return true;
  if (typeof subset !== typeof full) return false;
  if (subset === null || full === null) return subset === full;
  if (Array.isArray(subset) || Array.isArray(full)) {
    if (!Array.isArray(subset) || !Array.isArray(full)) return false;
    if (subset.length !== full.length) return false;
    return subset.every((v, i) => isJsonSubset(v, full[i]));
  }
  if (typeof subset === "object" && typeof full === "object") {
    return Object.entries(subset as Record<string, unknown>).every(([k, v]) =>
      isJsonSubset(v, (full as Record<string, unknown>)[k]),
    );
  }
  return subset === full;
}

function findExecutionOutput(
  nodes: ScoringExecutionNode[],
  path: string | undefined,
): unknown {
  if (nodes.length === 0) return undefined;
  if (path) {
    const segments = path.split(".");
    const nodeId = segments[0];
    const rest = segments.slice(1).join(".");
    const node = nodes.find((n) => n.nodeId === nodeId);
    if (!node) return undefined;
    return rest ? getByPath(node.outputs, rest) : node.outputs;
  }
  return nodes[0]?.outputs;
}

// ─────────────────────────────────────────────────────────────────────────
// Dimension scorers
// ─────────────────────────────────────────────────────────────────────────

function scoreTaskSuccess(
  caseRow: EvalCaseRowForScoring,
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  const spec = evalCase.expectedOutcome;
  if (!spec) {
    return {
      dimension: "task_success",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no expectedOutcome set on case",
    };
  }

  if (spec.judge === true) {
    return {
      dimension: "task_success",
      status: "PENDING",
      basis: "JUDGE",
      detail:
        "task_success opted into LLM-judge fallback (expectedOutcome.judge=true)",
    };
  }

  const actual =
    caseRow.caseKind === "EXECUTION"
      ? findExecutionOutput(artifact.executionNodeOutputs, spec.path)
      : spec.path
        ? getByPath(artifact.finalAnswerText, spec.path)
        : artifact.finalAnswerText;

  let pass: boolean;
  const detailParts: string[] = [`mode=${spec.mode}`];

  switch (spec.mode) {
    case "EXACT": {
      const target = parseMatchTarget(spec.target);
      pass = actual === target;
      break;
    }
    case "CONTAINS": {
      const target = parseMatchTarget(spec.target);
      pass =
        typeof actual === "string" &&
        typeof target === "string" &&
        actual.includes(target);
      break;
    }
    case "REGEX": {
      const target = parseMatchTarget(spec.target);
      pass =
        typeof actual === "string" &&
        typeof target === "string" &&
        new RegExp(target).test(actual);
      break;
    }
    case "JSON_SUBSET": {
      const target = parseMatchTarget(spec.target);
      pass = isJsonSubset(target, actual);
      break;
    }
    default:
      pass = false;
  }

  detailParts.push(`pass=${pass}`);

  return {
    dimension: "task_success",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "boolean", pass },
    detail: truncateDetail(detailParts.join(" ")),
  };
}

function scorePolicyCompliance(
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  const expected = evalCase.expectedPolicyOutcome;
  if (!expected) {
    return {
      dimension: "policy_compliance",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no expectedPolicyOutcome set on case",
    };
  }

  const decisionMap: Record<string, string> = {
    PERMIT: "permit",
    DENY: "deny",
    ESCALATE: "escalate",
  };
  const expectedDecisionLower =
    decisionMap[expected.decision] ?? expected.decision.toLowerCase();

  const observedReasons = new Set(artifact.findings.map((f) => f.reason));
  const observedDecisions = [
    ...new Set(artifact.findings.map((f) => f.decision)),
  ].sort();

  const matchedTypes: string[] = [];
  const missingTypes: string[] = [];
  for (const ft of expected.findingTypes) {
    if (observedReasons.has(ft)) matchedTypes.push(ft);
    else missingTypes.push(ft);
  }
  matchedTypes.sort();
  missingTypes.sort();

  const decisionMatches =
    expected.findingTypes.length === 0
      ? observedDecisions.includes(expectedDecisionLower) ||
        observedDecisions.length === 0
      : artifact.findings.some((f) => f.decision === expectedDecisionLower);

  const pass = decisionMatches && missingTypes.length === 0;

  const detail = truncateDetail(
    `expectedDecision=${expectedDecisionLower} observedDecisions=${observedDecisions.join(",")} matched=${matchedTypes.join(",")} missing=${missingTypes.join(",")}`,
  );

  return {
    dimension: "policy_compliance",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "boolean", pass },
    detail,
  };
}

const TOOL_PERMITTED_PREFIX = "tool_permitted:not_on_deny_list:";
const TOOL_DENIED_PREFIX = "tool_denied:explicit_deny_list:";

function scoreToolAccuracy(
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  const required = evalCase.requiredTools ?? [];
  const forbidden = evalCase.forbiddenTools ?? [];

  if (required.length === 0 && forbidden.length === 0) {
    return {
      dimension: "tool_accuracy",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no requiredTools/forbiddenTools set on case",
    };
  }

  // FINDINGS-ONLY signal — artifact.toolResults is deliberately never
  // referenced anywhere in this function (see module doc + pinned test).
  const permittedTools = new Set<string>();
  const deniedTools = new Set<string>();
  for (const f of artifact.findings) {
    if (f.reason.startsWith(TOOL_PERMITTED_PREFIX)) {
      permittedTools.add(f.reason.slice(TOOL_PERMITTED_PREFIX.length));
    } else if (f.reason.startsWith(TOOL_DENIED_PREFIX)) {
      deniedTools.add(f.reason.slice(TOOL_DENIED_PREFIX.length));
    }
  }

  let satisfied = 0;
  let total = 0;
  const violatedForbidden: string[] = [];
  const missingRequired: string[] = [];

  for (const tool of required) {
    total += 1;
    if (permittedTools.has(tool)) satisfied += 1;
    else missingRequired.push(tool);
  }
  for (const tool of forbidden) {
    total += 1;
    // A forbidden-tool constraint is satisfied when it was NOT invoked
    // (no permitted or denied finding for it — never invoked at all) OR
    // was correctly denied. It is VIOLATED only if a permitted finding
    // exists for it (the tool ran despite being forbidden).
    if (permittedTools.has(tool)) {
      violatedForbidden.push(tool);
    } else {
      satisfied += 1;
    }
  }

  const rawScore = total === 0 ? 1 : satisfied / total;
  const score = round6dp(rawScore);
  missingRequired.sort();
  violatedForbidden.sort();

  const detail = truncateDetail(
    `satisfied=${satisfied}/${total} missingRequired=${missingRequired.join(",")} violatedForbidden=${violatedForbidden.join(",")} pass=${score === 1}`,
  );

  return {
    dimension: "tool_accuracy",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "score", score },
    measurement: score,
    detail,
  };
}

function scoreLatency(
  caseRow: EvalCaseRowForScoring,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  let measurement: number | undefined;
  let anchorNote: string;

  if (caseRow.targetAdapter === "conversation") {
    measurement =
      typeof caseRow.latencyMs === "number" ? caseRow.latencyMs : undefined;
    anchorNote = "anchor=case.latencyMs";
  } else {
    const startAnchor = caseRow.startedAt ?? caseRow.dispatchedAt;
    if (startAnchor && caseRow.completedAt) {
      const startMs = new Date(startAnchor).getTime();
      const endMs = new Date(caseRow.completedAt).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        measurement = Math.max(0, endMs - startMs);
      }
    }
    anchorNote = caseRow.startedAt
      ? "anchor=startedAt"
      : caseRow.dispatchedAt
        ? "anchor=dispatchedAt"
        : "anchor=none";
  }

  if (measurement === undefined) {
    return {
      dimension: "latency",
      status: "UNKNOWN",
      basis: "DETERMINISTIC",
      detail: truncateDetail(`latency anchors unavailable (${anchorNote})`),
    };
  }

  const detail = truncateDetail(`measurementMs=${measurement} ${anchorNote}`);

  if (typeof evalCase.maxLatencyMs === "number") {
    const pass = measurement <= evalCase.maxLatencyMs;
    return {
      dimension: "latency",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "boolean", pass },
      measurement,
      detail,
    };
  }

  return {
    dimension: "latency",
    status: "SCORED",
    basis: "DETERMINISTIC",
    measurement,
    detail,
  };
}

function scoreCost(
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  const rows = artifact.costRows ?? [];

  if (rows.length === 0) {
    return {
      dimension: "cost",
      status: "UNKNOWN",
      basis: "DETERMINISTIC",
      detail: "no cost ledger rows for this case",
    };
  }

  const anyUnpriced = rows.some(
    (r) => !r.priced || r.usd === null || r.usd === undefined,
  );
  if (anyUnpriced) {
    return {
      dimension: "cost",
      status: "UNKNOWN",
      basis: "DETERMINISTIC",
      detail: truncateDetail(
        `unpricedReason=at least one contributing cost row is unpriced (rows=${rows.length})`,
      ),
    };
  }

  const totalUsd = round6dp(rows.reduce((sum, r) => sum + (r.usd ?? 0), 0));
  const detail = truncateDetail(
    `measurementUsd=${totalUsd} rows=${rows.length}`,
  );

  if (typeof evalCase.maxCostUsd === "number") {
    const pass = totalUsd <= evalCase.maxCostUsd;
    return {
      dimension: "cost",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "boolean", pass },
      measurement: totalUsd,
      detail,
    };
  }

  return {
    dimension: "cost",
    status: "SCORED",
    basis: "DETERMINISTIC",
    measurement: totalUsd,
    detail,
  };
}

function citationTextForCase(
  caseRow: EvalCaseRowForScoring,
  artifact: ScoringArtifact,
): string {
  if (caseRow.targetAdapter === "conversation") {
    return artifact.finalAnswerText ?? "";
  }
  return artifact.executionNodeOutputs
    .map((n) =>
      typeof n.outputs === "string"
        ? n.outputs
        : JSON.stringify(n.outputs ?? ""),
    )
    .join("\n");
}

const KB_TOOL_PERMITTED = `${TOOL_PERMITTED_PREFIX}query_knowledge_base`;

function scoreGroundednessCitation(
  caseRow: EvalCaseRowForScoring,
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  const requirements = evalCase.groundingRequirements ?? [];
  const withCitation = requirements.filter(
    (r) => (r.mustCiteAnyOf ?? []).length > 0,
  );

  if (withCitation.length === 0) {
    return {
      dimension: "groundedness_citation",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no mustCiteAnyOf groundingRequirements set on case",
    };
  }

  const text = citationTextForCase(caseRow, artifact);
  const kbConsulted = artifact.findings.some(
    (f) => f.reason === KB_TOOL_PERMITTED,
  );

  const results = withCitation.map((req) => {
    const cited = req.mustCiteAnyOf.some((token) => text.includes(token));
    return cited || kbConsulted ? true : false;
  });
  const pass = results.every(Boolean);

  const detail = truncateDetail(
    `requirements=${withCitation.length} kbConsulted=${kbConsulted} allCited=${pass}`,
  );

  return {
    dimension: "groundedness_citation",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "boolean", pass },
    detail,
  };
}

function scoreGroundednessFaithfulness(
  evalCase: EvalCaseForScoring,
): DimensionScore {
  const requirements = evalCase.groundingRequirements ?? [];
  const optedIn = requirements.some((r) => r.mustNotHallucinate === true);

  if (!optedIn) {
    return {
      dimension: "groundedness_faithfulness",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no groundingRequirement opted into mustNotHallucinate",
    };
  }

  return {
    dimension: "groundedness_faithfulness",
    status: "PENDING",
    basis: "JUDGE",
    detail:
      "groundedness_faithfulness requires LLM judge (mustNotHallucinate=true, opt-in)",
  };
}

function scoreTrajectoryDimension(
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): DimensionScore {
  return scoreTrajectory(artifact.observedTrajectory, evalCase.trajectorySpec);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Scores one eval case across all 7 v1 dimensions. PURE — see module doc.
 * Returns dimensions in DIMENSION_ORDER (already canonical; callers may
 * still route the result through canonicalScoreVector() defensively,
 * e.g. after merging in a judge-landed patch from a different code path).
 */
export function scoreCase(
  caseRow: EvalCaseRowForScoring,
  artifact: ScoringArtifact,
  evalCase: EvalCaseForScoring,
): ScoreVector {
  const vector: ScoreVector = [
    scoreTaskSuccess(caseRow, artifact, evalCase),
    scorePolicyCompliance(artifact, evalCase),
    scoreToolAccuracy(artifact, evalCase),
    scoreLatency(caseRow, evalCase),
    scoreCost(artifact, evalCase),
    scoreGroundednessCitation(caseRow, artifact, evalCase),
    scoreGroundednessFaithfulness(evalCase),
    scoreTrajectoryDimension(artifact, evalCase),
  ];
  return canonicalScoreVector(vector);
}

/**
 * Sorts a ScoreVector into the fixed DIMENSION_ORDER, producing a
 * byte-stable serialization regardless of input order (design §5).
 * Unknown dimensions (should never occur with a well-formed vector) sort
 * after all known dimensions, in stable input order, so this function
 * never throws on a partially-formed vector (e.g. one under construction
 * by a future evaluator registry, CIT-107).
 */
export function canonicalScoreVector(vector: ScoreVector): ScoreVector {
  const orderIndex = new Map<string, number>(
    DIMENSION_ORDER.map((d, i) => [d, i]),
  );
  return [...vector].sort((a, b) => {
    const ia = orderIndex.get(a.dimension) ?? DIMENSION_ORDER.length;
    const ib = orderIndex.get(b.dimension) ?? DIMENSION_ORDER.length;
    return ia - ib;
  });
}
