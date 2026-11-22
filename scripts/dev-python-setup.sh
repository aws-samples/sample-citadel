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
  if command -v uv >/dev/null 2>&1; then
    echo "Creating virtualenv with uv (python $PY_VERSION)..."
    uv venv --python "$PY_VERSION" "$VENV_DIR"
  else
    PYTHON_BIN="python${PY_VERSION}"
    if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
      echo "ERROR: neither 'uv' nor '$PYTHON_BIN' is on PATH. Install uv (https://docs.astral.sh/uv/) or Python $PY_VERSION and re-run." >&2
      exit 1
    fi
    echo "Creating virtualenv with $PYTHON_BIN..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
fi

VENV_PY="$VENV_DIR/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "ERROR: expected $VENV_PY to exist after venv creation." >&2
  exit 1
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
