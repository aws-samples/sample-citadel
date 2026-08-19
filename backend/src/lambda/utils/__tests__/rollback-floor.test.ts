/**
 * Tests for rollback-floor.ts — the PURE floor derivation. Pins decision
 * D4: an AUTO_* move can never cross the last human-promoted stable, and
 * ABORT_CANARY is always floor-safe.
 */
import {
  decideRollbackAction,
  deriveLastHumanStableReleaseId,
  isHumanStableTransition,
} from "../rollback-floor";
import type {
  EnvironmentReleasePointerHistoryEntry,
  PointerTransitionType,
} from "../../../types";

function historyRow(
  releaseId: string,
  transitionType: PointerTransitionType | undefined,
  version: number,
): EnvironmentReleasePointerHistoryEntry {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "staging",
    releaseId,
    previousReleaseId: null,
    promotedAt: `2026-08-18T00:0${version}:00.000Z`,
    promotedBy: transitionType?.startsWith("AUTO_")
      ? "system:release-rollback-evaluator"
      : "user-1",
    version,
    transitionType,
  };
}

describe("isHumanStableTransition", () => {
  it("treats PROMOTE and CANARY_PROMOTE as human baseline-setting", () => {
    expect(isHumanStableTransition("PROMOTE")).toBe(true);
    expect(isHumanStableTransition("CANARY_PROMOTE")).toBe(true);
  });

  it("treats an absent transitionType as PROMOTE (pre-canary default)", () => {
    expect(isHumanStableTransition(undefined)).toBe(true);
  });

  it("treats AUTO_ROLLBACK/AUTO_ABORT_CANARY and canary start/reweight as non-baseline", () => {
    expect(isHumanStableTransition("AUTO_ABORT_CANARY")).toBe(false);
    expect(isHumanStableTransition("AUTO_ROLLBACK")).toBe(false);
    expect(isHumanStableTransition("CANARY_START")).toBe(false);
    expect(isHumanStableTransition("CANARY_REWEIGHT")).toBe(false);
    expect(isHumanStableTransition("CANARY_ABORT")).toBe(false);
  });
});

describe("deriveLastHumanStableReleaseId", () => {
  it("derives lastHumanStable from PROMOTE/CANARY_PROMOTE rows only", () => {
    const history = [
      historyRow("rel-A", "PROMOTE", 1),
      historyRow("rel-B", "CANARY_START", 2),
      historyRow("rel-C", "CANARY_PROMOTE", 3),
      historyRow("rel-C", "AUTO_ABORT_CANARY", 4),
    ];
    expect(deriveLastHumanStableReleaseId(history)).toBe("rel-C");
  });

  it("ignores AUTO_* transitions when deriving the floor", () => {
    const history = [
      historyRow("rel-A", "PROMOTE", 1),
      historyRow("rel-Z", "AUTO_ROLLBACK", 2),
    ];
    expect(deriveLastHumanStableReleaseId(history)).toBe("rel-A");
  });

  it("returns null when no human baseline exists", () => {
    const history = [historyRow("rel-A", "AUTO_ABORT_CANARY", 1)];
    expect(deriveLastHumanStableReleaseId(history)).toBeNull();
  });
});

describe("decideRollbackAction", () => {
  it("permits ABORT_CANARY regardless of floor", () => {
    expect(decideRollbackAction("ABORT_CANARY", null, null)).toEqual({
      allowed: true,
    });
    expect(decideRollbackAction("ABORT_CANARY", "rel-X", "rel-A")).toEqual({
      allowed: true,
    });
  });

  it("permits ROLLBACK_STABLE that lands exactly on the human baseline", () => {
    expect(decideRollbackAction("ROLLBACK_STABLE", "rel-A", "rel-A")).toEqual({
      allowed: true,
    });
  });

  it("refuses ROLLBACK_STABLE that would cross below the last human-promoted stable", () => {
    expect(decideRollbackAction("ROLLBACK_STABLE", "rel-OLD", "rel-A")).toEqual(
      {
        allowed: false,
        reason: "BELOW_HUMAN_FLOOR",
      },
    );
  });

  it("refuses a stable flip when there is no human baseline at all", () => {
    expect(decideRollbackAction("ROLLBACK_STABLE", "rel-OLD", null)).toEqual({
      allowed: false,
      reason: "NO_HUMAN_BASELINE",
    });
  });
});
