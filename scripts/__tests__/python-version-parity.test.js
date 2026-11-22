/**
 * Guard test: a single source of truth for the Python toolchain version.
 *
 * .python-version at the repo root is the canonical version. This test
 * asserts every other place that names a Python version — the GitHub
 * Actions workflow, the intake service's Dockerfile base image, every
 * CodeBuild buildspec's runtime-versions.python, and the two
 * developer-facing docs that state a Python prerequisite — all agree with
 * it EXACTLY (e.g. "3.15", never a range like "3.14+" or "3.15+").
 *
 * Intentionally plain Node `fs`/`path` + regex, no transform/deps needed,
 * mirroring scripts/verify-doc-claims.js's zero-new-dependency style.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function expectedVersion() {
  return read('.python-version').trim();
}

describe('python toolchain version parity', () => {
  const EXPECTED = expectedVersion();

  test('.python-version pins an exact X.Y version (not a range)', () => {
    expect(EXPECTED).toMatch(/^\d+\.\d+$/);
  });

  test('ci.yml PYTHON_VERSION matches .python-version exactly', () => {
    const ci = read('.github/workflows/ci.yml');
    const match = ci.match(/PYTHON_VERSION:\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(EXPECTED);
  });

  test('intake Dockerfile FROM tag targets the exact python version', () => {
    const dockerfile = read('service/agent_intake_single/Dockerfile');
    const fromLine = dockerfile.match(/^FROM\s+\S+/m);
    expect(fromLine).not.toBeNull();
    // Accept either an official `python:<ver>-slim*` base (colon form) or
    // a uv image tag that embeds `python<ver>` (concatenated form); either
    // way the exact version digits (e.g. "3.15") must appear immediately
    // after "python[:]", not a bare "3" or a different minor.
    const versionPattern = new RegExp(
      `python:?${EXPECTED.replace('.', '\\.')}(?:[^0-9]|$)`,
    );
    expect(fromLine[0]).toMatch(versionPattern);
  });

  test.each([
    'buildspec-build.yml',
    'buildspec-deploy.yml',
    'buildspec-test.yml',
  ])('%s runtime-versions python matches .python-version exactly', (file) => {
    const spec = read(file);
    const matches = [...spec.matchAll(/python:\s*["']?([0-9]+\.[0-9]+)["']?/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m[1]).toBe(EXPECTED);
    }
  });

  test('README.md prerequisites state the exact python version', () => {
    const readme = read('README.md');
    const match = readme.match(/Python\s+([0-9]+\.[0-9]+)(\+?)/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(EXPECTED);
    expect(match[2]).toBe('');
  });

  test('docs/DEPLOYMENT.md prerequisites state the exact python version', () => {
    const deployment = read('docs/DEPLOYMENT.md');
    const match = deployment.match(/\*\*Python\*\*\s+([0-9]+\.[0-9]+)(\+?)/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(EXPECTED);
    expect(match[2]).toBe('');
  });
});
