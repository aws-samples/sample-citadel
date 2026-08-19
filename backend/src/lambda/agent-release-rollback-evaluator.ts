/**
 * agent-release-rollback-evaluator.ts — scheduled Lambda (decision D2:
 * scheduled 1-minute poll ONLY in v1; no SNS/alarm subscription). Mirrors
 * cost-budget-evaluator.ts's structure: a top loop that NEVER throws
 * (per-canary failure isolation, console.error + continue), plus a thin
 * handler.
 *
 * Flow per run:
 *  1. Enumerate active canaries via the sparse ActiveCanaryIndex GSI
 *     (queryActiveCanaries — never a Scan, decision D8).
 *  2. For each, resolve the per-(org,agent,env) RollbackPolicy from the
 *     promotion-policy row (decision D1). Skip on UNREADABLE (fail-safe:
 *     an untrustworthy policy never triggers a mutation) or disabled.
 *  3. Read the candidate arm's metrics over the policy window from the
 *     cost ledger (decision D3 — only cost-per-invocation + model-call
 *     latency are per-arm attributable today; the rest are null and never
 *     trigger).
 *  4. Evaluate (pure). Missing/thin data → INSUFFICIENT_DATA → no action.
 *  5. On a positive breach, perform AUTO_ABORT_CANARY (decision D4 — the
 *     ONLY auto action in v1: zero the candidate, leave the human-promoted
 *     stable untouched, so it can never cross the floor). Exactly-once is
 *     guaranteed at the store's version-gated write boundary: two
 *     concurrent evaluators both read version V, both attempt the write
 *     with expectedVersion=V, DynamoDB lets EXACTLY ONE succeed; the loser
 *     gets ConcurrentPromotionError and no-ops.
 *  6. AFTER the committed move, write the write-once finding (decision D6).
 *     A finding-write failure does NOT roll back the move (the move + its
 *     gap-free history row are the atomic legal record); instead it emits
 *     an alarmable CloudWatch error metric so a committed-but-unrecorded
 *     rollback pages rather than passing silently, and the deterministic
 *     finding id lets a later run backfill it idempotently.
 *  7. Best-effort emit the governance notification (never blocking).
 *
 * ORDERING (durable-before-notification): capture evidence → version-gated
 * move (the commit) → finding → best-effort emit. The finding must FOLLOW
 * the committed move — writing it first would risk recording a rollback
 * that lost the race.
 */
import { emitGovernanceEvent } from "../utils/notifier-base";
import {
  ConcurrentPromotionError,
  performAutoAbortCanary,
  queryActiveCanaries,
} from "./environment-release-pointer-store";
import { resolveRollbackPolicy } from "./utils/promotion-policy-store";
import { readCandidateArmMetrics } from "./utils/rollback-metrics-reader";
import { evaluateRollback } from "./utils/rollback-policy";
import {
  writeAutoRollbackFinding,
  type RollbackEvidence,
} from "./utils/auto-rollback-finding-writer";
import type { EnvironmentReleasePointer } from "../types";

interface EvaluateOptions {
  now?: Date;
}

function windowBounds(
  now: Date,
  windowMinutes: number,
): {
  windowStart: string;
  windowEnd: string;
} {
  const windowEnd = now.toISOString();
  const windowStart = new Date(
    now.getTime() - windowMinutes * 60_000,
  ).toISOString();
  return { windowStart, windowEnd };
}

/** Emit an alarmable CloudWatch metric (EMF) when a post-commit finding
 * write fails (decision D6). The auto-rollback move is already committed +
 * audited by its gap-free history row; the finding is the analyst-facing
 * evidence, so its absence must be LOUD, not silent. CDK defines an alarm
 * on this metric. */
function emitFindingWriteFailureMetric(): void {
  const environment = process.env.ENVIRONMENT ?? "unknown";
  // EMF envelope — CloudWatch auto-extracts the metric from the log group.
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "Citadel/Governance",
            Dimensions: [["Environment"]],
            Metrics: [
              { Name: "AutoRollbackFindingWriteFailure", Unit: "Count" },
            ],
          },
        ],
      },
      Environment: environment,
      AutoRollbackFindingWriteFailure: 1,
    }),
  );
}

async function evaluateOneCanary(
  pointer: EnvironmentReleasePointer,
  now: Date,
): Promise<void> {
  const { orgId, agentTargetId, environment, canary } = pointer;
  if (!canary) return; // defensive — the sparse GSI should preclude this

  const policyResolution = await resolveRollbackPolicy(
    orgId,
    agentTargetId,
    environment,
  );
  // Fail-safe: an UNREADABLE policy never triggers a mutation.
  if (!policyResolution.ok) {
    console.error(
      "agent-release-rollback-evaluator: rollback policy UNREADABLE — skipping (fail-safe, no auto-rollback)",
      { orgId, agentTargetId, environment },
    );
    return;
  }
  const policy = policyResolution.policy;
  if (!policy.enabled) return; // opt-in kill switch off

  const { windowStart, windowEnd } = windowBounds(
    now,
    policy.evaluationWindowMinutes,
  );
  const metrics = await readCandidateArmMetrics(
    orgId,
    canary.candidateReleaseId,
    windowStart,
    windowEnd,
  );

  const evaluation = evaluateRollback(metrics, policy);
  if (!evaluation.shouldRollback) return;

  // v1 action is AUTO_ABORT_CANARY only (decision D4): zero the candidate,
  // stable releaseId unchanged. This is the safe subset for any policy
  // action (a breaching canary is stopped) and can never cross the floor,
  // so no floor read is required for the abort path.
  const fromVersion = pointer.version;
  const stableReleaseId = pointer.releaseId;

  let moved: EnvironmentReleasePointer;
  try {
    moved = await performAutoAbortCanary({
      orgId,
      agentTargetId,
      environment,
      releaseId: stableReleaseId,
      expectedVersion: fromVersion,
    });
  } catch (err: unknown) {
    if (err instanceof ConcurrentPromotionError) {
      // Another evaluator or a human moved the pointer first — exactly-once
      // is satisfied at the write boundary; this run no-ops.
      console.error(
        "agent-release-rollback-evaluator: lost the version race — another mover won, no-op",
        { orgId, agentTargetId, environment },
      );
      return;
    }
    throw err;
  }

  const evidence: RollbackEvidence = {
    metric: evaluation.breachedMetric,
    arm: "candidate",
    observedValue: evaluation.observedValue,
    threshold: evaluation.threshold,
    sampleCount: evaluation.sampleCount,
    windowStart,
    windowEnd,
    candidateReleaseId: canary.candidateReleaseId,
    stableReleaseId,
    fromReleaseId: stableReleaseId,
    toReleaseId: moved.releaseId, // unchanged for an abort (stable stays)
    action: "AUTO_ABORT_CANARY",
    fromVersion,
  };

  // Post-commit finding write (D6). A failure here does NOT roll back the
  // committed move — emit an alarmable metric + log, and rely on the
  // deterministic finding id for idempotent backfill on a later run.
  try {
    await writeAutoRollbackFinding({
      orgId,
      agentTargetId,
      environment,
      fromVersion,
      action: "AUTO_ABORT_CANARY",
      evidence,
    });
  } catch (err: unknown) {
    emitFindingWriteFailureMetric();
    console.error(
      "agent-release-rollback-evaluator: post-commit finding write FAILED — move is committed + audited via history; emitted alarmable metric, will backfill on a later run",
      {
        orgId,
        agentTargetId,
        environment,
        fromVersion,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Best-effort governance notification (never blocking).
  try {
    await emitGovernanceEvent("governance.release.auto_rollback", {
      orgId,
      agentTargetId,
      environment,
      action: "AUTO_ABORT_CANARY",
      metric: evaluation.breachedMetric,
      observedValue: evaluation.observedValue,
      threshold: evaluation.threshold,
      sampleCount: evaluation.sampleCount,
      fromReleaseId: stableReleaseId,
      toReleaseId: moved.releaseId,
      candidateReleaseId: canary.candidateReleaseId,
      fromVersion,
    });
  } catch (err: unknown) {
    console.error(
      "agent-release-rollback-evaluator: best-effort auto_rollback notification failed — move + finding already durable, continuing",
      {
        orgId,
        agentTargetId,
        environment,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Evaluates every active canary. Never throws out of this function — a
 * single canary's failure is logged and the remaining canaries are still
 * evaluated (failure isolation, matching cost-budget-evaluator.ts).
 */
export async function evaluateRollbacks(
  options: EvaluateOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const canaries = await queryActiveCanaries();

  for (const pointer of canaries) {
    try {
      await evaluateOneCanary(pointer, now);
    } catch (err: unknown) {
      console.error(
        "agent-release-rollback-evaluator: failed to evaluate one canary, continuing with the rest",
        {
          orgId: pointer.orgId,
          agentTargetId: pointer.agentTargetId,
          environment: pointer.environment,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

export const handler = async (): Promise<void> => {
  await evaluateRollbacks();
};
