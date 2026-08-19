/**
 * rollback-floor.ts — PURE floor derivation for the auto-rollback
 * evaluator: an AUTO_* move must NEVER land below the last human-promoted
 * stable release (decision D4). No I/O, no clock, deterministic.
 *
 * WHY A FLOOR (security invariant INV-2): the evaluator is a NON-HUMAN
 * actor mutating release pointers. Humans establish a baseline by a full
 * cutover (transitionType PROMOTE or CANARY_PROMOTE, promotedBy=userId).
 * The auto-actor must be structurally unable to walk the release pointer
 * PAST that human decision — otherwise a chain of auto-rollbacks could
 * unwind a deliberate operator promotion.
 *
 * HUMAN-vs-AUTO is derived from the transitionType alone: PROMOTE and
 * CANARY_PROMOTE are the two human FULL-cutover transitions that set a new
 * stable baseline. CANARY_START / CANARY_REWEIGHT do not change the stable
 * `releaseId`, and the AUTO_* transitions are, by definition, not human —
 * so none of them can establish a floor. (promotedBy is ALSO minted
 * server-side for the AUTO_* path, but the floor keys on transitionType so
 * it holds even if a future human transition principal changes.)
 *
 * v1 ACTION IS ABORT_CANARY-ONLY (D4): AUTO_ABORT_CANARY zeroes the
 * candidate and leaves the stable `releaseId` untouched, so it can NEVER
 * cross the floor by construction — `decideRollbackAction` always permits
 * it. ROLLBACK_STABLE is modelled here (flip stable → previous) with its
 * floor refusal so the logic is proven before any future evaluator is
 * allowed to mint it, but the v1 evaluator never performs it.
 */
import type {
  EnvironmentReleasePointerHistoryEntry,
  PointerTransitionType,
} from "../../types";

/** The two transitions by which a HUMAN establishes a new stable baseline
 * — a full cutover to a release. Everything else (canary start/reweight,
 * and every AUTO_* transition) is non-baseline-setting. */
const HUMAN_STABLE_TRANSITIONS: ReadonlySet<PointerTransitionType> =
  new Set<PointerTransitionType>(["PROMOTE", "CANARY_PROMOTE"]);

/** Whether a transition is a human full-cutover that sets a stable
 * baseline. A pre-canary history row with no transitionType attribute is
 * treated as PROMOTE (the pre-canary default), matching the store's own
 * `transitionType ?? "PROMOTE"` default. */
export function isHumanStableTransition(
  transitionType: PointerTransitionType | undefined,
): boolean {
  return HUMAN_STABLE_TRANSITIONS.has(transitionType ?? "PROMOTE");
}

/**
 * The releaseId of the most-recent human full-cutover in the (ascending)
 * history — the floor an AUTO_* move may not cross. Returns null when no
 * human baseline exists (e.g. only auto/canary transitions so far), in
 * which case a stable flip has no proven floor and must be refused
 * (fail-closed) by callers.
 *
 * `history` is oldest→newest (queryEnvironmentReleasePointerHistory's
 * order); we scan from the end for the latest human stable row.
 */
export function deriveLastHumanStableReleaseId(
  history: EnvironmentReleasePointerHistoryEntry[],
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (isHumanStableTransition(entry.transitionType)) {
      return entry.releaseId;
    }
  }
  return null;
}

export type RollbackFloorDecision =
  | { allowed: true }
  | { allowed: false; reason: "BELOW_HUMAN_FLOOR" | "NO_HUMAN_BASELINE" };

/**
 * Whether a proposed auto action is permitted against the floor.
 *
 *  - ABORT_CANARY: ALWAYS allowed. It zeroes the candidate and leaves the
 *    stable releaseId untouched, so it can never move the pointer below any
 *    baseline — the floor is irrelevant to it (v1 primary action, D4).
 *  - ROLLBACK_STABLE / BOTH: permitted ONLY IF the release the pointer
 *    would land on equals the last human-promoted stable (rolling an
 *    auto/canary change back to the human baseline). Refused if there is no
 *    human baseline at all (NO_HUMAN_BASELINE) or if the landing release is
 *    not that baseline (BELOW_HUMAN_FLOOR) — a chained auto-rollback must
 *    not walk past a human decision.
 */
export function decideRollbackAction(
  action: "ABORT_CANARY" | "ROLLBACK_STABLE" | "BOTH",
  proposedLandingReleaseId: string | null,
  lastHumanStableReleaseId: string | null,
): RollbackFloorDecision {
  if (action === "ABORT_CANARY") {
    return { allowed: true };
  }
  // ROLLBACK_STABLE / BOTH — a stable pointer flip is floor-gated.
  if (lastHumanStableReleaseId === null) {
    return { allowed: false, reason: "NO_HUMAN_BASELINE" };
  }
  if (proposedLandingReleaseId !== lastHumanStableReleaseId) {
    return { allowed: false, reason: "BELOW_HUMAN_FLOOR" };
  }
  return { allowed: true };
}
