# audit-ci allowlist justifications

Each entry below corresponds to an advisory ID (or module name) added to the
`allowlist` array in `.audit-ci.json`. An entry may only be added to that
array after a justification is written here. Review and either remediate or
renew the justification by the listed `revisitBy` date.

## GHSA-mh99-v99m-4gvg — brace-expansion (HIGH DoS via unbounded expansion) — RESOLVED, entry removed

**Resolved (2026-08-12):** the last remaining blocker — the `aws-cdk-lib` bundled copy
(`node_modules/aws-cdk-lib/node_modules/brace-expansion@5.0.7`) — is fixed by the
`aws-cdk-lib` 2.264.0 bump. mh99's `fixedIn` is `5.0.8`; the bundled subtree now resolves to
`brace-expansion@5.0.8`. `npm audit` no longer reports this advisory. The allowlist entry has
been removed from `.audit-ci.json`. Historical detail retained below for context.

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

## GHSA-rgw5-rvv9-x895 — brace-expansion (HIGH DoS via unbounded intermediate arrays; bypasses GHSA-mh99-v99m-4gvg mitigation)

**Affected instances:**
- `node_modules/aws-cdk-lib/node_modules/brace-expansion@5.0.8` (`inBundle: true`; advisory range `>=4.0.0 <5.0.9`)

This is the same bundled copy as GHSA-mh99-v99m-4gvg above — rgw5 is its unallowlisted
bypass-successor (mh99's mitigation covers `<5.0.8`; rgw5 extends the vulnerable range to `<5.0.9`).

**Why remediation is blocked:**
1. **Bundled, not reachable by `overrides`.** npm `overrides` cannot rewrite `bundleDependencies`
   content. The existing nested override `aws-cdk-lib.minimatch.brace-expansion: ">=5.0.9 <6"` is
   structurally ineffective against this copy — confirmed the installed tree still resolves
   `brace-expansion@5.0.8` inside `node_modules/aws-cdk-lib/node_modules/`.
2. **No upstream fix available yet.** Installed `aws-cdk-lib` is `2.264.0` (bumped 2026-08-12);
   its bundled `brace-expansion` is `5.0.8` — patched against mh99 (`<5.0.8`) but still inside
   rgw5's vulnerable range (fix is `5.0.9`, i.e. `<5.0.9` remains vulnerable). No newer
   `aws-cdk-lib` release exists yet that bundles `>=5.0.9`.

**Exposure & Risk Acceptance:**
- Same bundled, build-time-only, non-deployed instance as GHSA-mh99-v99m-4gvg above.
- DoS-only, requires attacker-controlled unbounded brace-expansion syntax at CDK synth time; not
  exposed to runtime/production traffic.
- Acceptance: risk is minimal in this context; no remediation path exists until aws-cdk-lib ships
  a release bundling brace-expansion >=5.0.9.

**Recommended follow-ups (revisitBy: 2026-10-22):**
1. Check for aws-cdk-lib releases with bundled brace-expansion >=5.0.9 (as of 2.264.0, still on 5.0.8).
2. When available, bump aws-cdk-lib and confirm rgw5 clears; remove the entry from the allowlist.
3. Re-run `npm audit` to confirm no new unallowlisted advisories land.


## GHSA-qwww-vcr4-c8h2 — react-router (RESOLVED 2026-08-11; root allowlist entry removed 2026-08-12)

**Prior claim (now false):** this entry previously asserted no fix version was published for the
7.x line and that `react-router-dom@latest` topped out at `7.18.1`.

**Resolution:** `react-router`/`react-router-dom` **7.18.2** landed via merged PR #67 and is the
advisory's documented `first_patched_version` for the `>=7.12.0, <7.18.2` vulnerable range
(GHSA record vulnerable ranges: `>=7.12.0 <7.18.2` and `>=8.0.0 <8.3.0`; first patched `7.18.2`
and `8.3.0` respectively). `frontend/package.json` declares `"react-router-dom": "^7.18.2"`, and
`frontend/package-lock.json` already resolved `react-router-dom@7.18.2` / `react-router@7.18.2`.
`npm audit --audit-level=low --prefix frontend` reports 0 vulnerabilities from react-router.

**Allowlist status (accurate as of this edit):** `GHSA-qwww-vcr4-c8h2` was never added to
`frontend/.audit-ci.json`. PR #70 deferred the root-scoped cleanup of the vestigial root
`.audit-ci.json` entry to keep that change's diff scoped to the frontend gate; PR #70 is now
merged into main with no conflicts, so that deferred cleanup is applied here: the entry and its
stale `_comment` claim have been removed from the root `.audit-ci.json` allowlist. The advisory
is fully resolved with no remaining allowlist entries anywhere in the repo.
