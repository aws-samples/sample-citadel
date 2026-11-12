/**
 * Jest setupFiles entry — runs before each test suite's environment.
 *
 * Sets CITADEL_SKIP_BUNDLING and ENVIRONMENT defaults so that any jest
 * invocation (CI or local) never triggers a Docker build for Python layer
 * bundling.  The ??= operator ensures explicit env vars from CI or the
 * shell take precedence.
 *
 * The dedicated layer-import smoke test (arbiter-layer-import-smoke.test.ts)
 * opts back out by deleting CITADEL_SKIP_BUNDLING before its Docker checks.
 */
process.env.CITADEL_SKIP_BUNDLING ??= "1";
process.env.ENVIRONMENT ??= "test";
