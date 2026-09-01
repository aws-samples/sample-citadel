/**
 * Rail 6 — IAM privilege-equivalence.
 *
 * For every moved resolver-Lambda (satellite construct), the normalized
 * policy statements of its execution role must be a subset-or-equal of the
 * same Lambda's baseline backend-role statements, OR match a per-Lambda
 * allowed-added statement (CIT-125 slice A: the new sqs:SendMessage grant
 * on that satellite's shared per-stack async DLQ, keyed by satellite
 * logical ID in move-manifest.ts's ALLOWED_SATELLITE_ADDED_STATEMENTS).
 * Prevents a hand-authored satellite role from silently broadening
 * privilege (new Action, widened Resource) relative to what backend
 * granted, beyond what's explicitly allowlisted.
 *
 * The manifest is name-mapped (baseline Lambda logical ID -> satellite
 * Lambda logical ID) because recreate-in-satellite drops functionName
 * pinning, so logical IDs differ across stacks by design. In this no-move
 * stage the manifest is empty — the rail passes trivially, proven by the
 * "empty moved set" run recorded in the summary.
 */
import { NormalizedPolicyStatement, StackBaseline } from "../types";
import { RailResult, RailViolation } from "../types";

export interface MovedLambdaMapping {
  /** Logical ID of the Lambda in the (pre-split) backend baseline. */
  baselineLogicalId: string;
  /** Logical ID of the equivalent Lambda in the satellite stack. */
  satelliteLogicalId: string;
  /** Stack name the satellite Lambda lives in (for error messages). */
  satelliteStackName: string;
}

/**
 * A statement `a` is "covered by" statement `b` when a's actions are a
 * subset of b's actions and a's resources are a subset of b's resources.
 * This is deliberately conservative — it does not attempt semantic IAM
 * evaluation (wildcard expansion, condition operator semantics).
 */
function isCoveredByAny(
  statement: NormalizedPolicyStatement,
  candidates: NormalizedPolicyStatement[],
): boolean {
  return candidates.some((c) => {
    if (c.effect !== statement.effect) return false;
    const actionsSubset = statement.actions.every((a) => c.actions.includes(a));
    const resourcesSubset = statement.resources.every((r) =>
      c.resources.includes(r),
    );
    return actionsSubset && resourcesSubset;
  });
}

export function runIamEquivalence(
  baseline: StackBaseline,
  satelliteLambdaPolicies: Record<
    string /* satelliteLogicalId */,
    NormalizedPolicyStatement[]
  >,
  manifest: MovedLambdaMapping[],
  allowedAddedStatements: Record<
    string /* satelliteLogicalId */,
    NormalizedPolicyStatement[]
  > = {},
): RailResult {
  const violations: RailViolation[] = [];

  for (const mapping of manifest) {
    const baselineStatements =
      baseline.lambdaRolePolicies[mapping.baselineLogicalId];
    if (!baselineStatements) {
      violations.push({
        rail: "rail6",
        logicalId: mapping.baselineLogicalId,
        message: `No baseline policy recorded for Lambda "${mapping.baselineLogicalId}" — cannot verify equivalence for satellite Lambda "${mapping.satelliteLogicalId}" in ${mapping.satelliteStackName}.`,
      });
      continue;
    }
    const satelliteStatements =
      satelliteLambdaPolicies[mapping.satelliteLogicalId] ?? [];
    // CIT-125 slice A: a moved consumer's new sqs:SendMessage grant on its
    // stack's shared async DLQ is a deliberate, justified broadening —
    // covered here per satellite logical ID (move-manifest.ts's
    // ALLOWED_SATELLITE_ADDED_STATEMENTS), not against the baseline. Any
    // OTHER broadening still violates (guarantee preserved).
    const allowedForThisLambda =
      allowedAddedStatements[mapping.satelliteLogicalId] ?? [];

    for (const stmt of satelliteStatements) {
      const covered =
        isCoveredByAny(stmt, baselineStatements) ||
        isCoveredByAny(stmt, allowedForThisLambda);
      if (!covered) {
        violations.push({
          rail: "rail6",
          logicalId: mapping.satelliteLogicalId,
          message:
            `Satellite Lambda "${mapping.satelliteLogicalId}" in ${mapping.satelliteStackName} ` +
            `has a policy statement not covered by the baseline role for "${mapping.baselineLogicalId}": ` +
            `actions=[${stmt.actions.join(",")}] resources=[${stmt.resources.join(",")}].`,
        });
      }
    }
  }

  return {
    rail: "rail6",
    name: "IAM privilege-equivalence",
    passed: violations.length === 0,
    violations,
  };
}
