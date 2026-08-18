/**
 * promotion-ladder.ts — PURE ladder + monotonicity helpers for the
 * environment promotion path (dev→staging→prod).
 *
 * PURE — no I/O, no Date.now(), no Math.random(), no module-level mutable
 * state, matching release-gate.ts's own purity contract. Every function
 * here is deterministic: identical inputs always produce byte-identical
 * output, and none of them throw (failures surface as data —
 * `{ monotonic, violations }` — mirroring release-gate-evidence.ts's
 * "every failure is data" discipline).
 *
 * Two concerns, both server-enforced (never client-declared):
 *
 *  1. LADDER ADJACENCY (G1). `predecessorEnvironment(env)` names the
 *     single immediately-lower environment a promotion INTO `env` must
 *     have come from: DEV→null (entry point, unconstrained), STAGING→DEV,
 *     PROD→STAGING. The resolver reads the predecessor's CURRENT pointer
 *     and requires it to reference the same release being promoted
 *     (consensus decision 1: adjacency = "what's in staging NOW is what
 *     gets promoted to prod", NOT a history-based "was ever in staging" —
 *     the latter is a weaker guarantee, and promoting a release that has
 *     since been superseded in the lower env is a distinct ROLLBACK
 *     operation, not built here).
 *
 *  2. prod≥staging MONOTONICITY (G2). `comparePolicyStrictness(higher,
 *     lower)` decides whether a HIGHER environment's resolved
 *     PromotionPolicy is at least as strict as the immediately-LOWER
 *     one's, per-field/per-direction:
 *       - Floors RISE going up (higher ≥ lower): taskSuccessMin,
 *         policyComplianceMin, minSampleCount.
 *       - Ceilings TIGHTEN going up (higher ≤ lower): latencyP95TargetMs,
 *         avgCostBudgetUsd, maxEvidenceAgeDays.
 *       - requiredGateClasses: higher ⊇ lower (superset).
 *       - allowNoBaselineOnAbsoluteFloors: higher allowing ⇒ lower
 *         allowing (prod no looser than staging).
 *     Enforced at BOTH write-time (promotion-policy-resolver.ts, reject a
 *     non-monotonic authored ladder) AND gate-time (validateReleaseGate,
 *     fail-closed over the fully-resolved per-agent policies) — the
 *     gate-time check is authoritative because it sees per-agent
 *     overrides that could create an inversion after the write-time
 *     check.
 */
import type { EnvironmentLiteral } from "../../types";
import type { PromotionPolicy } from "./release-gate";

/** The promotion ladder, lowest→highest. Index position IS the strictness
 * ordering: a higher index must run under a policy at least as strict as
 * every lower index (comparePolicyStrictness). */
export const ENVIRONMENT_ORDER: readonly EnvironmentLiteral[] = [
  "DEV",
  "STAGING",
  "PROD",
] as const;

/**
 * The single immediately-lower environment a promotion INTO `environment`
 * must originate from, or null for the ladder's entry point (DEV).
 *
 * Total over EnvironmentLiteral and acyclic by construction (it only ever
 * returns an environment strictly lower in ENVIRONMENT_ORDER, or null).
 */
export function predecessorEnvironment(
  environment: EnvironmentLiteral,
): EnvironmentLiteral | null {
  const index = ENVIRONMENT_ORDER.indexOf(environment);
  if (index <= 0) return null;
  return ENVIRONMENT_ORDER[index - 1];
}

/** A single monotonicity violation between a higher and a lower env's
 * resolved policy — machine-readable field + human-readable direction. */
export interface PolicyStrictnessViolation {
  field: keyof PromotionPolicy;
  reason: string;
}

export interface PolicyStrictnessComparison {
  monotonic: boolean;
  violations: PolicyStrictnessViolation[];
}

/** Fields whose FLOOR must rise (or hold) going up the ladder:
 * higher ≥ lower. */
const RISING_FLOOR_FIELDS = [
  "taskSuccessMin",
  "policyComplianceMin",
  "minSampleCount",
] as const;

/** Fields whose CEILING must tighten (or hold) going up the ladder:
 * higher ≤ lower. */
const TIGHTENING_CEILING_FIELDS = [
  "latencyP95TargetMs",
  "avgCostBudgetUsd",
  "maxEvidenceAgeDays",
] as const;

/**
 * Whether `higher`'s policy is at least as strict as `lower`'s, per field
 * and direction (see module doc for the full field/direction table).
 * Never throws — returns every violating field so the caller (write-time
 * reject or gate-time fail-closed) can report all of them at once.
 *
 * `higher` is the higher-in-ladder environment (e.g. PROD) and `lower`
 * the immediately-lower one (e.g. STAGING). The comparison is intended
 * for adjacent pairs but is well-defined for any two policies.
 */
export function comparePolicyStrictness(
  higher: PromotionPolicy,
  lower: PromotionPolicy,
): PolicyStrictnessComparison {
  const violations: PolicyStrictnessViolation[] = [];

  for (const field of RISING_FLOOR_FIELDS) {
    if (higher[field] < lower[field]) {
      violations.push({
        field,
        reason: `${field} floor must not decrease going up the ladder (higher=${higher[field]} < lower=${lower[field]})`,
      });
    }
  }

  for (const field of TIGHTENING_CEILING_FIELDS) {
    if (higher[field] > lower[field]) {
      violations.push({
        field,
        reason: `${field} ceiling must not increase going up the ladder (higher=${higher[field]} > lower=${lower[field]})`,
      });
    }
  }

  // requiredGateClasses: higher must be a SUPERSET of lower — every pack
  // required lower must also be required higher (more packs required as
  // you climb, never fewer).
  const higherPacks = new Set(higher.requiredGateClasses);
  for (const pack of lower.requiredGateClasses) {
    if (!higherPacks.has(pack)) {
      violations.push({
        field: "requiredGateClasses",
        reason: `requiredGateClasses must be a superset going up the ladder (lower requires "${pack}", higher does not)`,
      });
    }
  }

  // allowNoBaselineOnAbsoluteFloors: prod must be NO LOOSER than staging.
  // A violation is: higher allows the no-baseline bootstrap but lower
  // does not (higher looser than lower).
  if (
    higher.allowNoBaselineOnAbsoluteFloors &&
    !lower.allowNoBaselineOnAbsoluteFloors
  ) {
    violations.push({
      field: "allowNoBaselineOnAbsoluteFloors",
      reason:
        "allowNoBaselineOnAbsoluteFloors must not be enabled higher up the ladder while disabled lower down (higher looser than lower)",
    });
  }

  return { monotonic: violations.length === 0, violations };
}
