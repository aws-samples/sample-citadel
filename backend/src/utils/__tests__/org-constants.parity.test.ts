/**
 * org-constants.parity.test.ts — PR-3 cross-language parity guard.
 *
 * Asserts the TypeScript `ALL_ORGS` sentinel (backend/src/utils/org-constants.ts)
 * is textually identical to the Python `ALL_ORGS` sentinel
 * (arbiter/common/tenant_guard.py), so the two sides of the system can never
 * silently drift onto different "system-shared" marker strings.
 *
 * Deliberate semantic divergence (NOT a drift bug, documented here so a
 * future reader doesn't "fix" it): tenant_guard.py's `_is_system_org` still
 * accepts the deprecated empty-string alias for backward compatibility
 * during the transition window (its own docstring says so explicitly). The
 * TypeScript side (org-constants.ts `isSystemOrg`) does NOT accept that
 * alias — per this PR's explicit orchestrator override, blank/absent orgId
 * is fail-closed immediately on the TS read path, with no
 * ACCEPT_EMPTY_AS_SHARED flag. This test pins the SHARED CONSTANT STRING
 * only; it does not assert identical accept-the-same-inputs behavior.
 */
import * as fs from "fs";
import * as path from "path";
import { ALL_ORGS } from "../org-constants";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const TENANT_GUARD_PATH = path.join(
  REPO_ROOT,
  "arbiter",
  "common",
  "tenant_guard.py",
);

function extractPythonAllOrgs(): string {
  const text = fs.readFileSync(TENANT_GUARD_PATH, "utf8");
  const match = text.match(/^ALL_ORGS\s*=\s*"([^"]*)"/m);
  if (!match) {
    throw new Error(
      `org-constants.parity.test: could not find ALL_ORGS assignment in ${TENANT_GUARD_PATH}`,
    );
  }
  return match[1];
}

describe("org-constants.parity (TS ALL_ORGS vs Python tenant_guard.ALL_ORGS)", () => {
  it("tenant_guard.py exists and defines ALL_ORGS as a plain string literal", () => {
    expect(fs.existsSync(TENANT_GUARD_PATH)).toBe(true);
    expect(() => extractPythonAllOrgs()).not.toThrow();
  });

  it("the TS ALL_ORGS sentinel is textually identical to the Python ALL_ORGS sentinel", () => {
    const pythonValue = extractPythonAllOrgs();
    expect(ALL_ORGS).toBe(pythonValue);
    expect(ALL_ORGS).toBe("All Organizations");
  });
});
