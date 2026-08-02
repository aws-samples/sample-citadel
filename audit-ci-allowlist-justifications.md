# audit-ci allowlist justifications

Each entry below corresponds to an advisory ID (or module name) added to the
`allowlist` array in `.audit-ci.json`. An entry may only be added to that
array after a justification is written here. Review and either remediate or
renew the justification by the listed `revisitBy` date.

## GHSA-mh99-v99m-4gvg — brace-expansion (HIGH DoS via unbounded expansion)

**Affected instances:**
- `node_modules/aws-cdk-lib/node_modules/brace-expansion@5.0.7` (bundled; advisory range <=5.0.7)

**Resolved (2026-08-01):** the backend/root direct-edge copy (previously listed above as
"backend direct copy", `backend/node_modules/brace-expansion@5.0.7`) is fixed — both root
and backend `overrides.brace-expansion` floors were raised to `>=5.0.9 <6` and re-resolved
via `npm update brace-expansion`. It now hoists to a single `node_modules/brace-expansion@5.0.9`
satisfying both workspaces; no separate `backend/node_modules/brace-expansion` entry remains.

**Resolved (2026-08-02):** the five minimatch@3.1.5-chain 1.x copies (previously listed here as
`@eslint/eslintrc`, `@humanwhocodes/config-array`, `eslint`, `glob`, `test-exclude` — all
`brace-expansion@1.1.16`) are fixed. The prior blocker ("no fix without a major bump") is now
false: brace-expansion **1.1.17** patched this GHSA within the 1.x line (registry latest on 1.x
is 1.1.18), so minimatch@3.1.5's `^1.1.7` dependency range can be satisfied by a patched version
without touching minimatch or eslint majors. Fix applied: the five nested overrides
(`eslint.minimatch.brace-expansion`, `jest.minimatch.brace-expansion`, `glob.minimatch.brace-expansion`,
`test-exclude.minimatch.brace-expansion` — `@eslint/eslintrc` and `@humanwhocodes/config-array` are
covered transitively via the `eslint` override cascading through eslint's own subtree) were changed
from `>=5.0.9 <6` (a floor that could never be satisfied by minimatch@3's 1.x-only requirement, so
npm silently left 1.1.16 in place — confirmed via `npm ls` showing `invalid: ">=5.0.9 <6"` against all
five) to `>=1.1.18 <2`, then re-resolved via `npm update brace-expansion`. All five now resolve to
`brace-expansion@1.1.18` with zero invalid edges. `aws-cdk-lib`'s `minimatch.brace-expansion` override
was deliberately left at `>=5.0.9 <6` (unaffected chain, untouched).

Residual allowlist scope is now exactly the one category below (bundled aws-cdk-lib copy) — the only
remaining instance not reachable by npm `overrides`.

**Why remediation is blocked:**
1. **aws-cdk-lib bundled copy**: npm `overrides` cannot rewrite `bundleDependencies` entries. Only an upstream `aws-cdk-lib` release bumping its bundled `brace-expansion` to >=5.0.8 will fix this.

**Exposure & Risk Acceptance:**
- The bundled instance is in a root devDependency-adjacent package (aws-cdk-lib), build-time only, not deployed.
- The DoS requires unbounded brace-expansion syntax: `{a,b,c,...}` with extremely large iteration counts. Production code and CI templates do not use such patterns.
- Acceptance: risk is minimal in this context; no immediate remediation path exists for the bundled copy.

**Recommended follow-ups (revisitBy: 2026-10-22):**
1. Check for aws-cdk-lib releases >=2.263 with brace-expansion >=5.0.8
2. Re-run `npm audit` to confirm no new unallowlisted advisories land

**Historical note — do not repeat this mistake:** an earlier retest (2026-07-27) correctly found
that *forcing 5.x* onto the minimatch@3.1.5 chain breaks it at runtime
(`TypeError: expand is not a function` — minimatch@3.1.5 calls `require('brace-expansion')` expecting
a callable CJS default, which the 5.x ESM line does not provide). That constraint is still true and
is why `aws-cdk-lib`'s override stays at `>=5.0.9 <6`. It does **not** apply to the 2026-08-02 fix,
which pins the same chains to a patched **1.x** version (`>=1.1.18 <2`) — same major line minimatch@3
already expects, no API-shape change. Do not widen the minimatch@3 chains to 5.x.

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
