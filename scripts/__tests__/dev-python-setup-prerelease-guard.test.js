/**
 * Guard test: scripts/dev-python-setup.sh must refuse to build a dev
 * virtualenv on top of a pre-release Python interpreter (e.g. an alpha/beta/
 * release-candidate build installed ahead of the final X.Y.0 cut).
 *
 * Strategy: run the script against an isolated fake repo root (copy of the
 * script + minimal requirement files) with PATH pointing only at a fake
 * `python<PY_VERSION>` shim. The shim delegates to the real system python3
 * for actual interpretation but monkey-patches `sys.version_info` so the
 * script's `releaselevel == "final"` check sees whatever releaselevel the
 * test wants, without needing a real pre-release CPython build installed
 * on the test machine. For `-m venv <dir>`, the shim creates a minimal venv
 * whose `bin/python` is a copy of itself, so the resulting venv inherits
 * the same releaselevel — exactly like a real venv inherits its creating
 * interpreter's version. `uv` is absent from the fake PATH, forcing the
 * script down its system-interpreter branch.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'dev-python-setup.sh');
const PY_VERSION = fs
  .readFileSync(path.join(REPO_ROOT, '.python-version'), 'utf8')
  .trim();
const REAL_PYTHON3 = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();

/**
 * Writes a `python<PY_VERSION>` shim into binDir that behaves like a real
 * interpreter for `-c` snippets (delegating to the real python3, with
 * `sys.version_info.releaselevel` monkey-patched to `releaselevel`), and
 * for `-m venv <dir>` creates a venv whose `bin/python` is a copy of this
 * same shim.
 */
function makeFakeInterpreterDir(tmpDir, releaselevel) {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, `python${PY_VERSION}`);
  const prelude = [
    'import sys',
    '_orig = sys.version_info',
    'class _VI(tuple):',
    '    major = _orig.major',
    '    minor = _orig.minor',
    '    micro = _orig.micro',
    `    releaselevel = ${JSON.stringify(releaselevel)}`,
    '    serial = 0',
    'sys.version_info = _VI(_orig)',
  ].join('\n');
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `REAL_PYTHON3="${REAL_PYTHON3}"`,
    `PRELUDE='${prelude}'`,
    '',
    'if [[ "${1:-}" == "-c" ]]; then',
    '  exec "$REAL_PYTHON3" -c "$PRELUDE',
    '${2}"',
    'fi',
    'if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then',
    '  mkdir -p "$3/bin"',
    '  cp "$0" "$3/bin/python"',
    '  chmod +x "$3/bin/python"',
    '  exit 0',
    'fi',
    'exec "$REAL_PYTHON3" "$@"',
    '',
  ].join('\n');
  fs.writeFileSync(shimPath, script, { mode: 0o755 });
  return binDir;
}

function runScript(scriptPath, fakeBin) {
  // /usr/bin supplies bash/env/mkdir/cp/python3 etc. that the shim and the
  // script itself need, without pulling in the real `uv` (installed under
  // ~/.local/bin or /usr/local/bin on this machine, never /usr/bin) or any
  // real system python3.15 that might shadow the fake shim.
  const isolatedPath = `${fakeBin}:/usr/bin`;
  try {
    const stdout = execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, PATH: isolatedPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function makeFakeRepo() {
  const repoWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-python-setup-repo-'));
  fs.mkdirSync(path.join(repoWorkdir, 'scripts'), { recursive: true });
  const scriptUnderTest = path.join(repoWorkdir, 'scripts', 'dev-python-setup.sh');
  fs.copyFileSync(SCRIPT, scriptUnderTest);
  fs.chmodSync(scriptUnderTest, 0o755);
  fs.writeFileSync(path.join(repoWorkdir, '.python-version'), `${PY_VERSION}\n`);
  fs.mkdirSync(path.join(repoWorkdir, 'arbiter'), { recursive: true });
  fs.writeFileSync(path.join(repoWorkdir, 'arbiter', 'requirements-ci.txt'), '');
  fs.mkdirSync(path.join(repoWorkdir, 'service', 'agent_intake_single'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repoWorkdir, 'service', 'agent_intake_single', 'requirements.txt'),
    '',
  );
  fs.writeFileSync(
    path.join(repoWorkdir, 'service', 'agent_intake_single', 'requirements-dev.txt'),
    '',
  );
  return { repoWorkdir, scriptUnderTest };
}

describe('dev-python-setup.sh pre-release interpreter guard', () => {
  let tmpDir;
  let repoWorkdir;
  let scriptUnderTest;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-python-setup-test-'));
    ({ repoWorkdir, scriptUnderTest } = makeFakeRepo());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoWorkdir, { recursive: true, force: true });
  });

  test('refuses a pre-release interpreter: exits 2, no venv created, explains remediation', () => {
    const fakeBin = makeFakeInterpreterDir(tmpDir, 'beta');
    const res = runScript(scriptUnderTest, fakeBin);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/pre-release/i);
    expect(res.stderr).toMatch(/uv python install/);
    expect(res.stderr).toMatch(/system python3\.15/i);
    expect(fs.existsSync(path.join(repoWorkdir, '.venv'))).toBe(false);
  });

  test('accepts a final-release interpreter: proceeds past the guard', () => {
    const fakeBin = makeFakeInterpreterDir(tmpDir, 'final');
    const res = runScript(scriptUnderTest, fakeBin);

    // The script may still fail later (empty requirement files, no real
    // pip in this stripped-down fake repo) — this test only asserts the
    // pre-release guard did not trigger.
    expect(res.stderr).not.toMatch(/pre-release/i);
    expect(res.exitCode).not.toBe(2);
  });

  test('idempotent: re-running against an existing pre-release venv still refuses', () => {
    const fakeBin = makeFakeInterpreterDir(tmpDir, 'final');

    // Pre-seed an existing venv built with a pre-release interpreter so the
    // script's "reuse existing venv" branch is exercised on the second run.
    const preReleaseBinDir = makeFakeInterpreterDir(
      fs.mkdtempSync(path.join(os.tmpdir(), 'dev-python-setup-prerel-')),
      'rc',
    );
    const venvBinDir = path.join(repoWorkdir, '.venv', 'bin');
    fs.mkdirSync(venvBinDir, { recursive: true });
    fs.copyFileSync(
      path.join(preReleaseBinDir, `python${PY_VERSION}`),
      path.join(venvBinDir, 'python'),
    );
    fs.chmodSync(path.join(venvBinDir, 'python'), 0o755);

    const res = runScript(scriptUnderTest, fakeBin);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/pre-release/i);
  });
});
