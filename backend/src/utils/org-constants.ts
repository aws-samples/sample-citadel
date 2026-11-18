/**
 * org-constants.ts — single source of truth for the "All Organizations"
 * system-shared sentinel used across registry read paths (PR-3, Continuum
 * CRITICAL: blank orgId was being treated as a cross-tenant wildcard).
 *
 * `ALL_ORGS` is the ONLY value that marks a record as intentionally shared
 * across every tenant. A blank, absent, or `orgUnknown` orgId is never a
 * wildcard — it fails closed. There is no backward-compatible empty-string
 * alias: callers that previously relied on `orgId === ""` meaning
 * "system-shared" must be migrated (via the backfill script) to stamp
 * `ALL_ORGS` explicitly BEFORE this change is deployed.
 *
 * Mirrors the Python-side contract already shipped in
 * `arbiter/common/tenant_guard.py` (`ALL_ORGS` / `_is_system_org`), which
 * this module brings the TypeScript read side into parity with. See
 * `org-constants.parity.test.ts` for the cross-language assertion.
 */

export const ALL_ORGS = "All Organizations";

/**
 * Whether `v` is the explicit system-shared sentinel. Returns `false` for
 * `undefined` and for the empty string — both fail closed, never a
 * wildcard. The only true value is the exact `ALL_ORGS` sentinel.
 */
export function isSystemOrg(v: string | undefined): boolean {
  return v === ALL_ORGS;
}
