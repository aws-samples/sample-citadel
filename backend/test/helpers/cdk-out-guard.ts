/**
 * CI fail-loud guard for cdk.out-conditional structural test suites
 * (finding e051a3c6).
 *
 * Every structural/CI-gate suite that reads synthesized templates from
 * `cdk.out/` (dlq-coverage-structural, dlq-runbook-completeness,
 * duplicate-alarm-name-guard, schema-resolver-parity-guard,
 * split-gates-rail2-stateful-pin, tracing-arbiter-stack,
 * tracing-aspect-stack-coverage, tracing-backend-stack) self-skips via
 * `it.skip(...)` when the templates it needs are absent, so a bare
 * `npm test` with no prior synth doesn't fail the whole run. That
 * skip-when-absent convention is correct for local development, but it
 * silently degraded the backend-test CI job into never exercising these
 * guards at all: the CI job never ran `cdk synth` before jest, so every
 * one of these suites *always* took the skip branch in CI, and a
 * regression that removes a DLQ alarm or an alarm-name collision would
 * still show a green PR.
 *
 * `guardCdkOutInCi` is called from inside each suite's existing
 * `if (!allTemplatesPresent) { ... }` branch, immediately before the
 * `it.skip(...)` call. It is a no-op locally (or when the templates ARE
 * present); in CI with templates missing it throws, which — thrown
 * synchronously inside a `describe(...)` callback — aborts that describe
 * block's registration and Jest reports the whole suite as FAILED with
 * this error's message, naming the missing synth step. This makes a
 * missing-synth CI run fail loud instead of quietly reporting 9 skipped
 * suites as if nothing happened.
 *
 * NOTE: like sibling helpers in this directory, this file lives under
 * `test/helpers/` and is compiled by the project's BUILD tsc (it matches
 * none of tsconfig.json's test-file excludes), where jest's ambient
 * globals are not typed. It therefore uses no `it`/`describe`/`expect` —
 * only `process.env` and a plain `Error` throw. Callers keep ownership of
 * their own `describe`/`it.skip` registration.
 */

/**
 * Throws when running under CI (`process.env.CI` truthy) and the given
 * synthesized-template check found something missing. `missingDescription`
 * should name what's absent (e.g. a joined list of missing stack names or
 * template paths) and `synthHint` the command to fix it (e.g.
 * "npx cdk synth --all"), so the CI failure message is actionable without
 * needing to open this helper.
 *
 * No-op when `process.env.CI` is falsy (local runs keep the existing
 * skip-when-absent behavior) — callers are responsible for still calling
 * `it.skip(...)` and `return`-ing after this call in the local case.
 */
export function guardCdkOutInCi(
  missingDescription: string,
  synthHint: string,
): void {
  if (!process.env.CI) return;
  throw new Error(
    `cdk.out template(s) missing in CI: ${missingDescription}. ` +
      `The Backend Tests CI job must synthesize before running jest — ` +
      `run '${synthHint}' first. This suite is a structural CI gate and ` +
      `must not silently skip in CI (finding e051a3c6).`,
  );
}
