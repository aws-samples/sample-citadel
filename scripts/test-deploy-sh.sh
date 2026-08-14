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
