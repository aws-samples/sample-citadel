/**
 * Unit tests for record-approval-check.ts's assertRecordApprovedForAction.
 *
 * Synthetic ids/statuses only.
 */

jest.mock("../../utils/governance-flag", () => ({
  getGovernanceEnforce: jest.fn(),
}));

import {
  assertRecordApprovedForAction,
  RecordNotApprovedError,
} from "../record-approval-check";
import { REGISTRY_STATUS_FIELD } from "../approval-cache-fields";

describe("assertRecordApprovedForAction", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("strict mode + DRAFT status throws RecordNotApprovedError", () => {
    expect(() =>
      assertRecordApprovedForAction({ status: "DRAFT" }, "publish", "strict"),
    ).toThrow(RecordNotApprovedError);
    try {
      assertRecordApprovedForAction({ status: "DRAFT" }, "attach", "strict");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RecordNotApprovedError);
      expect((err as Error).message).toBe("approval_absent:DRAFT");
    }
  });

  it("strict mode + missing status throws approval_absent_missing_status", () => {
    try {
      assertRecordApprovedForAction({}, "publish", "strict");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RecordNotApprovedError);
      expect((err as Error).message).toBe("approval_absent_missing_status");
    }
  });

  it("strict mode + cache item missing registryStatus throws missing_status variant", () => {
    expect(() =>
      assertRecordApprovedForAction(
        { [REGISTRY_STATUS_FIELD]: undefined },
        "attach",
        "strict",
      ),
    ).toThrow("approval_absent_missing_status");
  });

  it("shadow mode + DRAFT proceeds and logs a would_block warning", () => {
    expect(() =>
      assertRecordApprovedForAction({ status: "DRAFT" }, "publish", "shadow"),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.message).toBe("record-approval-check: would_block");
    expect(logged.mode).toBe("shadow");
    expect(logged.status).toBe("DRAFT");
  });

  it("permissive mode + DRAFT proceeds and logs a would_block warning", () => {
    expect(() =>
      assertRecordApprovedForAction(
        { status: "DRAFT" },
        "attach",
        "permissive",
      ),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("APPROVED status proceeds without warning in any mode", () => {
    expect(() =>
      assertRecordApprovedForAction(
        { status: "APPROVED" },
        "publish",
        "strict",
      ),
    ).not.toThrow();
    expect(() =>
      assertRecordApprovedForAction({ status: "APPROVED" }, "attach", "shadow"),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("APPROVED via denormalized cache item's registryStatus field proceeds", () => {
    expect(() =>
      assertRecordApprovedForAction(
        { [REGISTRY_STATUS_FIELD]: "APPROVED" },
        "attach",
        "strict",
      ),
    ).not.toThrow();
  });

  it("registry record .status takes precedence over a cache-item-shaped field", () => {
    // Mixed shape: has both .status (approved) and registryStatus (draft) —
    // .status wins per resolveRawStatus's precedence.
    expect(() =>
      assertRecordApprovedForAction(
        { status: "APPROVED", [REGISTRY_STATUS_FIELD]: "DRAFT" } as never,
        "publish",
        "strict",
      ),
    ).not.toThrow();
  });
});
