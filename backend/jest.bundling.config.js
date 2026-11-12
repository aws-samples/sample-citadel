/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Jest config for Docker-dependent bundling tests.
 *
 * Matches ONLY the layer-import smoke test.  Run via `npm run test:bundling`.
 *
 * Key difference from the main config: this suite DOES NOT set
 * CITADEL_SKIP_BUNDLING and MUST fail (not skip) when Docker is unavailable.
 * Skipping silently hid the original x86_64 regression for the entire branch.
 */
const base = require("./jest.config.js");

module.exports = {
  ...base,
  // Override: only match the layer-import smoke test.
  testMatch: ["<rootDir>/test/arbiter-layer-import-smoke.test.ts"],
  // Remove the ignore pattern for the smoke test that the main config adds.
  testPathIgnorePatterns: base.testPathIgnorePatterns?.filter(
    (p) => !p.includes("layer-import"),
  ) ?? ["/node_modules/", "<rootDir>/cdk.out/", "<rootDir>/dist/"],
  // Do NOT load jest-env-setup.ts — the smoke test needs Docker.
  setupFiles: [],
  // Longer timeout: Docker pull + import + synth can be slow.
  testTimeout: 600_000,
};
