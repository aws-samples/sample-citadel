/**
 * eval-prod-scoring.ts (Phase 2 §2.4) — pure production-sample scoring.
 *
 * STRUCTURAL GUARANTEE against expected-answer matching: `scoreProdSample`
 * has NO expectation/case parameter in its signature at all — no eval-case
 * scoring type, no per-case expected-target field, nothing. It is
 * IMPOSSIBLE BY SIGNATURE to match a production sample against a per-case
 * expected answer, because no such answer is ever passed in. This is deliberately
 * a separate module from eval-scoring.ts (the eval-suite scorer), not a
 * mode flag on it — a flag can be misused at a call site; an absent
 * parameter cannot (pinned by
 * eval-prod-no-expected-answer.guard.test.ts + the arity assertion in
 * eval-prod-scoring.test.ts).
 *
 * Scores only the dimensions the design's allowlist permits (§2.3):
 * policy_compliance, groundedness_citation, groundedness_faithfulness,
 * trajectory, latency, cost. task_success and tool_accuracy are NEVER
 * emitted by this module — there is no case definition to check either
 * against, so those two dimensions simply do not exist in this scorer's
 * output vector at all (not merely "excluded after being computed").
 *
 * Pure — no Date.now()/Math.random()/IO, mirrors eval-scoring.ts's own
 * purity contract. All findings/trajectory/cost inputs are supplied by
 * the caller Lambda (eval-sample-scorer.ts), which reads them from the
 * SANITIZED prod-sample artifact only (never toolResults — same pinned
 * invariant as eval-scoring.ts).
 */
import type { ObservedTrajectory } from "./eval-trajectory";

export type ProdDimensionName =
  | "policy_compliance"
  | "groundedness_citation"
  | "groundedness_faithfulness"
  | "trajectory"
  | "latency"
  | "cost";

export type ProdDimensionStatus =
  "SCORED" | "UNKNOWN" | "NOT_APPLICABLE" | "PENDING";
export type ProdScoreBasis = "DETERMINISTIC" | "JUDGE";
export type ProdDimensionVerdict =
  { kind: "boolean"; pass: boolean } | { kind: "score"; score: number };

export interface ProdDimensionScore {
  dimension: ProdDimensionName;
  status: ProdDimensionStatus;
  basis: ProdScoreBasis;
  verdict?: ProdDimensionVerdict;
  measurement?: number | null;
  judgeModelId?: string;
  judgeModelVersion?: string;
  judgePromptHash?: string;
  detail: string;
}

export type ProdScoreVector = ProdDimensionScore[];

/** Fixed canonical order for the allowlisted dimensions (design §2.3). */
export const PROD_DIMENSION_ORDER: readonly ProdDimensionName[] = [
  "policy_compliance",
  "groundedness_citation",
  "groundedness_faithfulness",
  "trajectory",
  "latency",
  "cost",
];

const MAX_DETAIL_LENGTH = 1024;

function truncateDetail(s: string): string {
  return s.length > MAX_DETAIL_LENGTH ? s.slice(0, MAX_DETAIL_LENGTH) : s;
}

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Narrow view of one governance-ledger finding row — same shape as
 * ScoringFinding in eval-scoring.ts, redeclared here so this module never
 * imports anything from the case-scoped scorer (keeps the "no expectation
 * type reachable" guarantee airtight against an accidental transitive
 * import). */
export interface ProdScoringFinding {
  decision: "permit" | "deny" | "escalate" | "halt" | string;
  reason: string;
}

export interface ProdScoringCostRow {
  priced: boolean;
  usd?: number | null;
}

/** Optional, specless per-agent budget — NOT a per-case spec (design
 * §2.4: "no dagPath/toolSequence (those need a per-case spec)"). */
export interface ProdAgentProfile {
  maxSteps?: number;
}

export interface ProdObservedArtifact {
  findings: ProdScoringFinding[];
  observedTrajectory: ObservedTrajectory;
  /** True when a KB-query tool finding was observed. */
  kbConsulted: boolean;
  /** Final answer / concatenated node outputs text, used only for a
   * measurement anchor by the judge rubric — never matched here. */
  citationText: string;
  latencyMs?: number;
  costRows: ProdScoringCostRow[];
}

function scorePolicyCompliance(
  artifact: ProdObservedArtifact,
): ProdDimensionScore {
  const violating = artifact.findings.filter(
    (f) => f.decision === "deny" || f.decision === "halt",
  );
  const pass = violating.length === 0;
  const reasons = violating.map((f) => f.reason).sort();
  return {
    dimension: "policy_compliance",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "boolean", pass },
    detail: truncateDetail(
      `permitBaseline=true violations=${reasons.length} reasons=${reasons.join(",")}`,
    ),
  };
}

function scoreGroundednessCitation(
  artifact: ProdObservedArtifact,
): ProdDimensionScore {
  if (!artifact.kbConsulted) {
    return {
      dimension: "groundedness_citation",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no KB tool consulted on this sample",
    };
  }
  // Specless heuristic: a KB tool ran and produced non-empty citation
  // text — no per-case mustCiteAnyOf tokens exist for prod samples, so
  // "consulted the KB and said something" is the only honest signal.
  const pass = artifact.citationText.trim().length > 0;
  return {
    dimension: "groundedness_citation",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "boolean", pass },
    detail: truncateDetail(`kbConsulted=true nonEmptyAnswer=${pass}`),
  };
}

function scoreGroundednessFaithfulness(): ProdDimensionScore {
  // Prod samples always opt into the judge for faithfulness — there is
  // no per-case mustNotHallucinate flag to gate on (specless), and
  // hallucination risk is exactly the signal production sampling exists
  // to surface. The judge reads only the sanitized artifact (design §2.5).
  return {
    dimension: "groundedness_faithfulness",
    status: "PENDING",
    basis: "JUDGE",
    detail: "groundedness_faithfulness always judged for production samples",
  };
}

function scoreTrajectory(
  artifact: ProdObservedArtifact,
  agentProfile: ProdAgentProfile | undefined,
): ProdDimensionScore {
  const { steps } = artifact.observedTrajectory;

  if (steps.length === 0) {
    return {
      dimension: "trajectory",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "no execution steps observed (conversation kind or empty DAG)",
    };
  }

  const subchecks: string[] = [];
  let passed = 0;
  let evaluable = 0;

  // noLoop — no nodeId repeats.
  evaluable += 1;
  const nodeIds = steps.map((s) => s.nodeId);
  const noLoop = new Set(nodeIds).size === nodeIds.length;
  if (noLoop) passed += 1;
  subchecks.push(`noLoop:${noLoop ? "pass" : "fail"}`);

  // noRedundantCalls — no two consecutive steps share (nodeId, agentId).
  evaluable += 1;
  let noRedundant = true;
  for (let i = 1; i < steps.length; i++) {
    if (
      steps[i].nodeId === steps[i - 1].nodeId &&
      steps[i].agentId === steps[i - 1].agentId
    ) {
      noRedundant = false;
      break;
    }
  }
  if (noRedundant) passed += 1;
  subchecks.push(`noRedundantCalls:${noRedundant ? "pass" : "fail"}`);

  // maxSteps — only evaluable when an agentProfile budget is configured
  // (specless: no per-case maxSteps for prod samples).
  if (typeof agentProfile?.maxSteps === "number") {
    evaluable += 1;
    const withinBudget = steps.length <= agentProfile.maxSteps;
    if (withinBudget) passed += 1;
    subchecks.push(`maxSteps:${withinBudget ? "pass" : "fail"}`);
  }

  subchecks.sort();
  const score = round6dp(passed / evaluable);

  return {
    dimension: "trajectory",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "score", score },
    measurement: score,
    detail: truncateDetail(
      `subchecks=${subchecks.join(",")} score=${score} evaluable=${passed}/${evaluable}`,
    ),
  };
}

function scoreLatency(artifact: ProdObservedArtifact): ProdDimensionScore {
  if (typeof artifact.latencyMs !== "number") {
    return {
      dimension: "latency",
      status: "UNKNOWN",
      basis: "DETERMINISTIC",
      detail: "no latency measurement available for this sample",
    };
  }
  return {
    dimension: "latency",
    status: "SCORED",
    basis: "DETERMINISTIC",
    measurement: artifact.latencyMs,
    detail: truncateDetail(`measurementMs=${artifact.latencyMs}`),
  };
}

function scoreCost(artifact: ProdObservedArtifact): ProdDimensionScore {
  const rows = artifact.costRows ?? [];
  if (rows.length === 0) {
    return {
      dimension: "cost",
      status: "UNKNOWN",
      basis: "DETERMINISTIC",
      detail: "no cost ledger rows for this sample",
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
  return {
    dimension: "cost",
    status: "SCORED",
    basis: "DETERMINISTIC",
    measurement: totalUsd,
    detail: truncateDetail(`measurementUsd=${totalUsd} rows=${rows.length}`),
  };
}

/**
 * Scores one production sample. NO expectation/case parameter — see
 * module doc. `agentProfile` is optional, specless, generic per-agent
 * config (currently only `maxSteps`); it is NOT a per-case
 * trajectorySpec and must never be confused for one.
 */
export function scoreProdSample(
  artifact: ProdObservedArtifact,
  agentProfile?: ProdAgentProfile,
): ProdScoreVector {
  const vector: ProdScoreVector = [
    scorePolicyCompliance(artifact),
    scoreGroundednessCitation(artifact),
    scoreGroundednessFaithfulness(),
    scoreTrajectory(artifact, agentProfile),
    scoreLatency(artifact),
    scoreCost(artifact),
  ];
  return canonicalProdScoreVector(vector);
}

export function canonicalProdScoreVector(
  vector: ProdScoreVector,
): ProdScoreVector {
  const orderIndex = new Map<string, number>(
    PROD_DIMENSION_ORDER.map((d, i) => [d, i]),
  );
  return [...vector].sort((a, b) => {
    const ia = orderIndex.get(a.dimension) ?? PROD_DIMENSION_ORDER.length;
    const ib = orderIndex.get(b.dimension) ?? PROD_DIMENSION_ORDER.length;
    return ia - ib;
  });
}
