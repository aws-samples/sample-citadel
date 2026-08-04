/**
 * eval-trajectory.ts (CIT-103 Phase 1) — pure "trajectory" dimension
 * scorer. Design §1: trajectory is an 8th DETERMINISTIC scoring
 * dimension appended to DIMENSION_ORDER (eval-scoring.ts), reconstructed
 * from `sections.nodes[]` (execution DAG path) + tool-signal findings —
 * the SAME honest-gap discipline as tool_accuracy in eval-scoring.ts.
 *
 * PURE — no `Date.now()`, no `Math.random()`, no I/O, no module-level
 * mutable state. `ObservedTrajectory` is reconstructed by the I/O layer
 * (eval-scoring-io.ts::buildScoringInputs) from the replay-package
 * artifact; this module only consumes the already-reconstructed shape.
 *
 * Sub-assertions from `trajectorySpec` (toolSequence, dagPath, maxSteps,
 * noLoop, noRedundantCalls) are each independently evaluated. A
 * sub-assertion that cannot be honestly evaluated from the available
 * signals contributes NEITHER a pass NOR a fail — it is excluded from
 * the evaluable denominator entirely (mirrors tool_accuracy/cost's
 * UNKNOWN discipline in eval-scoring.ts). Two flavors of "not evaluable":
 *  - "n/a for this case kind" (e.g. dagPath requested on a CONVERSATION-
 *    kind case, which has no execution DAG) — genuinely inapplicable to
 *    THIS sub-assertion, not a data gap.
 *  - "unavailable" (e.g. SUBSEQUENCE/STRICT toolSequence requested but no
 *    finding row carries a usable order signal, `toolOrder === null`) —
 *    a real data gap (CIT-121: raw per-tool-call ordering is not
 *    persisted yet). SET-mode toolSequence checks set membership only
 *    and is therefore ALWAYS evaluable regardless of ordering data.
 *
 * If a `trajectorySpec` is present but EVERY requested sub-assertion
 * turns out non-evaluable, the dimension is UNKNOWN overall (verdict
 * absent) — never fabricated as a score. This mirrors the case-level
 * UNKNOWN semantics documented in eval-scoring.ts's module doc.
 */
import type { DimensionScore } from "./eval-scoring";

const MAX_DETAIL_LENGTH = 1024;

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type ToolSequenceMode = "SET" | "SUBSEQUENCE" | "STRICT";

export interface ToolSequenceSpecForScoring {
  mode: ToolSequenceMode;
  tools: string[];
}

/** Per-case `trajectorySpec` (design §1.2). All sub-fields optional; each
 * present sub-field contributes at most one sub-assertion. */
export interface TrajectorySpecForScoring {
  toolSequence?: ToolSequenceSpecForScoring;
  dagPath?: string[];
  maxSteps?: number;
  noLoop?: boolean;
  noRedundantCalls?: boolean;
}

/** One reconstructed execution-DAG step (EXECUTION kind only). Ordered by
 * the I/O layer via `startedAt` (tiebreak `completedAt`, then `nodeId`) —
 * see eval-scoring-io.ts::buildScoringInputs. */
export interface ObservedTrajectoryStep {
  stepIndex: number;
  nodeId: string;
  agentId: string | null;
  status: string | null;
}

/**
 * Deterministic reconstruction of "what happened" for trajectory
 * scoring, built by eval-scoring-io.ts from the replay-package artifact
 * (`sections.nodes[]` + tool-signal findings). See module doc for the
 * evaluable/non-evaluable distinction each field feeds.
 */
export interface ObservedTrajectory {
  /** EXECUTION kind: ordered DAG steps. Empty for CONVERSATION kind (no
   * execution DAG exists) — `turnCount` is used instead for maxSteps/
   * noLoop, and `dagPath` becomes n/a. */
  steps: ObservedTrajectoryStep[];
  /** CONVERSATION kind: count of assistant messages. 0 for EXECUTION kind
   * (steps.length is used instead). */
  turnCount: number;
  /** Sorted, deduplicated set of tool names observed via
   * `tool_permitted:not_on_deny_list:{tool}` findings. Always
   * reconstructable — set membership carries no ordering requirement. */
  toolSet: string[];
  /** Ordered tool-name sequence, ONLY when finding rows carry a usable
   * order signal. `null` when no such signal exists (CIT-121 gap) — the
   * honest-gap marker that forces SUBSEQUENCE/STRICT toolSequence checks
   * to degrade to UNKNOWN rather than guess an order. */
  toolOrder: string[] | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-check result
// ─────────────────────────────────────────────────────────────────────────

type SubCheckOutcome = "pass" | "fail" | "na" | "unknown";

interface SubCheckResult {
  name: string;
  outcome: SubCheckOutcome;
}

function isExecutionKind(observed: ObservedTrajectory): boolean {
  // CONVERSATION-kind observations never populate steps[] (no DAG
  // exists) — turnCount>0 (or explicitly present) is the CONVERSATION
  // signal. steps.length===0 && turnCount===0 is treated as EXECUTION
  // with zero recorded steps (still evaluable: 0 vs maxSteps/noLoop).
  return observed.steps.length > 0 || observed.turnCount === 0;
}

function checkMaxSteps(
  observed: ObservedTrajectory,
  maxSteps: number,
): SubCheckResult {
  const count = isExecutionKind(observed)
    ? observed.steps.length
    : observed.turnCount;
  return { name: "maxSteps", outcome: count <= maxSteps ? "pass" : "fail" };
}

function checkNoLoop(observed: ObservedTrajectory): SubCheckResult {
  if (isExecutionKind(observed)) {
    const seen = new Set<string>();
    for (const step of observed.steps) {
      if (seen.has(step.nodeId)) {
        return { name: "noLoop", outcome: "fail" };
      }
      seen.add(step.nodeId);
    }
    return { name: "noLoop", outcome: "pass" };
  }
  // CONVERSATION kind: no per-turn identity signal is reconstructed here
  // (no node/agent per turn) — cannot be honestly evaluated.
  return { name: "noLoop", outcome: "unknown" };
}

function checkNoRedundantCalls(observed: ObservedTrajectory): SubCheckResult {
  if (!isExecutionKind(observed)) {
    return { name: "noRedundantCalls", outcome: "unknown" };
  }
  for (let i = 1; i < observed.steps.length; i++) {
    const prev = observed.steps[i - 1];
    const cur = observed.steps[i];
    if (prev.nodeId === cur.nodeId && prev.agentId === cur.agentId) {
      return { name: "noRedundantCalls", outcome: "fail" };
    }
  }
  return { name: "noRedundantCalls", outcome: "pass" };
}

function checkDagPath(
  observed: ObservedTrajectory,
  dagPath: string[],
): SubCheckResult {
  if (!isExecutionKind(observed) || observed.steps.length === 0) {
    // No DAG to compare against (CONVERSATION kind, or an EXECUTION
    // observation with zero recorded steps) — genuinely n/a, not a gap.
    return { name: "dagPath", outcome: "na" };
  }
  const observedPath = observed.steps.map((s) => s.nodeId);
  const equal =
    observedPath.length === dagPath.length &&
    observedPath.every((id, i) => id === dagPath[i]);
  return { name: "dagPath", outcome: equal ? "pass" : "fail" };
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (i < needle.length && item === needle[i]) i++;
  }
  return i === needle.length;
}

function checkToolSequence(
  observed: ObservedTrajectory,
  spec: ToolSequenceSpecForScoring,
): SubCheckResult {
  if (spec.mode === "SET") {
    // Set membership never requires ordering data — always evaluable.
    const observedSet = new Set(observed.toolSet);
    const pass = spec.tools.every((t) => observedSet.has(t));
    return { name: "toolSeq", outcome: pass ? "pass" : "fail" };
  }

  // SUBSEQUENCE / STRICT require an order signal. Degrade to UNKNOWN
  // (never guess) when toolOrder is unavailable — the CIT-121 honest gap.
  if (observed.toolOrder === null) {
    return { name: "toolSeq", outcome: "unknown" };
  }

  if (spec.mode === "SUBSEQUENCE") {
    return {
      name: "toolSeq",
      outcome: isSubsequence(spec.tools, observed.toolOrder) ? "pass" : "fail",
    };
  }

  // STRICT: exact order + exact length match.
  const equal =
    observed.toolOrder.length === spec.tools.length &&
    observed.toolOrder.every((t, i) => t === spec.tools[i]);
  return { name: "toolSeq", outcome: equal ? "pass" : "fail" };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

function truncateDetail(s: string): string {
  return s.length > MAX_DETAIL_LENGTH ? s.slice(0, MAX_DETAIL_LENGTH) : s;
}

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Scores the trajectory dimension for one case. PURE — see module doc.
 * `spec` undefined => NOT_APPLICABLE (case opted out of trajectory
 * assertions entirely). Otherwise each present spec sub-field contributes
 * one sub-check; the dimension is UNKNOWN overall iff at least one
 * sub-check was requested but zero were evaluable (all "na"/"unknown").
 */
export function scoreTrajectory(
  observed: ObservedTrajectory | undefined,
  spec: TrajectorySpecForScoring | undefined,
): DimensionScore {
  if (!spec) {
    return {
      dimension: "trajectory" as const,
      status: "NOT_APPLICABLE" as const,
      basis: "DETERMINISTIC" as const,
      detail: "no trajectorySpec set on case",
    };
  }

  // A spec was requested but no observation could be reconstructed at
  // all (e.g. no artifact/nodes available) — every sub-assertion is
  // unevaluable by definition. Fall through to the shared "empty
  // ObservedTrajectory" defaults so this collapses into the normal
  // evaluable-count-zero => UNKNOWN path below, rather than a special case.
  const safeObserved: ObservedTrajectory = observed ?? {
    steps: [],
    turnCount: 0,
    toolSet: [],
    toolOrder: null,
  };

  const results: SubCheckResult[] = [];
  if (typeof spec.maxSteps === "number") {
    results.push(checkMaxSteps(safeObserved, spec.maxSteps));
  }
  if (spec.noLoop === true) {
    results.push(checkNoLoop(safeObserved));
  }
  if (spec.noRedundantCalls === true) {
    results.push(checkNoRedundantCalls(safeObserved));
  }
  if (spec.dagPath && spec.dagPath.length > 0) {
    results.push(checkDagPath(safeObserved, spec.dagPath));
  }
  if (spec.toolSequence) {
    results.push(checkToolSequence(safeObserved, spec.toolSequence));
  }

  if (results.length === 0) {
    // trajectorySpec present but every sub-field absent/empty — treat
    // like "no assertions requested" (n/a), not a fabricated score.
    return {
      dimension: "trajectory" as const,
      status: "NOT_APPLICABLE" as const,
      basis: "DETERMINISTIC" as const,
      detail: "trajectorySpec present but no sub-assertions specified",
    };
  }

  const evaluable = results.filter(
    (r) => r.outcome === "pass" || r.outcome === "fail",
  );
  const passed = evaluable.filter((r) => r.outcome === "pass").length;

  const subchecks = [...results]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `${r.name}:${r.outcome}`)
    .join(",");

  if (evaluable.length === 0) {
    return {
      dimension: "trajectory" as const,
      status: "UNKNOWN" as const,
      basis: "DETERMINISTIC" as const,
      detail: truncateDetail(`subchecks=${subchecks}`),
    };
  }

  const score = round6dp(passed / evaluable.length);
  const detail = truncateDetail(
    `subchecks=${subchecks} score=${score} evaluable=${passed}/${evaluable.length}`,
  );

  return {
    dimension: "trajectory" as const,
    status: "SCORED" as const,
    basis: "DETERMINISTIC" as const,
    verdict: { kind: "score" as const, score },
    measurement: score,
    detail,
  };
}
