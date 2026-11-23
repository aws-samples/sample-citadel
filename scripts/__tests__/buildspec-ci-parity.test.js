/**
 * Guard test: the three CodeBuild buildspecs must stay aligned with
 * .github/workflows/ci.yml on the dimensions that matter for reproducing
 * CI behavior in CodeBuild:
 *
 *   - npm install runs as root `npm ci` (never `cd backend && npm ci`,
 *     since root package.json's single npm workspace IS backend — a
 *     `cd backend && npm ci` install bypasses the root workspace lockfile
 *     resolution ci.yml relies on).
 *   - frontend install runs as `npm ci --prefix frontend` (ci.yml's
 *     equivalent of `cd frontend && npm ci`, which stays allowed since
 *     frontend is not an npm workspace of the root package.json).
 *   - the arbiter Python dependency install uses the same requirements
 *     file ci.yml uses: `arbiter/requirements-ci.txt`.
 *   - runtime-versions.python matches ci.yml's PYTHON_VERSION exactly.
 *   - the frontend dependency audit runs from inside frontend/ against
 *     frontend's OWN .audit-ci.json (not the root config via a relative
 *     `../` path).
 *
 * Any buildspec that doesn't perform a given action (e.g. buildspec-deploy
 * has no frontend audit step) is simply not asserted against that rule.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

const BUILDSPECS = ['buildspec-build.yml', 'buildspec-deploy.yml', 'buildspec-test.yml'];

function ciPythonVersion() {
  const ci = read('.github/workflows/ci.yml');
  const match = ci.match(/PYTHON_VERSION:\s*"([^"]+)"/);
  if (!match) throw new Error('could not find PYTHON_VERSION in ci.yml');
  return match[1];
}

describe('buildspec parity with ci.yml', () => {
  const EXPECTED_PY = ciPythonVersion();

  test.each(BUILDSPECS)('%s never installs backend deps via `cd backend && npm ci`', (file) => {
    const spec = read(file);
    expect(spec).not.toMatch(/cd\s+backend\s*&&\s*npm\s+ci/);
    expect(spec).not.toMatch(/^\s*-\s*cd\s+backend\s*\n\s*-\s*npm\s+ci\s*$/m);
  });

  test.each(BUILDSPECS)('%s runtime-versions.python (if present) matches ci.yml PYTHON_VERSION', (file) => {
    const spec = read(file);
    const matches = [...spec.matchAll(/python:\s*["']?([0-9]+\.[0-9]+)["']?/g)];
    for (const m of matches) {
      expect(m[1]).toBe(EXPECTED_PY);
    }
  });

  test.each(BUILDSPECS)('%s installs arbiter deps from the same requirements file as ci.yml (if it installs them at all)', (file) => {
    const spec = read(file);
    const pipLines = spec.match(/pip install[^\n]*/g) || [];
    const arbiterPipLines = pipLines.filter((l) => /arbiter/.test(l));
    for (const line of arbiterPipLines) {
      expect(line).toMatch(/-r\s+arbiter\/requirements-ci\.txt/);
    }
    // If a buildspec installs arbiter/Python test deps piecemeal
    // (`pip install pytest hypothesis boto3`) rather than from the
    // requirements file, that's exactly the drift this guard exists to
    // catch — fail explicitly instead of silently passing.
    const piecemealArbiterInstall = pipLines.some(
      (l) => /pip install/.test(l) && !/-r\s/.test(l) && /pytest|hypothesis|boto3/.test(l),
    );
    expect(piecemealArbiterInstall).toBe(false);
  });

  test('buildspec-test.yml frontend audit runs from frontend/ with frontend/.audit-ci.json', () => {
    const spec = read('buildspec-test.yml');
    // Must NOT reach for the root config via a relative ../ path from
    // inside frontend/.
    expect(spec).not.toMatch(/audit-ci\s+--config\s+\.\.\/\.audit-ci\.json/);
    // Must reference frontend's own config, either as a bare filename run
    // from inside frontend/, or as an explicit frontend/.audit-ci.json path.
    expect(spec).toMatch(/audit-ci\s+--config\s+(\.\/)?\.audit-ci\.json/);
  });
});
