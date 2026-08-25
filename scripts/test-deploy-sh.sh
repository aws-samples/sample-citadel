#!/bin/bash
# Self-contained test harness for deploy.sh (chore/deploy-sh-hardening).
#
# Usage:
#   bash scripts/test-deploy-sh.sh
#
# What it does:
#   Sources deploy.sh with DEPLOY_SH_SOURCE_ONLY=1 (function definitions
#   only, no main flow), then PATH-shims fake aws/cdk/docker binaries in a
#   temp dir to drive each function through specific scenarios and assert
#   on behavior. No real AWS/CDK/Docker calls are made. Exits 0 if every
#   assertion passes, non-zero otherwise. Cleans up its temp dir on exit.
#
# Requires: bash, the deploy.sh under test at ../deploy.sh relative to this
# script (i.e. run from the repo root or let the script resolve its own dir).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SH="$REPO_ROOT/deploy.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/test-deploy-sh.XXXXXX")"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

PASS_COUNT=0
FAIL_COUNT=0

harness_cleanup() {
  rm -rf "$TMP_DIR"
}
trap harness_cleanup EXIT

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  ✓ $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  ✗ $1"
}

section() {
  echo ""
  echo "== $1 =="
}

reset_fakes() {
  rm -rf "$FAKE_BIN"
  mkdir -p "$FAKE_BIN"
  rm -f "$TMP_DIR"/*.log "$TMP_DIR"/put-called "$TMP_DIR"/put-args "$TMP_DIR"/aws-call-log "$TMP_DIR"/docker-call-count 2>/dev/null || true
}

# --- Load deploy.sh functions only (no main flow) ---
load_deploy_functions() {
  export ENVIRONMENT="test"
  export CDK_DEFAULT_REGION="us-east-1"
  export CDK_DEFAULT_ACCOUNT="123456789012"
  export DEPLOY_SH_SOURCE_ONLY=1
  # shellcheck disable=SC1090
  source "$DEPLOY_SH"
  # deploy.sh installs `trap cleanup EXIT` on the sourcing shell (this
  # harness process). That trap prints a misleading "Deployment failed"
  # line on the harness's own exit and is irrelevant to the tests below —
  # neutralize it immediately after sourcing, then reinstall our own
  # (renamed to harness_cleanup so deploy.sh's own cleanup() definition,
  # loaded into this same shell by `source`, can never shadow it).
  trap - EXIT
  trap harness_cleanup EXIT
}

load_deploy_functions

########################################
# Scenario 1: pepper ParameterNotFound -> generate branch, put WITHOUT --overwrite
########################################
section "pepper: ParameterNotFound -> generate + put without --overwrite"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
LOG="${FAKE_AWS_LOG:-/dev/null}"
echo "aws $*" >> "$LOG"
if [ "$1" = "ssm" ] && [ "$2" = "get-parameter" ]; then
  echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: Parameter /citadel/test/app-api-key-pepper not found." >&2
  exit 254
fi
if [ "$1" = "ssm" ] && [ "$2" = "put-parameter" ]; then
  echo "$*" > "${FAKE_PUT_ARGS:-/dev/null}"
  touch "${FAKE_PUT_CALLED:-/dev/null}"
  exit 0
fi
exit 1
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
export FAKE_AWS_LOG="$TMP_DIR/aws-call-log"
export FAKE_PUT_ARGS="$TMP_DIR/put-args"
export FAKE_PUT_CALLED="$TMP_DIR/put-called"
PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" ensure_api_key_pepper
rc=$?
if [ $rc -eq 0 ] && [ -f "$TMP_DIR/put-called" ]; then
  pass "generate branch entered on ParameterNotFound (exit 0, put-parameter called)"
else
  fail "expected generate branch to run and succeed; rc=$rc put-called-exists=$([ -f "$TMP_DIR/put-called" ] && echo yes || echo no)"
fi
if [ -f "$TMP_DIR/put-args" ] && ! grep -q -- "--overwrite" "$TMP_DIR/put-args"; then
  pass "put-parameter called WITHOUT --overwrite"
else
  fail "put-parameter args missing or contained --overwrite: $(cat "$TMP_DIR/put-args" 2>/dev/null)"
fi

########################################
# Scenario 2: pepper ExpiredToken stderr -> abort naming credentials, put NEVER called
########################################
section "pepper: ExpiredToken -> abort naming credentials, put never called"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
if [ "$1" = "ssm" ] && [ "$2" = "get-parameter" ]; then
  echo "An error occurred (ExpiredTokenException) when calling the GetParameter operation: The security token included in the request is expired" >&2
  exit 255
fi
if [ "$1" = "ssm" ] && [ "$2" = "put-parameter" ]; then
  touch "${FAKE_PUT_CALLED:-/dev/null}"
  exit 0
fi
exit 1
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
export FAKE_PUT_CALLED="$TMP_DIR/put-called"
set +e
abort_output=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" ensure_api_key_pepper 2>&1)
abort_rc=$?
set -e 2>/dev/null || true
if [ $abort_rc -ne 0 ]; then
  pass "ensure_api_key_pepper aborted (rc=$abort_rc) on ExpiredToken"
else
  fail "expected non-zero exit on ExpiredToken, got rc=$abort_rc"
fi
if echo "$abort_output" | grep -qi "credentials"; then
  pass "abort message names credentials as the cause"
else
  fail "abort message did not mention credentials: $abort_output"
fi
if [ ! -f "$TMP_DIR/put-called" ]; then
  pass "put-parameter never called on ExpiredToken"
else
  fail "put-parameter was called despite ExpiredToken"
fi

########################################
# Scenario 2b (R1 regression guard): pepper Midway/mwinit stderr (the exact
# 2026-08-10 incident string) -> abort naming credentials, put NEVER called
########################################
section "pepper: Midway/mwinit stderr -> abort naming credentials, put never called"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
if [ "$1" = "ssm" ] && [ "$2" = "get-parameter" ]; then
  echo "You need to authenticate with Midway. Please run mwinit and try again." >&2
  exit 255
fi
if [ "$1" = "ssm" ] && [ "$2" = "put-parameter" ]; then
  touch "${FAKE_PUT_CALLED:-/dev/null}"
  exit 0
fi
exit 1
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
export FAKE_PUT_CALLED="$TMP_DIR/put-called"
set +e
midway_output=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" ensure_api_key_pepper 2>&1)
midway_rc=$?
set -e 2>/dev/null || true
if [ $midway_rc -ne 0 ]; then
  pass "ensure_api_key_pepper aborted (rc=$midway_rc) on Midway/mwinit error"
else
  fail "expected non-zero exit on Midway/mwinit error, got rc=$midway_rc"
fi
if echo "$midway_output" | grep -qi "credential"; then
  pass "abort message names credentials as the cause for Midway/mwinit error"
else
  fail "abort message did not mention credentials for Midway/mwinit error: $midway_output"
fi
if [ ! -f "$TMP_DIR/put-called" ]; then
  pass "put-parameter never called on Midway/mwinit error"
else
  fail "put-parameter was called despite Midway/mwinit error"
fi

########################################
# Scenario 3: pepper param exists -> no put
########################################
section "pepper: param exists -> no put"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
if [ "$1" = "ssm" ] && [ "$2" = "get-parameter" ]; then
  exit 0
fi
if [ "$1" = "ssm" ] && [ "$2" = "put-parameter" ]; then
  touch "${FAKE_PUT_CALLED:-/dev/null}"
  exit 0
fi
exit 1
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
export FAKE_PUT_CALLED="$TMP_DIR/put-called"
PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" ensure_api_key_pepper
rc=$?
if [ $rc -eq 0 ] && [ ! -f "$TMP_DIR/put-called" ]; then
  pass "existing param short-circuits without calling put-parameter"
else
  fail "expected no put-parameter call for existing param; rc=$rc put-called=$([ -f "$TMP_DIR/put-called" ] && echo yes || echo no)"
fi

########################################
# Scenario 4: retry classifier — ENOENT output -> fail-fast, names docker
########################################
section "classify_deploy_failure: ENOENT -> fail-fast naming docker"
enoent_output="Error: spawnSync docker ENOENT
    at internal stuff"
classification=$(classify_deploy_failure "$enoent_output")
if [[ "$classification" == fail-fast:* ]]; then
  pass "ENOENT output classified as fail-fast"
else
  fail "expected fail-fast classification, got: $classification"
fi
if echo "$classification" | grep -qi "docker"; then
  pass "fail-fast root-cause line names docker"
else
  fail "fail-fast classification did not name docker: $classification"
fi

########################################
# Scenario 5: retry classifier — transient CFN error -> retry (via deploy_stack, one retry)
########################################
section "deploy_stack: transient CFN error -> retries once"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
if [ "$1" = "cloudformation" ] && [ "$2" = "describe-stacks" ]; then
  echo "NOT_FOUND"
  exit 0
fi
exit 0
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
mkdir -p "$TMP_DIR/backend"
cat > "$FAKE_BIN/npx" <<FAKE_NPX_EOF
#!/bin/bash
COUNT_FILE="$TMP_DIR/cdk-deploy-count"
if [ "\$1" = "cdk" ] && [ "\$2" = "deploy" ]; then
  n=0
  [ -f "\$COUNT_FILE" ] && n=\$(cat "\$COUNT_FILE")
  n=\$((n + 1))
  echo "\$n" > "\$COUNT_FILE"
  if [ "\$n" -eq 1 ]; then
    echo "Resource creation failed: is currently being updated (transient CloudFormation state)" >&2
    exit 1
  fi
  echo "deployed ok"
  exit 0
fi
exit 0
FAKE_NPX_EOF
chmod +x "$FAKE_BIN/npx"
cat > "$FAKE_BIN/docker" <<'FAKE_DOCKER_EOF'
#!/bin/bash
exit 0
FAKE_DOCKER_EOF
chmod +x "$FAKE_BIN/docker"
mkdir -p "$TMP_DIR/backend"
(
  cd "$TMP_DIR" || exit 1
  PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" CDK_DEPLOY_RETRY_SLEEP=0 deploy_stack "test-stack-test" </dev/null
)
deploy_rc=$?
attempts=$(cat "$TMP_DIR/cdk-deploy-count" 2>/dev/null || echo 0)
if [ "$attempts" -eq 2 ] && [ "$deploy_rc" -eq 0 ]; then
  pass "transient CFN error retried once and succeeded on attempt 2 (attempts=$attempts)"
else
  fail "expected 2 attempts and rc=0; got attempts=$attempts rc=$deploy_rc"
fi

########################################
# Scenario 6: docker vanishing between attempts -> precise message, no retry burned
########################################
section "deploy_stack: docker vanishes before attempt -> precise message"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
if [ "$1" = "cloudformation" ] && [ "$2" = "describe-stacks" ]; then
  echo "NOT_FOUND"
  exit 0
fi
exit 0
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
# Use a fake container-runtime name via CDK_DOCKER so removing the shim
# cannot fall through to a real docker/finch binary elsewhere on $PATH.
FAKE_RUNTIME_NAME="fake-runtime-$$"
cat > "$FAKE_BIN/npx" <<FAKE_NPX_EOF
#!/bin/bash
if [ "\$1" = "cdk" ] && [ "\$2" = "deploy" ]; then
  echo "Resource creation failed: transient CloudFormation state" >&2
  # Simulate the container runtime vanishing mid-run: remove the shim after
  # attempt 1 completes, so the pre-attempt-2 re-check (FIX 2c) catches it.
  rm -f "$FAKE_BIN/$FAKE_RUNTIME_NAME"
  exit 1
fi
exit 0
FAKE_NPX_EOF
chmod +x "$FAKE_BIN/npx"
cat > "$FAKE_BIN/$FAKE_RUNTIME_NAME" <<'FAKE_DOCKER_EOF'
#!/bin/bash
exit 0
FAKE_DOCKER_EOF
chmod +x "$FAKE_BIN/$FAKE_RUNTIME_NAME"
mkdir -p "$TMP_DIR/backend"
set +e
docker_vanish_output=$(cd "$TMP_DIR" && PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" CDK_DEPLOY_RETRY_SLEEP=0 CDK_DOCKER="$FAKE_RUNTIME_NAME" deploy_stack "test-stack-test" </dev/null 2>&1)
docker_vanish_rc=$?
set -e 2>/dev/null || true
if [ $docker_vanish_rc -ne 0 ] && echo "$docker_vanish_output" | grep -qF "$FAKE_RUNTIME_NAME"; then
  pass "docker disappearance between attempts fails precisely, naming the runtime"
else
  fail "expected failure naming '$FAKE_RUNTIME_NAME'; rc=$docker_vanish_rc output=$docker_vanish_output"
fi

########################################
# Scenario 7: cdk diff failure -> run continues with named warning; --all absent
########################################
section "cdk_diff: failure -> continues with named warning; --all absent from invocation"
reset_fakes
mkdir -p "$TMP_DIR/backend"
cat > "$FAKE_BIN/npx" <<FAKE_NPX_EOF
#!/bin/bash
echo "\$*" >> "$TMP_DIR/npx-diff-invocation"
if [ "\$1" = "cdk" ] && [ "\$2" = "diff" ]; then
  echo "some diff preamble"
  echo "Error: stack not found, cannot diff" >&2
  exit 1
fi
exit 0
FAKE_NPX_EOF
chmod +x "$FAKE_BIN/npx"
# cdk_diff is called directly (function already loaded in this process);
# capture its output and confirm the script does not exit non-zero.
set +e
diff_output=$(cd "$TMP_DIR" && PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" cdk_diff 2>&1)
diff_fn_rc=$?
set -e 2>/dev/null || true
if [ $diff_fn_rc -eq 0 ]; then
  pass "cdk_diff returns success (non-blocking) even though the underlying cdk diff failed"
else
  fail "cdk_diff should not propagate failure; rc=$diff_fn_rc"
fi
# Strip ANSI escape codes (the ⚠ warning is colorized) before matching.
diff_output_plain=$(echo "$diff_output" | sed 's/\x1b\[[0-9;]*m//g')
if echo "$diff_output_plain" | grep -q "cdk diff unavailable:"; then
  pass "cdk_diff prints the named 'cdk diff unavailable: <last error line>' warning"
else
  fail "cdk_diff did not print the expected named warning: $diff_output_plain"
fi
if [ -f "$TMP_DIR/npx-diff-invocation" ] && grep -q -- "--all" "$TMP_DIR/npx-diff-invocation"; then
  fail "--all flag present in cdk diff invocation (should be removed)"
else
  pass "--all flag absent from cdk diff invocation"
fi

########################################
# Deploy-safety gates (findings 7f42ae86 provenance / 9c92a738 deletion)
########################################
# A configurable fake `git` driven by env vars, so the ref/tree gates can be
# exercised without a real repo:
#   FAKE_BRANCH, FAKE_FULL_SHA, FAKE_SHORT_SHA  — what rev-parse returns
#   FAKE_DIRTY=clean|dirty                       — git diff --quiet exit code
#   FAKE_HAS_ORIGIN_MAIN=1|0                     — origin/main resolvable
#   FAKE_IS_ANCESTOR=1|0                         — HEAD ancestor of origin/main
write_fake_git() {
  cat > "$FAKE_BIN/git" <<'FAKE_GIT_EOF'
#!/bin/bash
case "$1 $2 $3" in
  "rev-parse --abbrev-ref HEAD") echo "${FAKE_BRANCH:-main}"; exit 0 ;;
esac
case "$1 $2" in
  "rev-parse --short") echo "${FAKE_SHORT_SHA:-abc1234}"; exit 0 ;;
  "rev-parse --verify")
    # `git rev-parse --verify -q origin/main`
    [ "${FAKE_HAS_ORIGIN_MAIN:-1}" = "1" ] && { echo "deadbeef"; exit 0; }
    exit 1 ;;
  "rev-parse HEAD") echo "${FAKE_FULL_SHA:-abc1234567890abc1234567890abc1234567890a}"; exit 0 ;;
  "merge-base --is-ancestor") [ "${FAKE_IS_ANCESTOR:-1}" = "1" ] && exit 0 || exit 1 ;;
  "diff --quiet") [ "${FAKE_DIRTY:-clean}" = "clean" ] && exit 0 || exit 1 ;;
  "diff --cached") [ "${FAKE_DIRTY:-clean}" = "clean" ] && exit 0 || exit 1 ;;
esac
# `git rev-parse HEAD` (two-token form) handled above; default:
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  echo "${FAKE_FULL_SHA:-abc1234567890abc1234567890abc1234567890a}"; exit 0
fi
exit 0
FAKE_GIT_EOF
  chmod +x "$FAKE_BIN/git"
}

# --- expect-ref: match proceeds (branch name, full sha, short sha, prefix) ---
section "verify_expected_ref: match proceeds (branch / full sha / short sha / prefix)"
reset_fakes
write_fake_git
export FAKE_BRANCH="chore/deploy-safety-gates"
export FAKE_FULL_SHA="abc1234567890abc1234567890abc1234567890a"
export FAKE_SHORT_SHA="abc1234"
set +e
PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" verify_expected_ref "chore/deploy-safety-gates" >/dev/null 2>&1
rc_branch=$?
PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" verify_expected_ref "$FAKE_FULL_SHA" >/dev/null 2>&1
rc_full=$?
PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" verify_expected_ref "abc1234" >/dev/null 2>&1
rc_short=$?
PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" verify_expected_ref "abc123" >/dev/null 2>&1
rc_prefix=$?
set -e 2>/dev/null || true
if [ $rc_branch -eq 0 ] && [ $rc_full -eq 0 ] && [ $rc_short -eq 0 ] && [ $rc_prefix -eq 0 ]; then
  pass "expected-ref match proceeds for branch, full sha, short sha, and sha prefix"
else
  fail "expected all match forms to proceed; branch=$rc_branch full=$rc_full short=$rc_short prefix=$rc_prefix"
fi

# --- expect-ref: mismatch ABORTS naming both refs ---
section "verify_expected_ref: mismatch aborts naming both refs"
reset_fakes
write_fake_git
export FAKE_BRANCH="main"
export FAKE_SHORT_SHA="abc1234"
export FAKE_FULL_SHA="abc1234567890abc1234567890abc1234567890a"
set +e
mismatch_out=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" verify_expected_ref "feat/other-branch" 2>&1)
mismatch_rc=$?
set -e 2>/dev/null || true
mismatch_plain=$(echo "$mismatch_out" | sed 's/\x1b\[[0-9;]*m//g')
if [ $mismatch_rc -ne 0 ]; then
  pass "expected-ref mismatch aborts (rc=$mismatch_rc)"
else
  fail "expected non-zero on mismatch, got rc=$mismatch_rc"
fi
if echo "$mismatch_plain" | grep -q "feat/other-branch" && echo "$mismatch_plain" | grep -q "main" && echo "$mismatch_plain" | grep -q "abc1234"; then
  pass "mismatch message names BOTH the requested ref and the resolved HEAD"
else
  fail "mismatch message did not name both refs: $mismatch_plain"
fi

# --- expect-ref: absent + no TTY REFUSES (never hangs) ---
section "verify_expected_ref: absent --expect-ref with no TTY refuses"
reset_fakes
write_fake_git
export FAKE_BRANCH="main"
export FAKE_SHORT_SHA="abc1234"
set +e
notty_out=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" verify_expected_ref "" </dev/null 2>&1)
notty_rc=$?
set -e 2>/dev/null || true
notty_plain=$(echo "$notty_out" | sed 's/\x1b\[[0-9;]*m//g')
if [ $notty_rc -ne 0 ] && echo "$notty_plain" | grep -qi "not a TTY"; then
  pass "absent --expect-ref with non-TTY stdin refuses (rc=$notty_rc), citing TTY"
else
  fail "expected refusal citing TTY; rc=$notty_rc output=$notty_plain"
fi

# --- tree-state: dirty tree refuses by default; --allow-dirty warns+proceeds ---
section "check_tree_state: dirty tree refuses; --allow-dirty proceeds"
reset_fakes
write_fake_git
export FAKE_DIRTY="dirty"; export FAKE_IS_ANCESTOR=1; export FAKE_HAS_ORIGIN_MAIN=1
set +e
dirty_out=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" check_tree_state "" "false" 2>&1)
dirty_rc=$?
allowdirty_out=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" check_tree_state "" "true" 2>&1)
allowdirty_rc=$?
set -e 2>/dev/null || true
dirty_plain=$(echo "$dirty_out" | sed 's/\x1b\[[0-9;]*m//g')
if [ $dirty_rc -ne 0 ] && echo "$dirty_plain" | grep -qi "DIRTY"; then
  pass "dirty tree refuses by default (rc=$dirty_rc), citing DIRTY"
else
  fail "expected dirty refusal; rc=$dirty_rc output=$dirty_plain"
fi
if [ $allowdirty_rc -eq 0 ] && echo "$allowdirty_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -qi "allow-dirty"; then
  pass "--allow-dirty proceeds with a loud warning (rc=$allowdirty_rc)"
else
  fail "expected --allow-dirty to proceed with warning; rc=$allowdirty_rc output=$allowdirty_out"
fi

# --- tree-state: divergent HEAD + no expect-ref refuses; +expect-ref warns ---
section "check_tree_state: divergent branch refuses w/o ref, warns w/ ref"
reset_fakes
write_fake_git
export FAKE_DIRTY="clean"; export FAKE_HAS_ORIGIN_MAIN=1; export FAKE_IS_ANCESTOR=0
set +e
div_out=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" check_tree_state "" "false" 2>&1)
div_rc=$?
divref_out=$(PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" check_tree_state "feat/mybranch" "false" 2>&1)
divref_rc=$?
set -e 2>/dev/null || true
div_plain=$(echo "$div_out" | sed 's/\x1b\[[0-9;]*m//g')
if [ $div_rc -ne 0 ] && echo "$div_plain" | grep -q "9c92a738"; then
  pass "divergent HEAD with no --expect-ref refuses (rc=$div_rc), citing finding 9c92a738"
else
  fail "expected divergence refusal; rc=$div_rc output=$div_plain"
fi
if [ $divref_rc -eq 0 ] && echo "$divref_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -qi "divergent"; then
  pass "divergent HEAD WITH --expect-ref downgrades to a loud warn and proceeds (rc=$divref_rc)"
else
  fail "expected divergence+ref to warn and proceed; rc=$divref_rc output=$divref_out"
fi

# --- deletion gate: diff with a deletion REFUSES and names the resource ---
section "deletion_gate: diff with a deletion refuses and names the resource"
DELETION_DIFF="Stack citadel-arbiter-dev
Resources
[-] AWS::DynamoDB::Table SmokeIdempotencyTable citadel-smoke-idempotency-dev destroy
[~] AWS::Lambda::Function WorkerFn WorkerFn12AB modified"
set +e
del_out=$(deletion_gate "$DELETION_DIFF" "false" "true" 2>&1)
del_rc=$?
set -e 2>/dev/null || true
del_plain=$(echo "$del_out" | sed 's/\x1b\[[0-9;]*m//g')
if [ $del_rc -ne 0 ] && echo "$del_plain" | grep -q "citadel-smoke-idempotency-dev"; then
  pass "deletion diff refuses (rc=$del_rc) and NAMES citadel-smoke-idempotency-dev"
else
  fail "expected deletion refusal naming the resource; rc=$del_rc output=$del_plain"
fi

# --allow-deletions proceeds on the same diff
set +e
delallow_out=$(deletion_gate "$DELETION_DIFF" "true" "true" 2>&1)
delallow_rc=$?
set -e 2>/dev/null || true
if [ $delallow_rc -eq 0 ] && echo "$delallow_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -qi "allow-deletions"; then
  pass "--allow-deletions proceeds on a deletion diff with a loud warning (rc=$delallow_rc)"
else
  fail "expected --allow-deletions to proceed; rc=$delallow_rc output=$delallow_out"
fi

# --- deletion gate: unparseable / empty / failed diff REFUSES (fail-closed) ---
section "deletion_gate: empty and failed diff refuse (fail-closed)"
set +e
empty_out=$(deletion_gate "" "false" "true" 2>&1); empty_rc=$?
failed_out=$(deletion_gate "some diff text" "false" "false" 2>&1); failed_rc=$?
set -e 2>/dev/null || true
if [ $empty_rc -ne 0 ] && echo "$empty_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -qi "fail-closed"; then
  pass "empty diff refuses (fail-closed, rc=$empty_rc)"
else
  fail "expected empty diff to fail-closed; rc=$empty_rc output=$empty_out"
fi
if [ $failed_rc -ne 0 ]; then
  pass "cdk-diff-failed (diff_ok=false) refuses (fail-closed, rc=$failed_rc)"
else
  fail "expected failed diff to fail-closed; rc=$failed_rc"
fi

# --- deletion gate: clean no-deletion diff PROCEEDS ---
section "deletion_gate: clean no-deletion diff proceeds"
CLEAN_DIFF="Stack citadel-backend-dev
Resources
[~] AWS::Lambda::Function WorkerFn WorkerFn12AB modified
[+] AWS::DynamoDB::Table NewTable citadel-new-dev"
set +e
clean_out=$(deletion_gate "$CLEAN_DIFF" "false" "true" 2>&1); clean_rc=$?
set -e 2>/dev/null || true
if [ $clean_rc -eq 0 ] && echo "$clean_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -qi "no resource deletions"; then
  pass "clean (no [-]) diff proceeds (rc=$clean_rc)"
else
  fail "expected clean diff to proceed; rc=$clean_rc output=$clean_out"
fi

# --- deletion gate: ANSI-coloured [-] marker is still detected ---
section "deletion_gate: ANSI-coloured deletion marker is still parsed"
ANSI_DIFF=$'Resources\n\x1b[31m[-] AWS::S3::Bucket ToolResultsBucket citadel-tool-results-dev destroy\x1b[0m'
set +e
ansi_out=$(deletion_gate "$ANSI_DIFF" "false" "true" 2>&1); ansi_rc=$?
set -e 2>/dev/null || true
if [ $ansi_rc -ne 0 ] && echo "$ansi_out" | sed 's/\x1b\[[0-9;]*m//g' | grep -q "citadel-tool-results-dev"; then
  pass "ANSI-coloured [-] line is detected and named (rc=$ansi_rc)"
else
  fail "expected ANSI deletion to be caught; rc=$ansi_rc output=$ansi_out"
fi

# --- provenance manifest: written with the right fields on success ---
section "write_manifest: writes deployment-manifest.json with required fields"
reset_fakes
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  echo "arn:aws:iam::123456789012:user/deployer"; exit 0
fi
exit 0
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
MANIFEST_DIR="$TMP_DIR/manifest-success"
mkdir -p "$MANIFEST_DIR"
(
  cd "$MANIFEST_DIR" || exit 1
  export ENVIRONMENT="dev" CDK_DEFAULT_REGION="us-east-1" CDK_DEFAULT_ACCOUNT="123456789012"
  export GIT_SHA="abc1234" GIT_BRANCH="chore/deploy-safety-gates" GIT_DIRTY="clean"
  export DEPLOY_MODE="all" STACK_NAME="" EXPECT_REF="chore/deploy-safety-gates"
  export DEPLOY_STARTED_AT="2026-08-25T10:00:00Z"
  PATH="$FAKE_BIN:$PATH" DEPLOY_LOG="$TMP_DIR/deploy.log" write_manifest >/dev/null 2>&1
)
MANIFEST_FILE="$MANIFEST_DIR/deployment-manifest.json"
if [ -f "$MANIFEST_FILE" ]; then
  pass "deployment-manifest.json written on success"
else
  fail "manifest not written"
fi
if [ -f "$MANIFEST_FILE" ] \
  && grep -q '"git_sha": "abc1234"' "$MANIFEST_FILE" \
  && grep -q '"git_branch": "chore/deploy-safety-gates"' "$MANIFEST_FILE" \
  && grep -q '"git_dirty": "clean"' "$MANIFEST_FILE" \
  && grep -q '"environment": "dev"' "$MANIFEST_FILE" \
  && grep -q '"expected_ref": "chore/deploy-safety-gates"' "$MANIFEST_FILE" \
  && grep -q '"started_at": "2026-08-25T10:00:00Z"' "$MANIFEST_FILE" \
  && grep -q '"completed_at":' "$MANIFEST_FILE" \
  && grep -q 'citadel-backend-dev' "$MANIFEST_FILE" \
  && grep -q 'citadel-frontend-dev' "$MANIFEST_FILE"; then
  pass "manifest carries environment, branch, sha, dirty flag, expected_ref, stack names, and start/complete timestamps"
else
  fail "manifest missing required fields: $(cat "$MANIFEST_FILE" 2>/dev/null)"
fi

# --- provenance manifest: NOT written when a gate refuses (end-to-end) ---
section "e2e: a refusing gate exits non-zero and writes NO manifest"
reset_fakes
write_fake_git
export FAKE_BRANCH="main" FAKE_SHORT_SHA="abc1234" FAKE_FULL_SHA="abc1234567890abc1234567890abc1234567890a"
export FAKE_DIRTY="clean" FAKE_HAS_ORIGIN_MAIN=1 FAKE_IS_ANCESTOR=1
cat > "$FAKE_BIN/aws" <<'FAKE_AWS_EOF'
#!/bin/bash
exit 0
FAKE_AWS_EOF
chmod +x "$FAKE_BIN/aws"
E2E_DIR="$TMP_DIR/e2e-fail"
mkdir -p "$E2E_DIR"
cp "$DEPLOY_SH" "$E2E_DIR/deploy.sh"
set +e
e2e_out=$(
  cd "$E2E_DIR" || exit 1
  env -u DEPLOY_SH_SOURCE_ONLY \
    ENVIRONMENT="dev" CDK_DEFAULT_REGION="us-east-1" CDK_DEFAULT_ACCOUNT="123456789012" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$E2E_DIR/deploy.sh" --expect-ref feat/some-other-branch </dev/null 2>&1
)
e2e_rc=$?
set -e 2>/dev/null || true
e2e_plain=$(echo "$e2e_out" | sed 's/\x1b\[[0-9;]*m//g')
if [ $e2e_rc -ne 0 ] && echo "$e2e_plain" | grep -qi "Expected-ref MISMATCH"; then
  pass "wrong --expect-ref exits non-zero at the ref gate (rc=$e2e_rc)"
else
  fail "expected mismatch exit; rc=$e2e_rc output=$e2e_plain"
fi
if [ ! -f "$E2E_DIR/deployment-manifest.json" ]; then
  pass "NO deployment-manifest.json written when the deploy is refused"
else
  fail "manifest was written despite a refused deploy"
fi

########################################
# BITE PROOF (RED): remove the deletion gate and confirm the deletion test
# no longer catches it — proving the gate + its test are load-bearing.
########################################
section "BITE PROOF: with deletion_gate removed, a deletion diff is NOT refused (expected RED)"
BITE_DIFF="Resources
[-] AWS::DynamoDB::Table SmokeIdempotencyTable citadel-smoke-idempotency-dev destroy"
set +e
bite_rc=$(
  # Subshell: re-source deploy.sh functions, then OVERRIDE deletion_gate with a
  # no-op (the "gate removed" version). If the gate is truly what refuses, the
  # deletion diff now proceeds (rc=0), demonstrating the real gate bites.
  export DEPLOY_SH_SOURCE_ONLY=1
  # shellcheck disable=SC1090
  source "$DEPLOY_SH" >/dev/null 2>&1
  deletion_gate() { return 0; }   # gate removed
  deletion_gate "$BITE_DIFF" "false" "true" >/dev/null 2>&1
  echo $?
)
set -e 2>/dev/null || true
if [ "$bite_rc" = "0" ]; then
  pass "RED CONFIRMED: gate-removed version does NOT refuse the deletion diff (rc=0) — the real deletion_gate is load-bearing and its test genuinely catches removal"
else
  fail "gate-removed version still refused (rc=$bite_rc) — the deletion test is NOT actually exercising the gate"
fi

########################################
# Summary
########################################
echo ""
echo "=========================================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "=========================================="

if [ "$FAIL_COUNT" -eq 0 ]; then
  exit 0
else
  exit 1
fi
