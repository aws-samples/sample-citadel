/**
 * Regression guard for the CDK asset-path resolution bug.
 *
 * Background: `backend/cdk.json` runs the compiled app via
 * `node dist/bin/app.js`, so at deploy time `__dirname` inside the
 * compiled `arbiter-stack.js` is `backend/dist/lib/` — not `backend/lib/`.
 * Seven call sites in `backend/lib/arbiter-stack.ts` previously used
 * `path.join(__dirname, '../../arbiter/...')`, which resolved to the
 * non-existent `backend/arbiter/` at deploy time and caused
 * `CannotFindAsset` during `cdk synth`.
 *
 * The fix introduces a module-level `resolveArbiterRoot(startDir)` helper
 * (plus an `ARBITER_ROOT` constant) that probes both the source and dist
 * layouts and selects the candidate whose `catalog/` subfolder exists.
 * This test file pins that behaviour:
 *
 *   1. Importing the stack module must not throw (i.e. the resolver
 *      succeeds under ts-jest, where `__dirname` = `backend/lib/`).
 *   2. The resolved repo-root `arbiter/catalog` directory must exist.
 *   3. No `'../../arbiter'` string literal may re-appear in the stack
 *      source (regression guard against a well-meaning refactor
 *      re-introducing the deploy-time breakage).
 *
 * The test deliberately does NOT run `cdk synth` — that is already
 * covered by the other `arbiter-stack-*.test.ts` suites and would only
 * duplicate cost here.
 */
import * as fs from 'fs';
import * as path from 'path';

// Importing the stack module executes `resolveArbiterRoot(__dirname)` at
// module load time. If the resolver cannot locate a repo-root `arbiter/`
// containing a `catalog/` subfolder, this `require` will throw and the
// whole test file will fail with a clear error — which is the intent.
require('../lib/arbiter-stack');

describe('ArbiterStack asset path resolution', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const stackSourcePath = path.resolve(__dirname, '..', 'lib', 'arbiter-stack.ts');

  it('repo-root arbiter/catalog directory exists', () => {
    const catalogDir = path.join(repoRoot, 'arbiter', 'catalog');
    expect(fs.existsSync(catalogDir)).toBe(true);
  });

  it('arbiter-stack.ts contains no "../../arbiter" literals', () => {
    const source = fs.readFileSync(stackSourcePath, 'utf8');
    expect(source.includes("'../../arbiter'")).toBe(false);
    expect(source.includes("'../../arbiter/")).toBe(false);
  });
});
