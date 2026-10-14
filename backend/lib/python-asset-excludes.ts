/**
 * Shared exclude list for Python-based CDK asset fingerprinting.
 *
 * Local Python virtual environments (`.venv`, `venv`, `.venv-*`) and caches
 * (`__pycache__`, `.pytest_cache`, `.hypothesis`, `.mypy_cache`) inflate the
 * asset fingerprint tree walk from seconds to minutes on developer machines.
 * Excluding them is safe: Lambda bundling installs from `requirements.txt`
 * (PythonFunction) or copies explicit source dirs (Code.fromAsset), so these
 * directories are never part of the deployed artefact.
 *
 * `__tests__` and `conftest.py` are test-only: no runtime Python module
 * imports them (verified by grep — no `from __tests__` or `import conftest`
 * in any arbiter non-test .py file). `*.md` is documentation only.
 *
 * `node_modules`, `.git`, and `cdk.out` are build/VCS artefacts that should
 * never enter a Python Lambda asset.
 */
export const PYTHON_ASSET_EXCLUDES: readonly string[] = [
  ".venv",
  ".venv-*",
  "venv",
  "__pycache__",
  "*.pyc",
  ".pytest_cache",
  ".hypothesis",
  ".mypy_cache",
  "node_modules",
  ".git",
  "cdk.out",
  "__tests__",
  "conftest.py",
  "*.md",
];
