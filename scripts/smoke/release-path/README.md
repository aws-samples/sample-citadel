# Release-Path Smoke Fixture — README

Proves three real code paths run end to end in a dev deployment:

1. `cutAgentRelease` (backend/src/lambda/release-resolver.ts)
2. `promoteEnvironmentReleasePointer` (backend/src/lambda/environment-release-pointer-resolver.ts)
3. `resolve_release` (arbiter/governance/release_resolution.py) — the dispatch-side read

It arranges the *prerequisites* these two mutations only ever READ, then
exercises the mutations themselves for real through AppSync, then asserts
dispatch resolution sees the promoted release, in a **non-blocking**
governance mode. See `../../../RUNBOOK.md` for how to run it; this file
explains what it does and why it is safe to run repeatedly.

## Files

| File | Purpose |
|---|---|
| `fixtures.ts` | Sentinel constants + idempotent arrange (Project, APPROVED registry record, APPROVED exec spec, throwaway FROZEN eval suite + case, COMPLETED eval run) + post-arrange invariant assertions. |
| `env.ts` | Reads operator-provisioned identity/config from the environment. Never provisions anything itself. |
| `appsync-client.ts` | Minimal `fetch`-based AppSync GraphQL client (no new SDK dependency). |
| `run-smoke.ts` | Exercises the real `cutAgentRelease` then `promoteEnvironmentReleasePointer` through AppSync, asserting each stage and its idempotency. |
| `assert_dispatch_resolves.py` | Read-only: calls `resolve_release` and asserts `RESOLVED` with the matching `releaseId`. |
| `RUNBOOK.md` | One-time operator setup + how to run. |

## Why every field is what it is

Every field this harness supplies to `cutAgentRelease` /
`promoteEnvironmentReleasePointer` was derived by reading the validation
in `release-resolver.ts` and `environment-release-pointer-resolver.ts`
directly (never guessed):

- `cutAgentRelease` needs, IN THIS ORDER: `release:cut` permission
  (`custom:role` → `architect`/`admin`), a non-empty caller org
  (`extractOrgFromEvent`), an **APPROVED** registry record whose
  `customDescriptorContent.orgId` equals the caller's org, an **APPROVED**
  `ExecutionSpecification` whose project's owner resolves (via Cognito) to
  the caller's org, and a **COMPLETED** `EvalRun` whose `orgId` matches and
  whose `suiteVersion` matches its suite's current `version` — and that
  suite must also belong to the caller's org. `fixtures.ts`'s `arrange()`
  builds exactly this shape and `assertArrangeInvariants()` re-checks every
  one of these predicates by reading the rows back through the API before
  `run-smoke.ts` ever calls `cutAgentRelease`.
- `promoteEnvironmentReleasePointer` needs `release:promote` permission
  (same `architect`/`admin` grantee set), a non-empty caller org, and a
  target release that exists and belongs to that org — `run-smoke.ts`
  reads the current pointer first (to report the pre-promotion state) but
  never re-implements the optimistic-lock check itself; the store's
  `ConditionExpression` is the actual enforcement.
- `resolve_release` is a pure two-GetItem read
  (`EnvironmentReleasePointersTable` then `AgentReleasesTable`) that never
  raises; `assert_dispatch_resolves.py` asserts its `RESOLVED` outcome and
  the resolved `releaseId`, nothing more.

## Never references a shipped seed suite

`fixtures.ts` creates its **own** eval suite (`SMOKE-RELEASE-FIXTURE-SUITE`)
under a dedicated sentinel org (`SMOKE-RELEASE-FIXTURE-ORG`) and freezes
*that* suite before cutting a release against it. `markEvalSuiteReferenced`
(the permanent freeze — `references[]` never shrinks) only ever touches the
suite whose id this harness looked up or created, and that suite's name is
namespaced so it can never collide with, or be confused for, a shipped seed
suite. No shipped seed suite id, name, or org is ever referenced anywhere in
these files. Because the freeze is genuinely permanent, this is a one-way
door — which is exactly why the fixture suite must be, and is, one this
harness owns end to end rather than one that ships with the product.

## Why exactly one `AgentRelease` row can ever exist

`AgentReleasesTable` is content-addressed: `release-store.ts`'s
`putRelease` computes `releaseId = computeReleaseHash(constituents)` over
the release's constituents **only** (excluding volatile fields like
`createdAt`), then does a create-only conditional `Put` on
`attribute_not_exists(releaseId)`. `run-smoke.ts` supplies every
constituent — `agentConfig` (derived from the registry record's own
`customDescriptorContent`, which `fixtures.ts` always creates with the same
literal marker payload), `promptVersions`, `modelConfigSnapshots`,
`toolConfigs`, `policySnapshot`, `execSpecId`/`execSpecVersion` (pinned to
the one APPROVED spec `arrange()` finds-or-creates), and `evalEvidence`
(pinned to the one COMPLETED run `arrange()` seeds deterministically) — as
fixed `SENTINEL_*` literals or as ids read back from the idempotently
arranged fixtures. None of these vary between runs once `arrange()` has
converged, so `computeReleaseHash` always produces the SAME `releaseId`,
and every rerun after the first hits the conditional Put's
already-exists branch and returns the existing row. **There is
structurally no way for this harness to produce a second
`AgentRelease` row**, short of deliberately changing one of the
`SENTINEL_*` constants in this directory.

`EnvironmentReleasePointersTable` is the one row that is *intentionally*
mutable (it is the cursor, not the audit record): every successful
promotion increments its `version` by exactly 1 via the
optimistic-lock `ConditionExpression`, and `run-smoke.ts` asserts that
increment explicitly. Re-running this harness therefore converges to
**exactly one pointer row** (keyed by
`(SENTINEL_ORG, SENTINEL_AGENT_TARGET_ID#DEV)`) whose `version` grows by 1
per run — bounded, monotonic growth of a single row's counter, not
row accumulation.

`EvalSuitesTable`/`EvalCasesTable`/`ExecutionSpecificationsTable`/
`ProjectsTable` rows are found-by-sentinel-name-if-present, so those stay
at one row each too (see `fixtures.ts`'s module doc for why these ids
can't be pinned deterministically the way the release/eval-run ids can,
and how "create-if-absent" is implemented as "list, match by sentinel
name, create only if absent" instead).

## Never weakens the release-store choke point

Neither this harness nor its dependencies (`arbiter/governance/release_resolution.py`)
ever imports a write command against `AgentReleasesTable` or
`EnvironmentReleasePointersTable`. The only direct-DynamoDB write in this
directory is `fixtures.ts`'s seed of a `COMPLETED` `EvalRun` row into
`EVAL_RUNS_TABLE` — a table `cutAgentRelease` only ever `GetItem`s, and
which is not covered by `release-store-choke-point.guard.test.ts` (that
guard scopes to `AgentReleasesTable` specifically). Every read this
harness needs against the release/pointer tables goes through the API:
`cutAgentRelease`'s return value, `getCurrentEnvironmentReleasePointer`,
and — on the dispatch side — the existing read-only
`resolve_release` Python module, which is itself IAM-floored to
GetItem/Query only (see that module's own docstring). No table is read
directly where an API read would do, and the one direct read
(`assert_dispatch_resolves.py` calling `resolve_release`) mirrors the
exact call the real dispatch gate (`_check_release_gate` in
`arbiter/stepRunner/executor.py`) already makes in production — it is not
a new read path.

## Namespacing

Every string this harness creates carries a `SMOKE-RELEASE-FIXTURE`
marker, `SMOKE-RELEASE-FIXTURE-ORG`, or both — see `fixtures.ts`'s
`SENTINEL_*` constants. A table scan or console browse can distinguish
every row this harness ever writes from real tenant data at a glance.

## Dependency pinning note

`package.json` in this directory pins exact, package-manager-resolved
versions of `@aws-sdk/client-cognito-identity-provider`,
`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `typescript`,
`ts-node`, and `@types/node` — resolved via `npm install` against the
same `^`-ranges `backend/package.json` already depends on, then pinned
to the exact versions npm actually installed (never hand-typed from
memory). `dependency_check` reported zero known advisories for every one
of these exact versions at pin time. If you bump these here, re-run
`npm install` to resolve the new version and `npm audit` to confirm
zero vulnerabilities before pinning it.
