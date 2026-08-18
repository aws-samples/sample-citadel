/**
 * canary-assignment.ts — PURE deterministic canary arm assignment.
 *
 * PURE — no I/O, no `Date.now()`, no `Math.random()`, no module-level
 * mutable state, matching promotion-ladder.ts / release-gate.ts's own
 * purity contract. `assignArm` is deterministic and TOTAL: identical
 * inputs always produce byte-identical output, and it never throws (the
 * percent is clamped to [0,10000]; an empty stickiness key resolves
 * deterministically to the stable arm so an unreachable key can never
 * silently land everyone on the candidate).
 *
 * Ported byte-for-byte (the marked region) to the Python arbiter tier in
 * arbiter/governance/canary_assignment.py's `assign_arm`, exactly the
 * `is_grandfathered_pure` precedent — the two implementations MUST always
 * agree given the same three arguments. The cross-runtime parity guard
 * (canary-assignment-parity-cases.json + the two parity suites) fails if
 * either side's marked logic region drifts from the recorded sha256.
 *
 * The assignment is the crux of canary stickiness (decision D3,
 * stable-salt-recompute, NO pin store):
 *   - The salt is minted ONCE at canary start and PRESERVED verbatim
 *     across every reweight (cleared only on promote/abort). Because the
 *     salt — hence every key's bucket — is invariant across a reweight,
 *     re-hashing on reweight does NOT reassign existing conversations;
 *     only the threshold `percentBasisPoints` moves. A key's bucket is
 *     fixed; whether it sits below the threshold changes only if the
 *     threshold crosses that fixed bucket (a one-way delta-band move).
 *   - Steady state (percent constant) never flaps: the arm is a pure
 *     function of a fixed (key, salt, percent), recomputed identically on
 *     every turn.
 *
 * basisPoints, not a float percent: bucketing is exact-integer over
 * [0,10000) so there is no float drift at the threshold boundary.
 */
import { createHash } from "crypto";

/** The two canary arms. `stable` is the current pointer.releaseId (the
 * source of truth); `candidate` is canary.candidateReleaseId (arm B). */
export type CanaryArm = "stable" | "candidate";

/** The uniform bucket space. A key hashes into [0, BUCKET_SPACE); the
 * arm is `candidate` when its bucket is strictly below the threshold
 * `percentBasisPoints` (also expressed in [0,10000]). */
export const CANARY_BUCKET_SPACE = 10000;

/**
 * Deterministically assign a stickiness key to the `stable` or
 * `candidate` arm.
 *
 * digest  = sha256(utf8(salt + ":" + stickinessKey))
 * bucket  = int(first 8 hex chars of digest, base 16) mod 10000
 * arm     = "candidate" if bucket < clampedPercentBasisPoints else "stable"
 *
 * Uniformity/acceptance: for `percentBasisPoints = 1000` (10%),
 * P(candidate) ≈ 0.10 over well-distributed keys, so "~10% of NEW
 * conversations route to the candidate" holds deterministically.
 *
 * Totality:
 *   - `percentBasisPoints` is clamped to the closed range [0,10000] and
 *     floored to an integer, so a caller passing a negative, oversized,
 *     or fractional value can never produce an out-of-range threshold.
 *     0 ⇒ always stable; 10000 ⇒ always candidate.
 *   - An empty stickiness key resolves to `stable` (never candidate), so
 *     a choke point that failed to thread a key degrades to the safe
 *     stable arm rather than silently routing everyone to the candidate.
 */
export function assignArm(
  stickinessKey: string,
  percentBasisPoints: number,
  salt: string,
): CanaryArm {
  // PARITY-GUARD:BEGIN — mirrored verbatim in
  // arbiter/governance/canary_assignment.py's assign_arm. If you change the
  // logic between these markers, you MUST update BOTH implementations AND
  // recompute the sha256 in
  // backend/src/lambda/utils/canary-assignment-parity-cases.json
  // (regionHashes.ts and regionHashes.python), or the parity guard test
  // will fail.
  const clamped = Math.max(
    0,
    Math.min(CANARY_BUCKET_SPACE, Math.floor(percentBasisPoints)),
  );
  if (clamped <= 0) return "stable";
  if (clamped >= CANARY_BUCKET_SPACE) return "candidate";
  if (typeof stickinessKey !== "string" || stickinessKey === "")
    return "stable";
  const digest = createHash("sha256")
    .update(salt + ":" + stickinessKey, "utf8")
    .digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16) % CANARY_BUCKET_SPACE;
  return bucket < clamped ? "candidate" : "stable";
  // PARITY-GUARD:END
}
