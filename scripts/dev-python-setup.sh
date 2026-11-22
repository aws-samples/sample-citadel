#!/usr/bin/env bash
# scripts/dev-python-setup.sh
#
# Creates (or reuses) a local dev virtualenv at $REPO/.venv targeting the
# Python version pinned in .python-version, and installs the same Python
# dependencies ci.yml installs for the Arbiter and Service test jobs:
#   - arbiter/requirements-ci.txt   (arbiter unit + property-based tests)
#   - service/agent_intake_single/requirements.txt       (intake runtime deps)
#   - service/agent_intake_single/requirements-dev.txt    (intake test deps)
#
# Idempotent: safe to re-run. Re-running with an existing .venv just
# reinstalls/upgrades the same pinned requirement sets in place.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/.venv"
PYTHON_VERSION_FILE="$REPO_ROOT/.python-version"

if [ ! -f "$PYTHON_VERSION_FILE" ]; then
  echo "ERROR: $PYTHON_VERSION_FILE not found — this is the single source of truth for the dev Python version." >&2
  exit 1
fi
PY_VERSION="$(tr -d '[:space:]' < "$PYTHON_VERSION_FILE")"

echo "Target Python version (from .python-version): $PY_VERSION"

if [ -d "$VENV_DIR" ]; then
  echo "Reusing existing virtualenv at $VENV_DIR"
else
  PYTHON_BIN="python${PY_VERSION}"
  if command -v "$PYTHON_BIN" >/dev/null 2>&1 && \
     "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info.releaselevel == "final" else 1)' >/dev/null 2>&1; then
    # A final-release system interpreter wins over a uv-managed build,
    # which may be a pre-release before the final X.Y.0 is cut upstream.
    echo "Creating virtualenv with system $PYTHON_BIN (final release)..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  elif command -v uv >/dev/null 2>&1; then
    echo "Creating virtualenv with uv (python $PY_VERSION)..."
    uv venv --python "$PY_VERSION" "$VENV_DIR"
  elif command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "Creating virtualenv with $PYTHON_BIN..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  else
    echo "ERROR: neither 'uv' nor '$PYTHON_BIN' is on PATH. Install uv (https://docs.astral.sh/uv/) or Python $PY_VERSION and re-run." >&2
    exit 1
  fi
fi

VENV_PY="$VENV_DIR/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "ERROR: expected $VENV_PY to exist after venv creation." >&2
  exit 1
fi

if ! "$VENV_PY" -c 'import sys; sys.exit(0 if sys.version_info.releaselevel == "final" else 1)'; then
  FOUND_VERSION="$("$VENV_PY" -c 'import sys; print("{}.{}.{}{}".format(*sys.version_info[:3], sys.version_info.releaselevel))')"
  echo "ERROR: $VENV_PY is a pre-release build ($FOUND_VERSION), not a final release." >&2
  echo "  Refusing to set up a dev environment on a pre-release interpreter." >&2
  echo "  To fix:" >&2
  echo "    - If a final Python $PY_VERSION build is listed, run: uv python install $PY_VERSION" >&2
  echo "    - Otherwise, install a system python3.15 (final) and re-run this script" >&2
  echo "      so it is found on PATH ahead of any uv-managed pre-release build." >&2
  rm -rf "$VENV_DIR"
  exit 2
fi

if command -v uv >/dev/null 2>&1; then
  # uv-created venvs don't bundle a `pip` module by default — use
  # `uv pip install` against the venv's interpreter instead, which works
  # whether the venv itself was created by `uv venv` or `python -m venv`.
  PIP_INSTALL() { uv pip install --python "$VENV_PY" "$@"; }
else
  echo "Upgrading pip..."
  "$VENV_PY" -m pip install --upgrade pip --quiet
  PIP_INSTALL() { "$VENV_DIR/bin/pip" install "$@"; }
fi

echo "Installing arbiter/requirements-ci.txt..."
PIP_INSTALL -r "$REPO_ROOT/arbiter/requirements-ci.txt"

echo "Installing service/agent_intake_single/requirements.txt..."
PIP_INSTALL -r "$REPO_ROOT/service/agent_intake_single/requirements.txt"

echo "Installing service/agent_intake_single/requirements-dev.txt..."
PIP_INSTALL -r "$REPO_ROOT/service/agent_intake_single/requirements-dev.txt"

cat <<EOF

Done. To activate the virtualenv:

  source "$VENV_DIR/bin/activate"

Then run the Python test suites the same way CI does:

  pytest arbiter/ -v --tb=short
  pytest service/ -v --tb=short

Or without activating, invoke pytest directly via the venv:

  "$VENV_DIR/bin/pytest" arbiter/ -v --tb=short
  "$VENV_DIR/bin/pytest" service/ -v --tb=short
EOF
