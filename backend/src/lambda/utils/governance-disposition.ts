/**
 * governance-disposition.ts — ONE shared mapper from a governance
 * enforcement mode to what a promotion gate DOES with an already-computed
 * verdict.
 *
 * This module deliberately owns no mode-reading logic of its own. Mode
 * comes exclusively from `getGovernanceEnforce` (../../../utils/
 * governance-flag.ts) — the SINGLE existing reader already consulted
 * elsewhere (agent-import-resolver.ts). Adding a second reader here, or
 * inventing a fourth mode concept, would create exactly the divergent-
 * duplication risk the design calls out; this file only consumes the
 * `GovernanceEnforce` type, never redefines the literal set.
 *
 * The verdict itself (PASS/FAIL/NO_BASELINE/NO_BASELINE_PASS from
 * release-gate.ts) is ALWAYS computed identically regardless of mode —
 * that evaluation happens upstream of this mapper, in every mode,
 * unconditionally. This mapper only answers: given a mode, should the
 * verdict be (a) written to the governance ledger as a finding, and
 * (b) allowed to block the promotion. Skipping evaluation in permissive
 * mode would leave the rollout telemetry silent — the exact regression
 * this module exists to prevent by construction (mode selects
 * disposition, never whether evaluation runs).
 *
 * Dispositions:
 *   - permissive: no-op. No ledger finding, no block, and — contrary to
 *     a previous version of this comment — no metric either: the sole
 *     caller (environment-release-pointer-resolver.ts's
 *     validateReleaseGate) does not emit anything when
 *     `recordFinding` is false. Corrected here rather than adding a
 *     metric emission, because a permissive-mode metric was never part
 *     of any consumer's contract and inventing one now, purely to match
 *     stale documentation, would be a behavior change with no requester.
 *     If permissive-mode telemetry is wanted later, add it at the call
 *     site (validateReleaseGate) and update this comment to match, in
 *     that order.
 *   - shadow: ledger finding written (this is the ONLY record of a
 *     would-block outcome — see release-gate-finding-writer.ts's
 *     module doc for why a failed write here must be surfaced, never
 *     swallowed), no block.
 *   - strict: ledger finding written AND the promotion is blocked.
 */
import type { GovernanceEnforce } from "../../utils/governance-flag";

export interface GovernanceDisposition {
  /** Whether a ledger finding should be written for this decision. */
  recordFinding: boolean;
  /** Whether a FAIL verdict should block the promotion (throw before
   * the pointer write). */
  block: boolean;
}

/**
 * Maps a `GovernanceEnforce` mode literal to its disposition. Throws on
 * any value outside the exact three-literal contract rather than
 * silently defaulting — an unrecognized mode reaching this function is a
 * programming error (the reader it came from already allowlists to the
 * three literals), and this function must not paper over that with a
 * guessed disposition.
 */
export function governanceDisposition(
  mode: GovernanceEnforce,
): GovernanceDisposition {
  switch (mode) {
    case "permissive":
      return { recordFinding: false, block: false };
    case "shadow":
      return { recordFinding: true, block: false };
    case "strict":
      return { recordFinding: true, block: true };
    default: {
      // Compile-time exhaustiveness: if `GovernanceEnforce` ever gains a
      // fourth literal (or loses/renames one of the three), `mode` here
      // is no longer assignable to `never` and `tsc --noEmit` fails at
      // this line — the drift guard the design calls for, enforced by
      // the type checker rather than a runtime array length.
      const _exhaustive: never = mode;
      throw new Error(
        `governanceDisposition: unrecognized enforcement mode "${String(_exhaustive)}" — expected one of permissive|shadow|strict`,
      );
    }
  }
}
