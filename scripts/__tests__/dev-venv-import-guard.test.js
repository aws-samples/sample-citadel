/**
 * Guard test: when a repo-root .venv exists (created by
 * scripts/dev-python-setup.sh), it must be able to `import strands` —
 * the package the arbiter and intake service both depend on — proving the
 * venv was actually populated with the pinned requirement sets rather than
 * left empty or half-installed.
 *
 * If no .venv exists (e.g. a fresh clone, or CI where the Python test jobs
 * use their own setup-python step instead), this test skips with an
 * explanatory message rather than failing — the venv script is a developer
 * convenience, not a CI dependency.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENV_PYTHON = path.join(REPO_ROOT, '.venv', 'bin', 'python');

const venvExists = fs.existsSync(VENV_PYTHON);

(venvExists ? test : test.skip)(
  'repo-root .venv can import strands',
  () => {
    const output = execFileSync(VENV_PYTHON, ['-c', 'import strands; print("ok")'], {
      encoding: 'utf8',
    });
    expect(output.trim()).toBe('ok');
  },
);

if (!venvExists) {
  // eslint-disable-next-line no-console
  console.log(
    `SKIPPED: no .venv found at ${VENV_PYTHON}. Run ./scripts/dev-python-setup.sh to create one and re-run this test.`,
  );
}
