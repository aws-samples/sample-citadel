/**
 * org-constants.test.ts — tests for the single shared source of the
 * "All Organizations" system-shared sentinel (PR-3, Continuum CRITICAL
 * blank-orgId-as-wildcard fix).
 */
import { ALL_ORGS, isSystemOrg } from "../org-constants";

describe("org-constants", () => {
  test("ALL_ORGS is the canonical sentinel string", () => {
    expect(ALL_ORGS).toBe("All Organizations");
  });

  describe("isSystemOrg", () => {
    test("returns true for ALL_ORGS", () => {
      expect(isSystemOrg(ALL_ORGS)).toBe(true);
    });

    test("returns false for a blank string (fail-closed — no alias)", () => {
      expect(isSystemOrg("")).toBe(false);
    });

    test("returns false for undefined (absent orgId)", () => {
      expect(isSystemOrg(undefined)).toBe(false);
    });

    test("returns false for a tenant org id", () => {
      expect(isSystemOrg("org-A")).toBe(false);
    });

    test("returns false for a near-miss string that is not the exact sentinel", () => {
      expect(isSystemOrg("all organizations")).toBe(false);
      expect(isSystemOrg("All Organizations ")).toBe(false);
    });
  });
});
