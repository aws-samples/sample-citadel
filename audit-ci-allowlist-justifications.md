# audit-ci allowlist justifications

Each entry below corresponds to an advisory ID (or module name) added to the
`allowlist` array in `.audit-ci.json`. An entry may only be added to that
array after a justification is written here. Review and either remediate or
renew the justification by the listed `revisitBy` date.

## GHSA-v2hh-gcrm-f6hx / GHSA-4c8g-83qw-93j6 — fast-uri (high)

- **Module**: `fast-uri@3.1.2`, bundled inside `aws-cdk-lib@2.260.0` (via its
  bundled `table` → `ajv` dependency chain).
- **Why it cannot be remediated now**: `fast-uri` here is an npm
  `bundleDependencies` entry of `aws-cdk-lib`. npm `overrides` and
  `npm audit fix` cannot rewrite a package's bundled dependencies — only an
  upstream `aws-cdk-lib` release that bumps its bundled `ajv`/`table`/`fast-uri`
  can fix this. Confirmed on disk
  (`node_modules/aws-cdk-lib/node_modules/fast-uri/package.json` still reports
  `3.1.2` after `npm audit fix` and after adding a root `overrides.fast-uri`
  entry).
- **Exposure**: `fast-uri` is used internally by `aws-cdk-lib`'s CLI-side JSON
  schema validation during `cdk synth`/build tooling — not part of any
  deployed runtime request path.
- **Action taken**: root `package.json` `overrides.fast-uri` set to `4.1.1`
  (latest patched) so any *non-bundled* resolution path picks up the fix; the
  bundled copy is the only remaining instance.
- **revisitBy**: 2026-10-22 — bump `aws-cdk-lib` to the first release whose
  bundled dependency tree no longer contains a vulnerable `fast-uri`, then
  remove this entry.

## GHSA-3jxr-9vmj-r5cp — brace-expansion (high)

- **Module**: `brace-expansion@5.0.6`, bundled inside `aws-cdk-lib@2.260.0`
  (same `table` chain as above).
- **Why it cannot be remediated now**: same bundled-dependency limitation as
  `fast-uri` above — confirmed on disk after `npm audit fix`.
- **Exposure**: build-time only (CDK CLI internals), not a deployed runtime
  dependency.
- **revisitBy**: 2026-10-22 — re-check after the next `aws-cdk-lib` bump.

## GHSA-r67j-r569-jrwp / GHSA-526f-jxpj-jmg2 — thrift (high)

- **Module**: `thrift@0.16.0`, direct dependency of `@databricks/sql@1.17.0`.
- **Why it cannot be remediated now**: the patched line (`>=0.23.0`) is not
  supported by the currently-installed `@databricks/sql@1.17.0`; the only
  `npm audit fix` path is `@databricks/sql@2.0.0`, which is a semver-major
  bump requiring a Databricks adapter compatibility check
  (`backend/src/lambda/adapters/databricks-adapter.ts`, out of this task's
  scope — that file lives under `backend/src/lambda`, off-limits per branch
  ownership).
- **Exposure**: server-side Databricks connector adapter, invoked only for
  orgs that configure a Databricks data store integration; not on the default
  request path.
- **revisitBy**: 2026-09-15 — coordinate the `@databricks/sql@2.x` major
  upgrade with the adapter owner.

## GHSA-w5hq-g745-h8pq — uuid (moderate)

- **Module**: `uuid@8.0.0` / `uuid@9.0.1`, transitive via `aws-sdk@2.x` and
  `@databricks/sql@1.17.0`.
- **Why it cannot be remediated now**: the fix (`uuid@11.1.1`) is semver-major
  for both consumers; `aws-sdk` v2 (the legacy JS SDK) is deprecated upstream
  and its own migration to v3 is a separate, larger effort (see the `aws-sdk`
  entry below).
- **Exposure**: `uuid`'s vulnerable path requires passing a caller-supplied
  `buf` argument to `v3`/`v5`/`v6`, which this codebase's call sites do not do.
- **revisitBy**: 2026-10-22.

## GHSA-j965-2qgj-vjmq — aws-sdk (moderate)

- **Module**: `aws-sdk@2.1693.0` (JS SDK v2), direct dependency of
  `aws-lambda@1.0.7`.
- **Why it cannot be remediated now**: the advisory's recommendation is
  "migrate to AWS SDK v3" — already the primary SDK used throughout
  `backend/src` (`@aws-sdk/*` v3 clients). `aws-sdk` v2 remains only as a
  transitive dependency of the `aws-lambda` npm types/helper package; removing
  it means dropping or replacing that package, which touches Lambda handler
  code under `backend/src/lambda` (out of this task's scope).
- **Exposure**: the flagged region-validation gap in SDK v2 requires the
  application to pass an untrusted/unvalidated region string, which this
  codebase does not do (regions come from CDK context, not user input).
- **revisitBy**: 2026-10-22 — track alongside the `aws-lambda` major bump
  below.

## aws-lambda (low, no CVE id — flagged via its `aws-sdk` v2 dependency)

- **Module**: `aws-lambda@1.0.7`.
- **Why it cannot be remediated now**: `npm audit fix`'s only path is
  `aws-lambda@1.0.6`, a downgrade that does not fix anything (same root
  cause as the `aws-sdk` entry above — it is transitively pulling in
  `aws-sdk` v2). Actual remediation is the same v2→v3 migration tracked
  above.
- **revisitBy**: 2026-10-22.

## @databricks/sql (high, aggregate of thrift + uuid transitive advisories)

- **Module**: `@databricks/sql@1.17.0`.
- **Why it cannot be remediated now**: this is the parent-package rollup of
  the `thrift` and `uuid` entries above; fixing it means the same
  `@databricks/sql@2.0.0` major bump.
- **revisitBy**: 2026-09-15 (same date as the `thrift` entry).
