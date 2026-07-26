# audit-ci allowlist justifications

Each entry below corresponds to an advisory ID (or module name) added to the
`allowlist` array in `.audit-ci.json`. An entry may only be added to that
array after a justification is written here. Review and either remediate or
renew the justification by the listed `revisitBy` date.

## GHSA-mh99-v99m-4gvg — brace-expansion (HIGH DoS via unbounded expansion)

**Affected instances:**
- `backend/node_modules/brace-expansion@5.0.7` (direct; advisory range <=5.0.7)
- `node_modules/aws-cdk-lib/node_modules/brace-expansion@5.0.7` (bundled; advisory range <=5.0.7)
- `node_modules/@eslint/eslintrc/node_modules/brace-expansion@1.1.16` (transitive via eslint→minimatch@3.1.5→brace-expansion; audit flags all)
- `node_modules/@humanwhocodes/config-array/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)
- `node_modules/eslint/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)
- `node_modules/glob/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)
- `node_modules/test-exclude/node_modules/brace-expansion@1.1.16` (transitive via minimatch@3.1.5)

**Why remediation is blocked:**
1. **backend direct copy**: brace-expansion@5.0.7 is locked directly in backend/package.json; upgrade requires explicit change.
2. **aws-cdk-lib bundled copy**: npm `overrides` cannot rewrite `bundleDependencies` entries. Only an upstream `aws-cdk-lib` release bumping its bundled `brace-expansion` to >=5.0.8 will fix this.
3. **eslint chain (1.1.16 instances via minimatch@3.1.5)**: These resolve via eslint→minimatch@3.1.5→brace-expansion@^1.1. Minimatch v3.1.5 *requires* brace-expansion@^1.1, not v5.x. To remediate, minimatch must be upgraded (which requires eslint major upgrade). No in-range npm overrides floor can force v5 without breaking minimatch.

**Exposure & Risk Acceptance:**
- All instances are in root devDependencies (build-time only, not deployed).
- The DoS requires unbounded brace-expansion syntax: `{a,b,c,...}` with extremely large iteration counts. Production code and CI templates do not use such patterns.
- Acceptance: risk is minimal in this context; no immediate remediation path exists.

**Recommended follow-ups (revisitBy: 2026-10-22):**
1. Check for aws-cdk-lib releases >=2.263 with brace-expansion >=5.0.8
2. Consider eslint@10.8.0+ upgrade if team accepts breaking changes
3. Re-run `npm audit` to confirm no new unallowlisted advisories land
