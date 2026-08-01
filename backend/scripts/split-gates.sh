#!/usr/bin/env bash
# split-gates.sh
#
# Runs all 7 backend-stack-split safety rails against a FRESH `cdk synth`
# and prints a summary. Non-zero exit on any rail failure.
#
#   rail 1' - tracing-only diff (optional)   (tracing-only-diff.ts; see below)
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
#   TRACING_ONLY_DIFF_BASELINE=<path> backend/scripts/split-gates.sh [env]
#     — runs rail 1' against a pre-tracing CfnTemplate snapshot (see rail 1'
#     block below). Only needed for the tracing-substrate commit itself.
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
log "=== rail 1' (tracing-only diff, optional — tracing-substrate commits only) ==="
# Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c,
# design §3.1): for the ONE commit that introduces the EnableLambdaTracing
# Aspect (or any later commit that intentionally touches only tracing), set
# TRACING_ONLY_DIFF_BASELINE to a full CfnTemplate captured via `cdk synth`
# BEFORE that commit's changes (NOT split-baseline/*.json — see
# tracing-only-diff.ts's doc comment: the committed baseline only stores
# full Properties for stateful resource types, so comparing against it
# produces false-positive violations on every Lambda/Role property). This
# check REPLACES rail 1 as the meaningful gate for a tracing-only commit,
# since rail 1 trivially passes once the baseline below is regenerated and
# proves nothing about intent. In steady state (no env var set) this block
# is a no-op/skip — it is NOT part of the normal 7-rail gate.
if [ -n "${TRACING_ONLY_DIFF_BASELINE:-}" ]; then
  if ! npx ts-node -P tsconfig.scripts.json scripts/split-gates/tracing-only-diff.ts \
    --old "${TRACING_ONLY_DIFF_BASELINE}" --env "${ENV}"; then
    OVERALL_STATUS=1
  fi
else
  log "skipped: TRACING_ONLY_DIFF_BASELINE not set (only required for a tracing-substrate commit)."
fi

# NOTE on baseline regeneration (deviation from the original tracing design
# §3 procedure): the design assumed the tracing commit must regenerate
# split-baseline/citadel-backend-<env>.json in the same commit. In practice
# that is WRONG for this repo's current state and must NOT be done:
#   1. TracingConfig=Active was ALREADY present on backend/arbiter Lambdas
#      before this commit (a pre-existing "O-03" forEach in backend-stack.ts/
#      arbiter-stack.ts) — only the AWSXRayDaemonWriteAccess managed policy
#      was missing. So this commit's real backend delta is IAM-only, not a
#      template-wide TracingConfig rollout.
#   2. Regenerating the baseline from the CURRENT (already-split) backend
#      template destructively drops the pre-split resolver/IAM history that
#      rails 3/6/7 (move-manifest.ts's MOVED_RESOLVERS/MOVED_LAMBDA_ROLES)
#      depend on to verify the projects/registry satellite moves — rails 3/6/7
#      FAIL immediately after such a regeneration (verified: 62/22/62
#      violations) because the moved resolvers/roles no longer exist in the
#      regenerated "baseline" to compare the satellites against.
#   3. Rails 1/2/3/6/7 already pass with NO baseline change: rail 1's byte-
#      identity check (keyPropsEqual) only compares STATEFUL_KEY_PROPS,
#      which never included TracingConfig/ManagedPolicyArns, so the IAM
#      addition is invisible to it — exactly as intended (least-privilege
#      additions to non-stateful resources are not a "removal" or a
#      stateful-property change).
# Conclusion: no baseline write for this commit. If a FUTURE commit
# genuinely needs to regenerate the baseline (e.g. after a real move stage),
# do so from split-baseline.ts as documented there — just not as part of a
# tracing-only change.

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
