#!/usr/bin/env bash
# verify-supervisor-bundle.sh
#
# Verifies that the SupervisorAgent Lambda asset produced by `cdk synth`
# actually contains the governance package (and the `common` package) that
# arbiter/supervisor/index.py's `_load_governance_package()` resolves at
# runtime relative to /var/task. The SupervisorAgent PythonFunction now
# widens its `entry` to the arbiter/ root (index='supervisor/index.py'),
# with `bundling.assetExcludes` stripping every other Lambda's source tree
# while keeping supervisor/, governance/, and common/ — see
# backend/lib/arbiter-stack.ts. This script is the guard that catches a
# regression if that bundling configuration is ever reverted or
# misconfigured (e.g. assetExcludes widened to also drop governance/common,
# or entry narrowed back to supervisor/ alone).
#
# Usage:
#   backend/scripts/verify-supervisor-bundle.sh [path-to-cdk.out]
#
# Assumes `npx cdk synth` has already run and produced a cdk.out directory
# (default: <repo-root>/backend/cdk.out, overridable via the first
# argument or the CDK_OUT_DIR env var). Intended to be invoked by CI right
# after synth, and is equally runnable by hand during local debugging.
#
# Exit codes:
#   0 - governance package + common package found in the supervisor asset
#   1 - cdk.out / supervisor asset not found, or a usage error
#   2 - supervisor asset found but governance and/or common package missing
#       (the failure this script exists to catch)
set -euo pipefail

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CDK_OUT_DIR="${1:-${CDK_OUT_DIR:-${BACKEND_DIR}/cdk.out}}"

if [ ! -d "${CDK_OUT_DIR}" ]; then
  die "cdk.out directory not found at '${CDK_OUT_DIR}'. Run 'npx cdk synth' first, or pass the path explicitly."
fi

log "Scanning for the SupervisorAgent Lambda asset under: ${CDK_OUT_DIR}"

# Identify the supervisor asset by content rather than by directory name —
# CDK asset directory names are content-hash based and not stable across
# synths, but the supervisor's own index.py is a reliable fingerprint: it
# is the only Lambda source in this repo that defines
# `_load_governance_package`. The asset root is now the arbiter/ root
# (widened entry), so index.py is found one level deeper, under a
# `supervisor/` subdirectory of the asset root — search depth 4 to allow
# for that extra nesting level relative to the previous depth-3 search.
SUPERVISOR_INDEX_FILE=""
while IFS= read -r -d '' index_file; do
  if grep -q "_load_governance_package" "${index_file}" 2>/dev/null; then
    SUPERVISOR_INDEX_FILE="${index_file}"
    break
  fi
done < <(find "${CDK_OUT_DIR}" -maxdepth 4 -type f -name "index.py" -print0 2>/dev/null)

if [ -z "${SUPERVISOR_INDEX_FILE}" ]; then
  die "Could not locate the SupervisorAgent asset (no index.py under ${CDK_OUT_DIR} defines _load_governance_package). Did 'cdk synth' complete successfully and include the ArbiterStack?"
fi

# The asset root is the parent of the supervisor/ directory that contains
# index.py (i.e. dirname twice), since governance/ and common/ are bundled
# as siblings of supervisor/ within the same asset root — not siblings of
# index.py itself.
SUPERVISOR_SUBDIR="$(dirname "${SUPERVISOR_INDEX_FILE}")"
ASSET_ROOT="$(dirname "${SUPERVISOR_SUBDIR}")"

log "Found SupervisorAgent asset at: ${ASSET_ROOT} (index.py under ${SUPERVISOR_SUBDIR})"

MISSING=0

if [ ! -f "${SUPERVISOR_SUBDIR}/index.py" ]; then
  log "MISSING: supervisor/index.py not found in the bundled asset."
  MISSING=1
fi

if [ ! -f "${ASSET_ROOT}/governance/__init__.py" ]; then
  log "MISSING: governance/__init__.py not found in the bundled asset."
  MISSING=1
fi

# A representative submodule, not just __init__.py, to catch a partial copy.
if [ ! -f "${ASSET_ROOT}/governance/hierarchy.py" ]; then
  log "MISSING: governance/hierarchy.py not found in the bundled asset."
  MISSING=1
fi

if [ ! -f "${ASSET_ROOT}/common/__init__.py" ]; then
  log "MISSING: common/__init__.py not found in the bundled asset."
  MISSING=1
fi

if [ ! -f "${ASSET_ROOT}/common/region.py" ]; then
  log "MISSING: common/region.py not found in the bundled asset (index.py imports 'from common.region import cross_region_prefix' directly)."
  MISSING=1
fi

if [ "${MISSING}" -ne 0 ]; then
  log ""
  log "FAIL: the SupervisorAgent asset at ${ASSET_ROOT} is missing required supervisor/governance/common package files."
  log "This means arbiter/supervisor/index.py's _load_governance_package() will raise ImportError at runtime,"
  log "and (with fail-closed dispatch) every agent dispatch will be refused. Check the PythonFunction entry/index and"
  log "bundling.assetExcludes for the SupervisorAgent construct in backend/lib/arbiter-stack.ts."
  exit 2
fi

log "OK: supervisor, governance, and common packages are present in the SupervisorAgent asset."
exit 0

