#!/usr/bin/env bash
# split-gates.sh
#
# Runs all 7 backend-stack-split safety rails against a FRESH `cdk synth`
# and prints a summary. Non-zero exit on any rail failure.
#
#   rail 1 - removals-only diff              (run-rails.ts)
#   rail 2 - stateful logical-ID pin         (jest: split-gates-rail2-stateful-pin.test.ts)
#   rail 3 - resolver parity                 (run-rails.ts)
#   rail 4 - doc-claims stack-count check     (grep, this script)
#   rail 5 - cdk-nag                          (npm run nag, existing convention)
#   rail 6 - IAM privilege-equivalence        (run-rails.ts)
#   rail 7 - resolver behavioral equivalence  (run-rails.ts)
#
# This stage moves ZERO resources: rails 3/6/7 pass trivially (empty move
# manifest), and every other rail proves the committed baseline matches the
# current unmoved synth.
#
# Usage:
#   backend/scripts/split-gates.sh [env]   (default env: dev)
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV="${1:-dev}"
STACK_NAME="citadel-backend-${ENV}"

cd "${BACKEND_DIR}"

OVERALL_STATUS=0

log "=== split-gates: synthesizing ${STACK_NAME} ==="
if ! npx cdk synth "${STACK_NAME}" --quiet >/dev/null; then
  die "cdk synth failed for ${STACK_NAME}"
fi

# Also synth every satellite stack participating in the split (per
# move-manifest.ts's SATELLITE_STACK_NAMES) so rails 3/6/7 compare against
# a FRESH satellite template, never a stale one left over from a previous
# manual synth. citadel-projects-dev is the phase-1 satellite;
# citadel-registry-dev is the phase-2 satellite. Extend this list as later
# phases add satellites.
SATELLITE_STACKS="citadel-projects-${ENV} citadel-registry-${ENV}"
for sat in ${SATELLITE_STACKS}; do
  log "=== split-gates: synthesizing ${sat} ==="
  if ! npx cdk synth "${sat}" --quiet >/dev/null; then
    die "cdk synth failed for ${sat}"
  fi
done

if [ ! -f "split-baseline/${STACK_NAME}.json" ]; then
  log "No committed baseline found at split-baseline/${STACK_NAME}.json — capturing it now."
  npx ts-node -P tsconfig.scripts.json scripts/split-baseline.ts --env "${ENV}" || die "baseline capture failed"
fi

log ""
log "=== rails 1, 3, 6, 7 (removals-only / resolver-parity / IAM-equivalence / resolver-equivalence) ==="
if ! npx ts-node -P tsconfig.scripts.json scripts/split-gates/run-rails.ts --env "${ENV}"; then
  OVERALL_STATUS=1
fi

log ""
log "=== rail 2 (stateful logical-ID pin, via jest) ==="
if ! SPLIT_GATES_ENV="${ENV}" npx jest test/split-gates-rail2-stateful-pin.test.ts --silent=false; then
  OVERALL_STATUS=1
fi

log ""
log "=== rail 4 (doc-claims stack-count check) ==="
STACK_COUNT="$(grep -cE '=\s*new [A-Za-z]+Stack\(' bin/app.ts || true)"
log "bin/app.ts declares approximately ${STACK_COUNT} stack instantiations."
if grep -Eq '\b7 stacks\b|\bseven[- ]stacks\b' ../docs/ARCHITECTURE.md ../README.md 2>/dev/null; then
  if [ "${STACK_COUNT}" != "7" ]; then
    log "FAIL: docs still claim '7 stacks' but bin/app.ts declares ${STACK_COUNT}."
    OVERALL_STATUS=1
  else
    log "PASS: doc-claims stack count matches bin/app.ts (${STACK_COUNT})."
  fi
else
  log "PASS: no stale '7 stacks' doc claim found (or docs not present in this checkout)."
fi

log ""
log "=== rail 5 (cdk-nag) ==="
if ! npx cdk synth "${STACK_NAME}" --quiet -c nag=true >/dev/null 2>&1; then
  log "FAIL: cdk-nag reported unsuppressed findings for ${STACK_NAME} (see AwsSolutions--${STACK_NAME}-NagReport.csv)."
  OVERALL_STATUS=1
else
  log "PASS: cdk-nag reported no unsuppressed findings for ${STACK_NAME}."
fi

log ""
if [ "${OVERALL_STATUS}" -eq 0 ]; then
  log "=== split-gates: ALL RAILS PASSED for ${STACK_NAME} ==="
else
  log "=== split-gates: ONE OR MORE RAILS FAILED for ${STACK_NAME} ==="
fi

exit "${OVERALL_STATUS}"
