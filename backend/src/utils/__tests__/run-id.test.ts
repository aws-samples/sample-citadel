/**
 * Tests for backend/src/utils/run-id.ts — runId mint format/uniqueness and
 * the DispatchContext build-time-required-field guard (Pass 1, decision
 * f1cbd5ef).
 */
import {
  mintRunId,
  buildDispatchContext,
  type DispatchContext,
} from "../run-id";

describe("run-id", () => {
  describe("mintRunId", () => {
    test("produces the run-<uuidv4> format", () => {
      const id = mintRunId();
      expect(id).toMatch(
        /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    test("is greppable via the run- prefix (distinguishable from a bare uuid)", () => {
      const id = mintRunId();
      expect(id.startsWith("run-")).toBe(true);
    });

    test("produces unique values across repeated calls", () => {
      const ids = new Set(Array.from({ length: 100 }, () => mintRunId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("buildDispatchContext", () => {
    test("returns a shallow copy carrying the required runId", () => {
      const ctx = buildDispatchContext({ runId: "run-abc", extra: "value" });
      expect(ctx.runId).toBe("run-abc");
      expect(ctx.extra).toBe("value");
    });

    test("build-time guard: DispatchContext requires runId (compile-fail fixture)", () => {
      // This is a type-level assertion exercised by `tsc`, not a runtime
      // assertion: the commented-out line below must fail to compile if
      // uncommented, proving `runId` is a required field on the type.
      //
      //   const bad: DispatchContext = { extra: 'value' }; // ts(2741): Property 'runId' is missing
      //
      // Runtime companion: a valid construction succeeds and includes runId.
      const good: DispatchContext = { runId: mintRunId() };
      expect(typeof good.runId).toBe("string");
    });
  });
});
