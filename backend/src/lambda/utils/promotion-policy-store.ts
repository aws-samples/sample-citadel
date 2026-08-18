/**
 * promotion-policy-store.ts — per-org PromotionPolicy config (decision
 * ada70113: promotion policy becomes per-org config), cloning the
 * eval-sampling-config.ts convention: a single, dependency-light READ
 * module the promotion gate consumes, admin-authored via a separate
 * resolver (promotion-policy-resolver.ts).
 *
 * Table: PROMOTION_POLICY_CONFIG_TABLE, PK=orgId. One row per org:
 *   { orgId, policy: Partial<PromotionPolicy>,
 *     perAgentPolicyOverrides: Record<agentTargetId, Partial<PromotionPolicy>>,
 *     updatedAt, updatedBy }
 *
 * Resolution order (field-level merge, NOT whole-object replace):
 *   DEFAULT_PROMOTION_POLICY  <-  row.policy  <-  row.perAgentPolicyOverrides[agentTargetId]
 * Each PromotionPolicy field is taken from the highest-precedence source
 * that actually supplies it (and passes the per-field sanity check below);
 * a field a higher-precedence source omits, or supplies invalid, falls
 * through to the next-lower source rather than blanking the whole
 * object — mirrors release-gate-evidence.ts's "every failure is data"
 * discipline applied at the individual-field level instead of the
 * whole-resolution level.
 *
 * Fail-closed contract, matching eval-sampling-config.ts's
 * getEvalSamplingConfig AND release-gate-evidence.ts's UNREADABLE_RECORD
 * discipline simultaneously:
 *   - Absent row -> ok:true with DEFAULT_PROMOTION_POLICY (no config
 *     authored yet is NOT a failure — same "opt-in gate" precedent as
 *     eval-sampling-config.ts's absent-config-is-not-an-error stance,
 *     applied here to policy floors instead of a sampling opt-in flag).
 *   - Thrown GetItem (SDK error) -> ok:false, reason:'UNREADABLE'. A
 *     transient DynamoDB error must never silently fall back to
 *     DEFAULT_PROMOTION_POLICY, because that would let an org-tightened
 *     policy (e.g. a stricter taskSuccessMin) get silently bypassed by
 *     an infrastructure blip — the opposite failure mode from
 *     eval-sampling-config's "fail closed toward NOT sampling", but the
 *     same "never treat an unreadable governance record as safe to
 *     ignore" doctrine as release-gate-evidence.ts.
 *   - Schema-invalid row (orgId missing/wrong type, policy/
 *     perAgentPolicyOverrides present but not a plain object) -> ok:false,
 *     reason:'UNREADABLE'. A malformed governance record is
 *     indistinguishable, for fail-closed purposes, from an unreadable one.
 *   - A malformed INDIVIDUAL field inside policy/perAgentPolicyOverrides
 *     whose PRIMITIVE TYPE is wrong (e.g. a string where PromotionPolicy
 *     declares a number, or vice versa) is treated as schema-invalid for
 *     the WHOLE ROW -> ok:false, reason:'UNREADABLE'. A present field of
 *     the wrong primitive type is indistinguishable, for fail-closed
 *     purposes, from a malformed policy/perAgentPolicyOverrides container:
 *     both mean the record cannot be trusted to represent the org's
 *     intended policy, so silently falling through to
 *     DEFAULT_PROMOTION_POLICY for that field would risk bypassing a
 *     tightened org floor (e.g. taskSuccessMin: "0.99" as a string must
 *     refuse, not silently resolve to the default 0.9).
 *   - A field that IS the correct primitive type but fails its
 *     RANGE/sanity floor (NaN, negative where nonsensical, out-of-[0,1]
 *     for a rate) does NOT fail the whole resolution — it is dropped from
 *     that source and the merge falls through to the next-lower-
 *     precedence source for that field only. This is deliberately
 *     narrower than the whole-row UNREADABLE case: a single
 *     out-of-range-but-correctly-typed numeric in an otherwise-valid
 *     per-agent override must not blank the entire org policy — only a
 *     type mismatch does.
 *
 * Never re-implements PromotionPolicy's own numeric semantics — every
 * sanity floor here (0..1 for rate-like fields, >=0 for
 * ms/usd/count-like fields, non-negative integer array length is
 * trivially satisfied by `string[]`) mirrors the field comments on
 * PromotionPolicy (release-gate.ts) exactly.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_PROMOTION_POLICY, type PromotionPolicy } from "./release-gate";
import type { EnvironmentLiteral } from "../../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function promotionPolicyConfigTable(): string {
  return process.env.PROMOTION_POLICY_CONFIG_TABLE!;
}

export interface PromotionPolicyConfigRow {
  orgId: string;
  policy?: Partial<PromotionPolicy>;
  perAgentPolicyOverrides?: Record<string, Partial<PromotionPolicy>>;
  // G2 (per-target-env thresholds + prod≥staging monotonicity): a
  // Partial<PromotionPolicy> keyed by DeploymentEnvironment. Layered as
  // the HIGHEST-precedence source when resolvePromotionPolicy is called
  // with an `environment` (see below) — the target-env floor is the most
  // authoritative when gating a promotion INTO that env. Same shape and
  // same field-level fail-closed discipline as perAgentPolicyOverrides.
  perEnvironmentPolicyOverrides?: Record<string, Partial<PromotionPolicy>>;
  updatedAt?: string;
  updatedBy?: string;
}

export type PromotionPolicyResolutionFailureReason = "UNREADABLE";

export type PromotionPolicyResolutionResult =
  | { ok: true; policy: PromotionPolicy }
  | { ok: false; reason: PromotionPolicyResolutionFailureReason };

// ─────────────────────────────────────────────────────────────────────────
// Per-field sanity floors — mirrors PromotionPolicy's own doc comments
// (release-gate.ts). A field failing its floor is treated as ABSENT from
// that source (falls through to the next-lower-precedence source), never
// as a whole-row failure.
// ─────────────────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Rate-like fields: must resolve within [0,1]. */
function isSaneRate(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

/** Non-negative magnitude fields (ms/usd/count) — no sensible upper
 * bound to enforce here (policy authors may legitimately set a very
 * high budget/threshold), but negative or NaN is never sane. */
function isSaneNonNegative(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

/** Basis-points fields: integer-ish within [0,10000]. */
function isSaneBasisPoints(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 10000;
}

function isSaneStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isSaneBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** Field-by-field validators, keyed exactly to PromotionPolicy's own
 * field set — adding a field to PromotionPolicy without adding a floor
 * here is a compile error via the Record<keyof PromotionPolicy, ...>
 * constraint below. */
const FIELD_VALIDATORS: {
  [K in keyof PromotionPolicy]: (v: unknown) => v is PromotionPolicy[K];
} = {
  taskSuccessMin: isSaneRate,
  policyComplianceMin: isSaneRate,
  latencyP95TargetMs: isSaneNonNegative,
  avgCostBudgetUsd: isSaneNonNegative,
  minSampleCount: isSaneNonNegative,
  requiredGateClasses: isSaneStringArray,
  maxEvidenceAgeDays: isSaneNonNegative,
  allowNoBaselineOnAbsoluteFloors: isSaneBoolean,
  canaryMaxBasisPoints: isSaneBasisPoints,
};

/**
 * Primitive-TYPE-only checks (no range/sanity floor) — used to
 * distinguish "wrong primitive type" (whole-row UNREADABLE) from
 * "correct type but out of range" (per-field drop, handled by
 * FIELD_VALIDATORS/mergePolicyFields). Deliberately permissive on
 * range: `typeof v === "number"` accepts NaN/negative/out-of-[0,1] —
 * those are exactly the values FIELD_VALIDATORS is meant to catch and
 * drop per-field, not fail the whole row over.
 */
const FIELD_TYPE_GUARDS: {
  [K in keyof PromotionPolicy]: (v: unknown) => boolean;
} = {
  taskSuccessMin: (v) => typeof v === "number",
  policyComplianceMin: (v) => typeof v === "number",
  latencyP95TargetMs: (v) => typeof v === "number",
  avgCostBudgetUsd: (v) => typeof v === "number",
  minSampleCount: (v) => typeof v === "number",
  requiredGateClasses: (v) =>
    Array.isArray(v) && v.every((x) => typeof x === "string"),
  maxEvidenceAgeDays: (v) => typeof v === "number",
  allowNoBaselineOnAbsoluteFloors: (v) => typeof v === "boolean",
  canaryMaxBasisPoints: (v) => typeof v === "number",
};

const POLICY_FIELDS = Object.keys(
  FIELD_VALIDATORS,
) as (keyof PromotionPolicy)[];

/**
 * Scans a single Partial<PromotionPolicy>-shaped container (row.policy,
 * or one entry of row.perAgentPolicyOverrides) for any PRESENT field
 * whose primitive type is wrong. Range-only problems (NaN, negative,
 * out-of-[0,1]) are NOT flagged here — those pass their type guard and
 * are left for mergePolicyFields' per-field drop.
 */
function hasWrongTypeField(container: Record<string, unknown>): boolean {
  for (const field of POLICY_FIELDS) {
    const value = container[field];
    if (value === undefined) continue;
    const typeGuard = FIELD_TYPE_GUARDS[field];
    if (!typeGuard(value)) return true;
  }
  return false;
}

/**
 * Field-level merge: for each PromotionPolicy field, take the
 * highest-precedence source (later entries in `sources` win) that both
 * supplies the field (not undefined) AND passes its sanity floor.
 * Sources earlier in the array are lower precedence — pass
 * [floor, org, agent] in that order.
 */
function mergePolicyFields(
  sources: (Partial<PromotionPolicy> | undefined)[],
): PromotionPolicy {
  const result = { ...DEFAULT_PROMOTION_POLICY };
  for (const field of POLICY_FIELDS) {
    const validate = FIELD_VALIDATORS[field];
    for (const source of sources) {
      if (!source) continue;
      const candidate = source[field];
      if (candidate === undefined) continue;
      if (validate(candidate as never)) {
        (result as Record<string, unknown>)[field] = candidate;
      }
      // An invalid candidate is dropped (falls through to the next
      // source in iteration order); it never throws and never blanks
      // a previously-resolved value from a lower-precedence source
      // that already landed in `result`.
    }
  }
  return result;
}

/** Loose type guard for "is this a plain, non-array object" — used to
 * distinguish a genuinely malformed `policy`/`perAgentPolicyOverrides`
 * shape (schema-invalid row -> UNREADABLE) from a merely-absent one
 * (fine, defaults apply). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pure: the AGENTLESS per-environment BASE policy (DEFAULT ← org policy ←
 * that environment's override). No I/O, no per-agent layer — used by the
 * admin write-time prod≥staging monotonicity check
 * (promotion-policy-resolver.ts). Reuses the SAME field-level merge (with
 * per-field sanity floors) as resolvePromotionPolicy so the two never
 * diverge.
 */
export function resolveBaseEnvironmentPolicy(
  policy: Partial<PromotionPolicy> | undefined,
  environmentOverride: Partial<PromotionPolicy> | undefined,
): PromotionPolicy {
  return mergePolicyFields([policy, environmentOverride]);
}

/**
 * Validates the overall row SHAPE (not individual field RANGES — those
 * are validated per-field during merge, see mergePolicyFields). Returns
 * false for anything that would make the row untrustworthy to merge:
 * missing/wrong-typed orgId, a present-but-non-object
 * policy/perAgentPolicyOverrides container, OR any present field inside
 * policy/perAgentPolicyOverrides[*] whose PRIMITIVE TYPE is wrong (see
 * hasWrongTypeField — range-only problems are NOT shape violations and
 * do not reach this function's false branch).
 */
function isReadableRow(row: unknown): row is PromotionPolicyConfigRow {
  if (!isPlainObject(row)) return false;
  if (typeof row.orgId !== "string" || !row.orgId) return false;
  if (row.policy !== undefined) {
    if (!isPlainObject(row.policy)) return false;
    if (hasWrongTypeField(row.policy)) return false;
  }
  if (row.perAgentPolicyOverrides !== undefined) {
    if (!isPlainObject(row.perAgentPolicyOverrides)) return false;
    for (const override of Object.values(row.perAgentPolicyOverrides)) {
      if (!isPlainObject(override)) return false;
      if (hasWrongTypeField(override)) return false;
    }
  }
  if (row.perEnvironmentPolicyOverrides !== undefined) {
    if (!isPlainObject(row.perEnvironmentPolicyOverrides)) return false;
    for (const override of Object.values(row.perEnvironmentPolicyOverrides)) {
      if (!isPlainObject(override)) return false;
      if (hasWrongTypeField(override)) return false;
    }
  }
  return true;
}

async function getPromotionPolicyConfigRow(
  orgId: string,
): Promise<PromotionPolicyConfigRow | undefined> {
  const res = await docClient.send(
    new GetCommand({
      TableName: promotionPolicyConfigTable(),
      Key: { orgId },
    }),
  );
  return res.Item as PromotionPolicyConfigRow | undefined;
}

/**
 * Resolves the effective PromotionPolicy for (orgId, agentTargetId) —
 * optionally scoped to a target `environment` (G2).
 *
 * Precedence (low→high, field-level merge):
 *   DEFAULT ← row.policy ← perAgentPolicyOverrides[agent]
 *           ← perEnvironmentPolicyOverrides[environment]
 * The per-env override is layered LAST (highest precedence) and only
 * when an `environment` is supplied — the target-env floor is the most
 * authoritative when gating a promotion INTO that env. Omitting
 * `environment` reproduces the pre-G2 behaviour exactly (DEFAULT ← org ←
 * agent), so callers that don't need env-scoping are undisturbed.
 *
 * ok:true, policy=DEFAULT_PROMOTION_POLICY  — no config row exists yet.
 * ok:true, policy=<merged>                  — row exists and is readable;
 *   field-level merge, invalid/missing individual fields fall through
 *   rather than failing the whole resolution.
 * ok:false, reason:'UNREADABLE'              — thrown GetItem, or a
 *   schema-invalid row (missing/wrong-typed orgId, a non-object
 *   policy/perAgentPolicyOverrides/perEnvironmentPolicyOverrides
 *   container, or any present field inside any of those with the wrong
 *   PRIMITIVE TYPE). Callers MUST treat this as fail-closed — never
 *   substitute DEFAULT_PROMOTION_POLICY on this branch (that would
 *   silently downgrade an org's tightened policy).
 */
export async function resolvePromotionPolicy(
  orgId: string,
  agentTargetId: string,
  environment?: EnvironmentLiteral,
): Promise<PromotionPolicyResolutionResult> {
  let row: PromotionPolicyConfigRow | undefined;
  try {
    row = await getPromotionPolicyConfigRow(orgId);
  } catch (err: unknown) {
    console.error(
      "promotion-policy-store: resolvePromotionPolicy GetItem failed — resolving to UNREADABLE (fail-closed, never falls back to defaults)",
      {
        orgId,
        agentTargetId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { ok: false, reason: "UNREADABLE" };
  }

  if (row === undefined) {
    return { ok: true, policy: { ...DEFAULT_PROMOTION_POLICY } };
  }

  if (!isReadableRow(row)) {
    console.error(
      "promotion-policy-store: resolvePromotionPolicy encountered a schema-invalid row — resolving to UNREADABLE",
      { orgId, agentTargetId },
    );
    return { ok: false, reason: "UNREADABLE" };
  }

  const agentOverride = row.perAgentPolicyOverrides?.[agentTargetId];
  const envOverride =
    environment !== undefined
      ? row.perEnvironmentPolicyOverrides?.[environment]
      : undefined;
  // Precedence low→high: DEFAULT (baked into mergePolicyFields) ← org ←
  // per-agent ← per-environment. envOverride is undefined when no
  // environment was supplied, preserving the pre-G2 merge exactly.
  const merged = mergePolicyFields([row.policy, agentOverride, envOverride]);
  return { ok: true, policy: merged };
}
