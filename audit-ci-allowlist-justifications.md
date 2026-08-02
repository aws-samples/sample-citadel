# audit-ci allowlist justifications

Each entry below corresponds to an advisory ID (or module name) added to the
`allowlist` array in `.audit-ci.json`. An entry may only be added to that
array after a justification is written here. Review and either remediate or
renew the justification by the listed `revisitBy` date.

## GHSA-mh99-v99m-4gvg — brace-expansion (HIGH DoS via unbounded expansion)

**Affected instances:**
- `node_modules/aws-cdk-lib/node_modules/brace-expansion@5.0.7` (bundled; advisory range <=5.0.7)
- `node_modules/@eslint/eslintrc/node_modules/brace-expansion@1.1.16` (transitive via eslint→minimatch@3.1.5→brace-expansion; audit flags all)
- `node_modules/@humanwhocodes/config-array/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)
- `node_modules/eslint/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)
- `node_modules/glob/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)
- `node_modules/test-exclude/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)

**Resolved (2026-08-01):** the backend/root direct-edge copy (previously listed above as
"backend direct copy", `backend/node_modules/brace-expansion@5.0.7`) is fixed — both root
and backend `overrides.brace-expansion` floors were raised to `>=5.0.9 <6` and re-resolved
via `npm update brace-expansion`. It now hoists to a single `node_modules/brace-expansion@5.0.9`
satisfying both workspaces; no separate `backend/node_modules/brace-expansion` entry remains.
Residual allowlist scope is now exactly the two categories below (bundled + minimatch@3.1.5
chain) — both correctly labeled as *not* a direct dependency in this codebase.

**Why remediation is blocked:**
1. **aws-cdk-lib bundled copy**: npm `overrides` cannot rewrite `bundleDependencies` entries. Only an upstream `aws-cdk-lib` release bumping its bundled `brace-expansion` to >=5.0.8 will fix this.
2. **eslint chain (1.1.16 instances via minimatch@3.1.5)**: These resolve via eslint→minimatch@3.1.5→brace-expansion@^1.1. Minimatch v3.1.5 *requires* brace-expansion@^1.1, not v5.x. To remediate, minimatch must be upgraded (which requires eslint major upgrade). No in-range npm overrides floor can force v5 without breaking minimatch.

**Exposure & Risk Acceptance:**
- All instances are in root devDependencies (build-time only, not deployed).
- The DoS requires unbounded brace-expansion syntax: `{a,b,c,...}` with extremely large iteration counts. Production code and CI templates do not use such patterns.
- Acceptance: risk is minimal in this context; no immediate remediation path exists.

**Recommended follow-ups (revisitBy: 2026-10-22):**
1. Check for aws-cdk-lib releases >=2.263 with brace-expansion >=5.0.8
2. Consider eslint@10.8.0+ upgrade if team accepts breaking changes
3. Re-run `npm audit` to confirm no new unallowlisted advisories land

**Retest (2026-07-27): confirmed genuinely incompatible, floor NOT applied to minimatch@3.x chain**

Re-verified the compatibility assumption in a throwaway dir (`npm i minimatch@3.1.5 brace-expansion@5.0.8`, forced via a nested `overrides: {minimatch: {brace-expansion: "5.0.8"}}` since a direct dependency + top-level override on the same package is rejected by npm with `EOVERRIDE`).

Result: hard runtime break, not just a version skew.
```
TypeError: expand is not a function
    at Minimatch.braceExpand (minimatch.js:271:10)
```
Root cause: minimatch@3.1.5 does `var expand = require('brace-expansion')` and calls `expand(pattern)` directly, expecting brace-expansion's CJS default export to be a callable function (true for the 1.x line). brace-expansion@5.0.8 ships `"type": "module"` with a `dist/commonjs` shim that exports a named object `{ EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }`, not a callable default. This is an ESM-migration + API-shape change, not merely a semver-major bump — no override floor can bridge it.

Confirmed in the live repo tree (`npm ls minimatch --all`, `find node_modules -path '*/node_modules/brace-expansion/package.json'`): the existing root/backend `"brace-expansion": ">=5.0.8"` override is currently **not** reaching the minimatch@3.1.5 chains (eslint, @eslint/eslintrc, @humanwhocodes/config-array, glob, test-exclude all still resolve brace-expansion@1.1.16 under their nested minimatch@3.1.5). Those chains are accidentally safe today — leave the override as-is; do **not** attempt to widen or force it onto these nested resolutions, as that reproduces the `TypeError` above. aws-cdk-lib's bundled copy is unaffected by any override (npm cannot rewrite `bundleDependencies`); reconfirmed bundled `aws-cdk-lib` version is 2.262.1 (current latest), still shipping brace-expansion@5.0.7 — upstream-blocked, unchanged from prior finding.

Allowlist entry `GHSA-mh99-v99m-4gvg` stands unchanged. No package.json/override edits made as a result of this retest.

## GHSA-qwww-vcr4-c8h2 — react-router (HIGH RSC Mode CSRF Bypass Allows Action Execution Before 400 Response)

**Affected instances:**
- `frontend/node_modules/react-router@7.18.1` (transitive via react-router-dom)
- `frontend/node_modules/react-router-dom@7.18.1` (direct; `^7.18.1` in frontend/package.json)

**Why remediation is blocked:**
1. **No fix version exists on the registry.** The advisory's stated fix (`8.3.0`) does not exist:
   `npm view react-router-dom versions --json` shows the published line tops out at `7.18.1`;
   `npm view react-router-dom@latest version` → `7.18.1`; `npm view react-router-dom@8.3.0 peerDependencies`
   → `404 Not Found`. There is no 8.x release at all yet. Dependabot alert #86 is citing a not-yet-shipped fix version.
2. **Downgrading within 7.x makes things strictly worse.** `npm audit fix --force` on the installed 7.18.1
   suggests downgrading to `react-router-dom@7.11.0`. Verified live: 7.11.0 falls into a *different, much wider*
   advisory range (`react-router` `6.0.0 - 7.17.0`) bundling 14 distinct CVEs (open redirect/XSS, SSR XSS in
   ScrollRestoration, arbitrary constructor invocation via vendored turbo-stream deserialization → unauth RCE,
   DoS via unbounded `__manifest` path expansion, stored XSS via unescaped `Location` header, etc.), versus the
   single CSRF-bypass advisory covering `7.12.0 - 8.2.0` that 7.18.1 sits in. No published 7.x or 8.x version is
   outside every vulnerable range simultaneously — 7.18.1 (latest available) is the least-exposed option on the
   registry today.
3. **App does not use the vulnerable surface.** The CVE requires RSC (React Server Components) mode
   (`unstable_RSC`, `RSCStaticRouter`, `ServerRouter`, `react-router/rsc` imports). `grep -rn` across
   `frontend/src` found zero matches for any RSC-mode API. Usage is confined to the classic component API:
   `BrowserRouter`/`Routes`/`Route`/`useNavigate`/`useParams`/`useSearchParams`/`Link`/`MemoryRouter`
   (see `frontend/src/App.tsx:2` and route/test files under `frontend/src/pages/__tests__/`). The CSRF-bypass
   action-execution path this advisory describes is not reachable from this codebase's router configuration.

**Exposure & Risk Acceptance:**
- Advisory requires RSC mode; this frontend runs classic SPA routing only (Vite + BrowserRouter), no server
  actions, no RSC. Exploitability in this deployment is effectively nil.
- Remediation path is registry-blocked, not effort-blocked — there is nothing to upgrade to yet.
- Acceptance: risk is non-applicable given routing mode in use; no in-range fix exists upstream.

**Recommended follow-ups (revisitBy: 2026-09-01):**
1. Re-check `npm view react-router-dom versions --json` periodically for the `8.3.0` (or later) release landing.
2. When `>=8.3.0` publishes, re-verify its peer `react` requirement (unpublished builds referenced `react>=19.2.7`,
   vs. this app's `react: ^18.3.1`) — a React 19 upgrade may be a co-requirement, not just a router bump.
3. Re-run `npm audit --prefix frontend` after any bump attempt to confirm the advisory clears without
   reintroducing the wider pre-7.18.1 CVE set.
