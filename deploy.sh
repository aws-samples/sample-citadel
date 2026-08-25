#!/bin/bash
# Citadel Deployment Script
#
# Usage:
#   ./deploy.sh [options] [stack-name]
#
# Options:
#   --all                Deploy all stacks (default)
#   --backend-only       Deploy only backend stacks
#   --frontend-only      Deploy only frontend stack
#   --skip-frontend      Skip frontend build
#   --skip-backend       Skip backend build
#   --profile <name>     Use specific AWS profile
#   --dry-run            Preview changes without deploying (cdk diff only)
#   --no-verify          Skip post-deploy health checks
#   --admin-email <addr>  Admin email for initial user (overrides ADMIN_EMAIL env var)
#   --help               Show this help message

set -euo pipefail

# --- Constants ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_LOG="${SCRIPT_DIR}/deploy-$(date +%Y%m%d-%H%M%S).log"
REQUIRED_VARS=("ENVIRONMENT" "CDK_DEFAULT_REGION" "CDK_DEFAULT_ACCOUNT")
# Every stack backend/bin/app.ts defines, in deploy (dependency) order,
# WITHOUT the -$ENVIRONMENT suffix. verify_stack_coverage checks this list
# against `npx cdk list` on every run and aborts on any mismatch, so a new
# stack added to bin/app.ts cannot be silently skipped by this script.
KNOWN_STACKS=(
  "citadel-backend"
  "citadel-projects"
  "citadel-registry"
  "citadel-services"
  "citadel-gateway"
  "citadel-governance"
  "citadel-arbiter"
  "citadel-telemetry"
  "citadel-frontend"
)

# --- Colors ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# --- Logging ---
log()     { echo -e "${BLUE}⚡${NC} $1" | tee -a "$DEPLOY_LOG"; }
ok()      { echo -e "${GREEN}✓${NC} $1"  | tee -a "$DEPLOY_LOG"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1" | tee -a "$DEPLOY_LOG"; }
err()     { echo -e "${RED}✗${NC} $1"    | tee -a "$DEPLOY_LOG"; }
header()  { echo -e "\n==========================================" | tee -a "$DEPLOY_LOG"
            echo -e "$1" | tee -a "$DEPLOY_LOG"
            echo -e "==========================================\n" | tee -a "$DEPLOY_LOG"; }

# --- Cleanup trap ---
cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    err "Deployment failed (exit code: $exit_code). Log: $DEPLOY_LOG"
  fi
}
trap cleanup EXIT

# --- Parse .env safely ---
load_env() {
  local env_file="$1"
  if [ ! -f "$env_file" ]; then
    warn "$env_file not found — using shell environment"
    return
  fi
  log "Loading environment from $env_file..."
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip inline comments
    line="${line%%#*}"
    # Trim whitespace
    line="$(echo "$line" | xargs)"
    # Export if it looks like KEY=VALUE
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      # Honor caller's environment: only set vars that aren't already set.
      # This matches standard dotenv semantics (docker-compose, Next.js, etc.)
      # and lets `CDK_DOCKER=docker ./deploy.sh` override the .env default.
      if [ -z "${!key:-}" ]; then
        export "$key=$val"
      fi
    fi
  done < "$env_file"
}

# --- Validate required vars ---
validate_env() {
  local missing=()
  for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var:-}" ]; then
      missing+=("$var")
    fi
  done
  if [ ${#missing[@]} -ne 0 ]; then
    err "Missing required environment variables:"
    printf '   - %s\n' "${missing[@]}"
    exit 1
  fi
  # Ensure AWS SDK region vars match CDK_DEFAULT_REGION so the CLI config
  # file cannot silently override the target region.
  export AWS_DEFAULT_REGION="$CDK_DEFAULT_REGION"
  export AWS_REGION="$CDK_DEFAULT_REGION"

  ok "Environment: $ENVIRONMENT"
  ok "Account:     $CDK_DEFAULT_ACCOUNT"
  ok "Region:      $CDK_DEFAULT_REGION"
}

# --- Resolve FRONTEND_ORIGIN if unset (auto-discovery from frontend stack) ---
# TelemetryStack's cost API CORS policy needs the real frontend origin.
# On a fresh account, telemetry deploys BEFORE frontend (see deploy_all_stacks
# dependency comment below), so there may be no stack yet — that's expected,
# not an error. We proceed with a loud warning rather than failing, since
# bin/app.ts already has a non-throwing placeholder fallback for this exact
# case (finding d7d3dd61).
resolve_frontend_origin() {
  if [ -n "${FRONTEND_ORIGIN:-}" ]; then
    # Strip any trailing slash even when explicitly set, for consistency.
    FRONTEND_ORIGIN="${FRONTEND_ORIGIN%/}"
    export FRONTEND_ORIGIN
    ok "FRONTEND_ORIGIN: $FRONTEND_ORIGIN (from environment)"
    return 0
  fi

  local stack_name="citadel-frontend-${ENVIRONMENT}"
  local profile_flag=""
  [ -n "${AWS_PROFILE:-}" ] && profile_flag="--profile $AWS_PROFILE"

  log "FRONTEND_ORIGIN not set — resolving from $stack_name stack output..."
  local resolved
  resolved=$(aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$CDK_DEFAULT_REGION" \
    $profile_flag \
    --query 'Stacks[0].Outputs[?OutputKey==`FrontendUrl`].OutputValue' \
    --output text 2>/dev/null || echo "")

  if [ -z "$resolved" ] || [ "$resolved" = "None" ]; then
    warn "Could not resolve FRONTEND_ORIGIN from $stack_name (stack not deployed yet? fresh-account bootstrap: frontend deploys AFTER telemetry)."
    warn "Proceeding WITHOUT a real frontend origin — browser CORS on the cost API will stay BLOCKED until telemetry is redeployed with FRONTEND_ORIGIN set."
    warn "Once the frontend stack exists, redeploy telemetry with, e.g.:"
    warn "  FRONTEND_ORIGIN=\$(aws cloudformation describe-stacks --stack-name $stack_name --region $CDK_DEFAULT_REGION $profile_flag --query 'Stacks[0].Outputs[?OutputKey==\`FrontendUrl\`].OutputValue' --output text) ./deploy.sh citadel-telemetry-${ENVIRONMENT}"
    return 0
  fi

  resolved="${resolved%/}"
  export FRONTEND_ORIGIN="$resolved"
  ok "FRONTEND_ORIGIN resolved from $stack_name: $FRONTEND_ORIGIN"
}


capture_git_info() {
  GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  GIT_DIRTY=$(git diff --quiet 2>/dev/null && echo "clean" || echo "dirty")
  export GIT_SHA GIT_BRANCH GIT_DIRTY
  ok "Git: $GIT_BRANCH@$GIT_SHA ($GIT_DIRTY)"
}

# --- Build frontend ---
build_frontend() {
  log "Building frontend..."
  pushd frontend > /dev/null
  npm ci --prefer-offline 2>&1 | tail -1
  npm run build 2>&1 | tee -a "$DEPLOY_LOG"
  # Record build manifest (file listing with hashes)
  find build -type f -exec md5sum {} \; | sort > build/.manifest
  local file_count
  file_count=$(wc -l < build/.manifest | tr -d ' ')
  ok "Frontend build complete ($file_count files)"
  popd > /dev/null
}

# --- Build backend ---
build_backend() {
  log "Building backend TypeScript..."
  pushd backend > /dev/null
  npm ci --prefer-offline 2>&1 | tail -1
  npm run build 2>&1 | tee -a "$DEPLOY_LOG"
  ok "Backend TypeScript build complete"

  log "Building Lambda bundles..."
  npm run build:lambda 2>&1 | tee -a "$DEPLOY_LOG"
  ok "Lambda bundles complete"
  popd > /dev/null
}

# --- CDK diff (preview) ---
cdk_diff() {
  log "Running cdk diff..."
  pushd backend > /dev/null
  local diff_cmd="npx cdk diff"
  [ -n "${AWS_PROFILE:-}" ] && diff_cmd="$diff_cmd --profile $AWS_PROFILE"
  local admin_email="${ADMIN_EMAIL_ARG:-${ADMIN_EMAIL:-}}"
  [ -n "$admin_email" ] && diff_cmd="$diff_cmd -c adminEmail=$admin_email"
  # cdk diff stays non-blocking by design (it's a preview, not a gate) —
  # but a failure is now named instead of silently swallowed by `|| true`.
  # Note: --all is intentionally NOT passed; it is not a supported cdk diff
  # flag (cdk diff diffs all stacks in the app by default with no args).
  local diff_output
  local diff_rc=0
  diff_output=$($diff_cmd 2>&1) || diff_rc=$?
  echo "$diff_output" | tee -a "$DEPLOY_LOG"
  if [ $diff_rc -ne 0 ]; then
    local last_error
    last_error=$(echo "$diff_output" | grep -v '^[[:space:]]*$' | tail -1)
    warn "cdk diff unavailable: $last_error"
  fi
  # Expose the captured diff to the deletion gate (finding 9c92a738). These
  # globals let the main flow parse the SAME diff text for resource deletions
  # without re-invoking cdk. CDK_DIFF_RC=0 means the diff succeeded and its
  # output can be trusted; non-zero means the gate must fail closed.
  CDK_DIFF_OUTPUT="$diff_output"
  CDK_DIFF_RC="$diff_rc"
  export CDK_DIFF_OUTPUT CDK_DIFF_RC
  popd > /dev/null
}

# --- Recurrence guard: script stack list vs `cdk list` ---
# Compares KNOWN_STACKS (suffixed with -$ENVIRONMENT) against the stacks CDK
# actually synthesizes from backend/bin/app.ts. Fails LOUDLY on any mismatch
# in either direction, so a 10th stack added to bin/app.ts (or one removed)
# cannot be silently skipped by this script's hardcoded deploy order.
verify_stack_coverage() {
  log "Verifying deploy.sh stack coverage against 'cdk list'..."
  pushd backend > /dev/null
  local list_cmd="npx cdk list"
  [ -n "${AWS_PROFILE:-}" ] && list_cmd="$list_cmd --profile $AWS_PROFILE"
  local admin_email="${ADMIN_EMAIL_ARG:-${ADMIN_EMAIL:-}}"
  [ -n "$admin_email" ] && list_cmd="$list_cmd -c adminEmail=$admin_email"

  local cdk_stacks
  if ! cdk_stacks=$($list_cmd 2>>"$DEPLOY_LOG"); then
    popd > /dev/null
    err "'npx cdk list' failed — cannot verify stack coverage. See $DEPLOY_LOG"
    exit 1
  fi
  popd > /dev/null

  local expected=()
  local stack
  for stack in "${KNOWN_STACKS[@]}"; do
    expected+=("${stack}-${ENVIRONMENT}")
  done

  local mismatches=()
  # Direction 1: stack in cdk app but not in this script → would be skipped
  while IFS= read -r stack; do
    [ -z "$stack" ] && continue
    if [[ ! " ${expected[*]} " =~ " ${stack} " ]]; then
      mismatches+=("'$stack' is defined in backend/bin/app.ts but MISSING from deploy.sh KNOWN_STACKS — it would be silently skipped")
    fi
  done <<< "$cdk_stacks"
  # Direction 2: stack in this script but not in cdk app → stale entry
  for stack in "${expected[@]}"; do
    if ! grep -Fxq "$stack" <<< "$cdk_stacks"; then
      mismatches+=("'$stack' is listed in deploy.sh KNOWN_STACKS but NOT defined in backend/bin/app.ts — stale entry")
    fi
  done

  if [ ${#mismatches[@]} -ne 0 ]; then
    err "Stack coverage mismatch between deploy.sh and 'cdk list':"
    printf '   - %s\n' "${mismatches[@]}" | tee -a "$DEPLOY_LOG"
    err "Update KNOWN_STACKS and deploy_all_stacks/--backend-only in deploy.sh to match backend/bin/app.ts"
    exit 1
  fi
  ok "Stack coverage verified (${#expected[@]} stacks match 'cdk list')"
}

# --- Check whether the API-key HMAC pepper SSM parameter exists ---
# Returns 0 if the parameter exists, 1 if it does NOT exist (ParameterNotFound
# specifically), and aborts the whole deploy for any other failure (expired
# credentials, AccessDenied, wrong region, throttling, etc.) since those are
# NOT evidence of absence and must never be treated as "go ahead and create
# a new pepper". Sets PEPPER_CHECK_STDERR as a side channel for the caller.
check_api_key_pepper_exists() {
  local param_name="$1"
  local profile_flag="$2"
  local stderr_output
  local rc=0

  stderr_output=$(aws ssm get-parameter \
    --name "$param_name" \
    --region "$CDK_DEFAULT_REGION" \
    $profile_flag \
    2>&1 >/dev/null) || rc=$?

  PEPPER_CHECK_STDERR="$stderr_output"
  return $rc
}

# --- Ensure the API-key HMAC pepper SSM parameter exists (idempotent) ---
# Never overwrites an existing parameter and never echoes the value.
ensure_api_key_pepper() {
  local param_name="/citadel/${ENVIRONMENT}/app-api-key-pepper"
  local profile_flag=""
  [ -n "${AWS_PROFILE:-}" ] && profile_flag="--profile $AWS_PROFILE"

  log "Checking API-key HMAC pepper SSM parameter..."

  local PEPPER_CHECK_STDERR=""
  if check_api_key_pepper_exists "$param_name" "$profile_flag"; then
    ok "API-key HMAC pepper already exists at $param_name"
    return 0
  fi

  # The get-parameter call failed. Only a ParameterNotFound error means the
  # pepper genuinely does not exist yet — every other failure (expired/invalid
  # credentials, AccessDenied, unauthorized, wrong region, throttling, etc.)
  # must abort the deploy rather than being treated as "not found", since
  # silently falling through to generate-and-store on those errors would let
  # a credentials/permission/region problem masquerade as a first-run bootstrap.
  if ! echo "$PEPPER_CHECK_STDERR" | grep -q "ParameterNotFound"; then
    err "Could not verify API-key HMAC pepper at $param_name — aborting deploy."
    if echo "$PEPPER_CHECK_STDERR" | grep -qiE "ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|could not be found|Unable to locate credentials|You need to authenticate|Midway"; then
      err "Cause: AWS credentials appear to be missing or expired. Re-authenticate and retry."
    elif echo "$PEPPER_CHECK_STDERR" | grep -qiE "AccessDenied|not authorized|UnauthorizedOperation"; then
      err "Cause: AccessDenied — the current identity lacks ssm:GetParameter on $param_name."
    elif echo "$PEPPER_CHECK_STDERR" | grep -qiE "could not connect to the endpoint|InvalidRegion|is not a valid region"; then
      err "Cause: region error — check CDK_DEFAULT_REGION/AWS_DEFAULT_REGION ($CDK_DEFAULT_REGION)."
    else
      err "Cause: unrecognized error from aws ssm get-parameter (see below)."
    fi
    err "aws ssm get-parameter said: $PEPPER_CHECK_STDERR"
    exit 1
  fi

  log "API-key HMAC pepper not found — generating and storing a new SecureString..."
  local pepper_value
  pepper_value=$(openssl rand -base64 32)
  # NOTE: --overwrite is deliberately ABSENT here. This is a safety property,
  # not an oversight: overwriting the pepper would invalidate every existing
  # API-key HMAC hash (see backend api-key-hash.ts consumers), silently
  # locking out every issued API key. Never add --overwrite to this call
  # outside of an explicit, confirmed key-rotation procedure.
  aws ssm put-parameter \
    --name "$param_name" \
    --type SecureString \
    --value "$pepper_value" \
    --description "HMAC pepper for Agent App API key hashing (${ENVIRONMENT})" \
    --region "$CDK_DEFAULT_REGION" \
    $profile_flag \
    >/dev/null
  unset pepper_value
  ok "API-key HMAC pepper created at $param_name"
}

# --- Classify a failed deploy attempt's captured output ---
# Echoes "retry" if the failure looks like a CloudFormation-side transient
# (worth a retry), or "fail-fast:<root-cause-line>" if the failure is a
# deterministic client-side problem (missing binary, subprocess crash, CDK
# synth/type error) that a bare retry cannot fix — retrying just wastes
# 10s+ and reproduces the identical error.
classify_deploy_failure() {
  local output="$1"

  # Deterministic client-side signatures: retrying will reproduce them exactly.
  local root_cause
  root_cause=$(echo "$output" | grep -E "spawnSync .* ENOENT|Subprocess exited with error|error TS[0-9]+:|SyntaxError:|Cannot find module|is not a function|Error: Cannot find" | tail -1)
  if [ -n "$root_cause" ]; then
    echo "fail-fast:$root_cause"
    return 0
  fi

  echo "retry"
}

# --- Deploy a single stack with retry ---
deploy_stack() {
  local stack_name="$1"
  local attempt=1
  local max_attempts=2
  local profile_flag=""
  [ -n "${AWS_PROFILE:-}" ] && profile_flag="--profile $AWS_PROFILE"

  # Pre-check: if stack is in ROLLBACK_COMPLETE, delete it first
  local stack_status
  stack_status=$(aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$CDK_DEFAULT_REGION" \
    $profile_flag \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$stack_status" = "ROLLBACK_COMPLETE" ] || [ "$stack_status" = "DELETE_FAILED" ]; then
      warn "$stack_name is in $stack_status — deleting before redeploy..."
      aws cloudformation delete-stack \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag
      aws cloudformation wait stack-delete-complete \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag 2>/dev/null || true
      ok "$stack_name deleted, proceeding with fresh deploy"
    elif [ "$stack_status" = "REVIEW_IN_PROGRESS" ]; then
      # REVIEW_IN_PROGRESS means a first change set was created but never
      # executed — typically a side-effect of a prior `cdk diff` or a
      # changeset preview that was never applied. CloudFormation will NOT
      # let us create a new changeset here until the orphaned one is
      # deleted. Drop the changeset(s), then delete the empty stack object
      # so the next deploy is a clean greenfield create.
      warn "$stack_name is in REVIEW_IN_PROGRESS — clearing orphaned change sets..."
      local cs_names
      cs_names=$(aws cloudformation list-change-sets \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag \
        --query 'Summaries[].ChangeSetName' \
        --output text 2>/dev/null || echo "")
      for cs in $cs_names; do
        aws cloudformation delete-change-set \
          --stack-name "$stack_name" \
          --change-set-name "$cs" \
          --region "$CDK_DEFAULT_REGION" \
          $profile_flag 2>/dev/null || true
      done
      aws cloudformation delete-stack \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag 2>/dev/null || true
      aws cloudformation wait stack-delete-complete \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag 2>/dev/null || true
      ok "$stack_name reset, proceeding with fresh deploy"
    fi

  while [ $attempt -le $max_attempts ]; do
    # Re-check the container runtime immediately before EACH attempt — it
    # can disappear mid-run (e.g. Docker Desktop auto-updating), and a stale
    # "it was there at script start" assumption would otherwise burn a full
    # retry cycle on a doomed attempt before failing.
    local docker_cmd="${CDK_DOCKER:-docker}"
    if ! command -v "$docker_cmd" &>/dev/null; then
      popd > /dev/null 2>&1 || true
      err "Container runtime '$docker_cmd' is no longer available (attempt $attempt/$max_attempts) — aborting $stack_name deploy."
      return 1
    fi

    log "Deploying $stack_name (attempt $attempt/$max_attempts)..."
    pushd backend > /dev/null
    local cmd="npx cdk deploy $stack_name --require-approval never --outputs-file ../cdk-outputs.json"
    [ -n "${AWS_PROFILE:-}" ] && cmd="$cmd --profile $AWS_PROFILE"

    # Pass admin email as CDK context if provided via --admin-email or ADMIN_EMAIL env var
    local admin_email="${ADMIN_EMAIL_ARG:-${ADMIN_EMAIL:-}}"
    [ -n "$admin_email" ] && cmd="$cmd -c adminEmail=$admin_email"

    local attempt_output
    local attempt_rc=0
    attempt_output=$($cmd 2>&1) || attempt_rc=$?
    echo "$attempt_output" | tee -a "$DEPLOY_LOG"
    popd > /dev/null

    if [ $attempt_rc -eq 0 ]; then
      ok "$stack_name deployed successfully"
      return 0
    fi

    # Classify before deciding whether a retry is worthwhile. Deterministic
    # client-side failures (missing binary, crashed subprocess, synth/type
    # errors) will fail identically on a second attempt — fail fast instead.
    local classification
    classification=$(classify_deploy_failure "$attempt_output")
    if [[ "$classification" == fail-fast:* ]]; then
      err "$stack_name failed with a deterministic error — not retrying."
      err "Root cause: ${classification#fail-fast:}"
      return 1
    fi

    # Check if stack ended up in ROLLBACK_COMPLETE — delete before retry
    stack_status=$(aws cloudformation describe-stacks \
      --stack-name "$stack_name" \
      --region "$CDK_DEFAULT_REGION" \
      $profile_flag \
      --query 'Stacks[0].StackStatus' \
      --output text 2>/dev/null || echo "NOT_FOUND")

    if [ "$stack_status" = "ROLLBACK_COMPLETE" ]; then
      warn "$stack_name rolled back to ROLLBACK_COMPLETE — cleaning up..."
      aws cloudformation delete-stack \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag
      aws cloudformation wait stack-delete-complete \
        --stack-name "$stack_name" \
        --region "$CDK_DEFAULT_REGION" \
        $profile_flag 2>/dev/null || true
    fi

    if [ $attempt -lt $max_attempts ]; then
      warn "$stack_name failed, retrying in ${CDK_DEPLOY_RETRY_SLEEP:-10}s..."
      sleep "${CDK_DEPLOY_RETRY_SLEEP:-10}"
    fi
    attempt=$((attempt + 1))
  done

  err "$stack_name failed after $max_attempts attempts"
  return 1
}

# --- Deploy all stacks in dependency order ---
deploy_all_stacks() {
  local env="$ENVIRONMENT"
  local failed=()

  # Dependency graph (from backend/bin/app.ts):
  #   backend       ← root
  #   projects      ← backend      (projects/conversations domain split from backend)
  #   registry      ← backend      (registry/agent-import domain split from backend)
  #   services      ← backend
  #   gateway       ← backend
  #   governance    ← backend      (governance tables + resolvers split from backend)
  #   arbiter       ← services
  #   telemetry     ← backend, arbiter
  #   frontend      ← arbiter, telemetry
  #
  # Stacks sharing a parent deploy sequentially here (rather than in parallel)
  # so a rollback in one doesn't disturb a sibling mid-deploy. The CDK tooling
  # handles the topological ordering internally; this list only enforces
  # which stacks deploy.sh attempts and in what order.
  deploy_stack "citadel-backend-$env" || failed+=("backend")

  if [ ${#failed[@]} -eq 0 ]; then
    # ProjectsStack, RegistryStack, ServicesStack, GatewayStack, and
    # GovernanceStack all depend on BackendStack only (no interdependency
    # among the five). Projects/registry are LEAF stacks — nothing else
    # depends on them, so no other named deploy pulls them in transitively;
    # they MUST be deployed explicitly here.
    deploy_stack "citadel-projects-$env"   || failed+=("projects")
    deploy_stack "citadel-registry-$env"   || failed+=("registry")
    deploy_stack "citadel-services-$env"   || failed+=("services")
    deploy_stack "citadel-gateway-$env"    || failed+=("gateway")
    deploy_stack "citadel-governance-$env" || failed+=("governance")
  else
    warn "Skipping projects/registry/services/gateway/governance — backend failed"
  fi

  if [ ${#failed[@]} -eq 0 ] || [[ ! " ${failed[*]} " =~ " backend " && ! " ${failed[*]} " =~ " services " ]]; then
    deploy_stack "citadel-arbiter-$env" || failed+=("arbiter")
  else
    warn "Skipping arbiter — dependency failed (${failed[*]})"
  fi

  if [ ${#failed[@]} -eq 0 ] || [[ ! " ${failed[*]} " =~ " backend " && ! " ${failed[*]} " =~ " arbiter " ]]; then
    deploy_stack "citadel-telemetry-$env" || failed+=("telemetry")
  else
    warn "Skipping telemetry — dependency failed (${failed[*]})"
  fi

  if [ ${#failed[@]} -eq 0 ] || [[ ! " ${failed[*]} " =~ " backend " && ! " ${failed[*]} " =~ " arbiter " && ! " ${failed[*]} " =~ " telemetry " ]]; then
    deploy_stack "citadel-frontend-$env" || failed+=("frontend")
  else
    warn "Skipping frontend — dependency failed (${failed[*]})"
  fi

  if [ ${#failed[@]} -ne 0 ]; then
    err "Failed stacks: ${failed[*]}"
    return 1
  fi
  ok "All stacks deployed"
}

# --- CloudFront invalidation with polling ---
invalidate_cloudfront() {
  local dist_id="$1"

  log "Creating CloudFront invalidation for $dist_id..."
  local inv_id
  # CloudFront API lives in us-east-1 — override AWS_DEFAULT_REGION for these calls
  inv_id=$(AWS_DEFAULT_REGION=us-east-1 aws cloudfront create-invalidation \
    --distribution-id "$dist_id" \
    --paths "/*" \
    --query 'Invalidation.Id' --output text)

  log "Invalidation $inv_id created, waiting for completion..."
  local status="InProgress"
  local wait_count=0
  while [ "$status" = "InProgress" ] && [ $wait_count -lt 60 ]; do
    sleep 5
    status=$(AWS_DEFAULT_REGION=us-east-1 aws cloudfront get-invalidation \
      --distribution-id "$dist_id" \
      --id "$inv_id" \
      --query 'Invalidation.Status' --output text)
    wait_count=$((wait_count + 1))
  done

  if [ "$status" = "Completed" ]; then
    ok "CloudFront invalidation completed"
  else
    warn "CloudFront invalidation status: $status (may still be in progress)"
  fi
}

# --- Verify frontend bundle in S3 ---
verify_frontend_bundle() {
  local bucket="citadel-frontend-${ENVIRONMENT}-${CDK_DEFAULT_ACCOUNT}-${CDK_DEFAULT_REGION}"
  local profile_flag=""
  [ -n "${AWS_PROFILE:-}" ] && profile_flag="--profile $AWS_PROFILE"

  log "Verifying frontend bundle in s3://$bucket..."

  # Check that index.html exists and is recent
  local last_modified
  last_modified=$(aws s3api head-object \
    --bucket "$bucket" \
    --key "index.html" \
    --region "$CDK_DEFAULT_REGION" \
    $profile_flag \
    --query 'LastModified' --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$last_modified" = "NOT_FOUND" ]; then
    err "index.html not found in S3 bucket"
    return 1
  fi

  # Count JS/CSS assets in S3
  local s3_asset_count
  s3_asset_count=$(aws s3 ls "s3://$bucket/assets/" \
    --region "$CDK_DEFAULT_REGION" \
    $profile_flag \
    --recursive 2>/dev/null | wc -l | tr -d ' ')

  # Count local assets
  local local_asset_count=0
  if [ -d "frontend/build/assets" ]; then
    local_asset_count=$(find frontend/build/assets -type f | wc -l | tr -d ' ')
  fi

  if [ "$s3_asset_count" -ge "$local_asset_count" ] && [ "$local_asset_count" -gt 0 ]; then
    ok "S3 bundle verified ($s3_asset_count assets, index.html updated: $last_modified)"
  else
    warn "Asset count mismatch — S3: $s3_asset_count, local: $local_asset_count"
  fi
}

# --- Post-deploy health check ---
health_check() {
  local frontend_url="$1"
  log "Running health check on $frontend_url..."

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$frontend_url" 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ]; then
    ok "Health check passed (HTTP $http_code)"
  else
    warn "Health check returned HTTP $http_code (CloudFront may still be propagating)"
  fi
}

# --- Write deployment manifest ---
# Provenance record (finding 7f42ae86): after a successful run, capture what
# is actually running so it can be READ rather than recalled from scrollback.
# Written to deployment-manifest.json at the repo root; that path is gitignored
# via the `deployment-*.json` rule in .gitignore, so it never gets committed.
write_manifest() {
  local manifest_file="deployment-manifest.json"
  local deployer
  deployer=$(aws sts get-caller-identity --query 'Arn' --output text ${AWS_PROFILE:+--profile $AWS_PROFILE} 2>/dev/null || echo "unknown")

  # Build a JSON array of the concrete stack names this run targeted.
  local stacks_json="[]"
  local names
  names=$(resolve_deployed_stack_names)
  if [ -n "$names" ]; then
    stacks_json=$(printf '%s\n' "$names" | awk 'NF{printf "%s\"%s\"", (c++?",":""), $0} END{print ""}')
    stacks_json="[${stacks_json}]"
  fi

  local expected_ref_json="null"
  [ -n "${EXPECT_REF:-}" ] && expected_ref_json="\"${EXPECT_REF}\""

  cat > "$manifest_file" <<EOF
{
  "started_at": "${DEPLOY_STARTED_AT:-unknown}",
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "environment": "$ENVIRONMENT",
  "region": "$CDK_DEFAULT_REGION",
  "account": "$CDK_DEFAULT_ACCOUNT",
  "git_sha": "$GIT_SHA",
  "git_branch": "$GIT_BRANCH",
  "git_dirty": "$GIT_DIRTY",
  "expected_ref": ${expected_ref_json},
  "deployer": "$deployer",
  "deploy_mode": "$DEPLOY_MODE",
  "stacks": ${stacks_json}
}
EOF
  ok "Deployment manifest written to $manifest_file (gitignored)"
}

# --- Expected-ref gate (finding 7f42ae86 — provenance) ---
# Cross-checks the ref the operator INTENDED against the ref actually resolved
# from HEAD, so a deploy from the wrong clone/branch cannot proceed silently.
#   - EXPECT_REF set: accept a branch name, a full sha, or a short/prefix sha;
#     normalise, compare, and ABORT (naming both) on mismatch.
#   - EXPECT_REF empty: print the resolved branch+short sha BEFORE any CDK work
#     and require an interactive y/N confirmation. If stdin is NOT a TTY (an
#     unattended run), REFUSE rather than hang — an unattended deploy must never
#     silently proceed without the operator having named the intended ref.
verify_expected_ref() {
  local expected="${1:-}"
  local branch full_sha short_sha
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  full_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  short_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

  if [ -n "$expected" ]; then
    # Normalise a fully-qualified ref down to its short name for comparison.
    local norm="${expected#refs/heads/}"
    norm="${norm#refs/tags/}"
    if [ "$norm" = "$branch" ] || [ "$norm" = "$full_sha" ] || [ "$norm" = "$short_sha" ]; then
      ok "Expected-ref check passed: HEAD is ${branch}@${short_sha} (matches --expect-ref '${expected}')"
      return 0
    fi
    # Allow an abbreviated/extended sha: expected is a case-insensitive prefix
    # of the full sha (and looks like a hex sha of at least 4 chars).
    if [[ "$norm" =~ ^[0-9a-fA-F]{4,40}$ ]]; then
      local norm_lc full_lc
      norm_lc=$(printf '%s' "$norm" | tr 'A-F' 'a-f')
      full_lc=$(printf '%s' "$full_sha" | tr 'A-F' 'a-f')
      if [ "${full_lc#"$norm_lc"}" != "$full_lc" ]; then
        ok "Expected-ref check passed (sha prefix): HEAD ${short_sha} matches --expect-ref '${expected}'"
        return 0
      fi
    fi
    err "Expected-ref MISMATCH — refusing to deploy."
    err "  --expect-ref requested: ${expected}"
    err "  resolved HEAD:          ${branch}@${short_sha} (${full_sha})"
    err "This clone's HEAD is not the ref you intended to deploy (finding 7f42ae86). Check out the intended ref, or correct --expect-ref."
    return 1
  fi

  # No --expect-ref supplied.
  warn "No --expect-ref supplied. Resolved deploy target: ${branch}@${short_sha}"
  if [ -t 0 ]; then
    printf 'Proceed deploying %s@%s to environment "%s"? [y/N] ' "$branch" "$short_sha" "${ENVIRONMENT:-?}"
    local reply=""
    read -r reply || true
    case "$reply" in
      y|Y|yes|YES|Yes)
        ok "Operator confirmed deploy of ${branch}@${short_sha}"
        return 0
        ;;
      *)
        err "Operator declined confirmation — aborting."
        return 1
        ;;
    esac
  fi
  err "No --expect-ref and stdin is not a TTY — refusing to deploy unattended (finding 7f42ae86)."
  err "Re-run with --expect-ref ${branch} (or --expect-ref ${short_sha}) to name the intended ref explicitly."
  return 1
}

# --- Tree-state gate (dirty / divergence) ---
# Two distinct checks, each with an explicit refuse-vs-warn rationale:
#   1. DIRTY working tree -> REFUSE (override: --allow-dirty -> loud WARN).
#      Why refuse: a dirty tree corresponds to NO commit, so the git_sha the
#      success banner and provenance manifest record would misrepresent what is
#      actually running (finding 7f42ae86). --allow-dirty proceeds but the
#      manifest records git_dirty=dirty so the lie is at least on the record.
#   2. HEAD is NOT an ancestor of origin/main AND no --expect-ref -> REFUSE.
#      Why refuse: this is the exact finding-9c92a738 shape — deploying a
#      divergent branch can silently reconcile away stateful resources added on
#      OTHER unmerged branches. Supplying --expect-ref is the operator
#      explicitly asserting "yes, deploy this divergent ref on purpose", which
#      downgrades it to a loud WARN (the deletion gate remains the backstop).
check_tree_state() {
  local expected="${1:-}"
  local allow_dirty="${2:-false}"

  local dirty="clean"
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    dirty="dirty"
  fi

  if [ "$dirty" = "dirty" ]; then
    if [ "$allow_dirty" = "true" ]; then
      warn "Working tree is DIRTY and --allow-dirty was supplied — proceeding; provenance manifest will record git_dirty=dirty."
    else
      err "Working tree is DIRTY — refusing to deploy."
      err "A dirty tree corresponds to no commit, so the recorded provenance sha would misrepresent what is running (finding 7f42ae86)."
      err "Commit or stash your changes, or pass --allow-dirty to deploy anyway (recorded as dirty)."
      return 1
    fi
  fi

  # Divergence check: only meaningful if origin/main is resolvable.
  local divergent="false"
  if git rev-parse --verify -q origin/main >/dev/null 2>&1; then
    if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
      divergent="true"
    fi
  else
    warn "origin/main not resolvable — skipping divergence (ancestry) check."
  fi

  if [ "$divergent" = "true" ]; then
    if [ -n "$expected" ]; then
      warn "HEAD is NOT an ancestor of origin/main (divergent branch), but --expect-ref '${expected}' was supplied — proceeding on an explicit ref."
      warn "Divergent-branch deploys can reconcile away stateful resources added on OTHER unmerged branches (finding 9c92a738); the deletion gate is your backstop."
    else
      err "HEAD is NOT an ancestor of origin/main (divergent branch) and no --expect-ref was supplied — refusing."
      err "This is the finding-9c92a738 shape: deploying a divergent branch can silently DELETE stateful resources added on other unmerged branches."
      err "If this divergent deploy is intentional, re-run with --expect-ref <branch|sha> to assert it explicitly."
      return 1
    fi
  fi
  return 0
}

# --- Parse cdk diff output for resource DELETIONS ---
# CDK renders a removed resource as a line whose first non-whitespace token is
# the removal marker "[-]", e.g.:
#   [-] AWS::DynamoDB::Table SmokeTable citadelsmoke0AB12CD3 destroy
# Echoes one "<Type> <Name...>" per deleted resource (marker stripped). Emits
# nothing when there are no deletions.
extract_cdk_deletions() {
  local diff_text="$1"
  # Strip ANSI colour escapes first (cdk diff colourizes the [-] marker red),
  # then match lines whose first non-whitespace token is the removal marker.
  printf '%s\n' "$diff_text" \
    | sed -E 's/\x1b\[[0-9;]*[mK]//g' \
    | grep -E '^[[:space:]]*\[-\][[:space:]]' \
    | sed -E 's/^[[:space:]]*\[-\][[:space:]]+//'
}

# --- Deletion gate (finding 9c92a738) — FAIL CLOSED ---
# Args: <diff_text> <allow_deletions:true|false> <diff_ok:true|false>
# REFUSES (return 1) when the diff shows resource deletions and --allow-deletions
# was not passed. If the diff is empty or cdk diff failed (diff_ok!=true), also
# REFUSES: we cannot PROVE the deploy performs no deletions, so we fail closed
# rather than assume none.
deletion_gate() {
  local diff_text="$1"
  local allow_deletions="${2:-false}"
  local diff_ok="${3:-true}"

  local stripped="${diff_text//[[:space:]]/}"
  if [ "$diff_ok" != "true" ] || [ -z "$stripped" ]; then
    err "Deletion gate: cdk diff output is empty or could not be parsed — refusing (fail-closed)."
    err "Cannot prove this deploy performs no resource deletions; re-run once 'cdk diff' succeeds with parseable output."
    return 1
  fi

  local deletions
  deletions=$(extract_cdk_deletions "$diff_text")
  if [ -z "$deletions" ]; then
    ok "Deletion gate: cdk diff shows no resource deletions."
    return 0
  fi

  err "Deletion gate: this deploy will DELETE the following resource(s):"
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && err "  DELETE → ${line}"
  done <<< "$deletions"

  if [ "$allow_deletions" = "true" ]; then
    warn "--allow-deletions supplied — proceeding despite the deletions listed above."
    return 0
  fi
  err "Refusing. If these deletions are intended, re-run with --allow-deletions."
  err "Finding 9c92a738: a divergent-branch deploy can silently reconcile away stateful resources — confirm every name above is truly disposable first."
  return 1
}

# --- Resolve the concrete stack names this run will deploy ---
# Mirrors the DEPLOY_MODE switch in main so the provenance manifest records
# WHICH stacks were targeted, not just the mode string.
resolve_deployed_stack_names() {
  local env="$ENVIRONMENT"
  case "$DEPLOY_MODE" in
    all)
      printf '%s\n' "${KNOWN_STACKS[@]/%/-$env}"
      ;;
    backend)
      local s
      for s in "${KNOWN_STACKS[@]}"; do
        [ "$s" = "citadel-frontend" ] && continue
        printf '%s\n' "${s}-${env}"
      done
      ;;
    frontend)
      printf '%s\n' "citadel-frontend-${env}"
      ;;
    single)
      printf '%s\n' "$STACK_NAME"
      ;;
  esac
}

# --- Help ---
show_help() {
  echo "Citadel Deployment Script"
  echo ""
  echo "Usage: ./deploy.sh [options] [stack-name]"
  echo ""
  echo "Options:"
  echo "  --all                Deploy all stacks (default)"
  echo "  --backend-only       Deploy all non-frontend stacks (backend + projects + registry + services + gateway + governance + arbiter + telemetry)"
  echo "  --frontend-only      Deploy only frontend stack"
  echo "  --skip-frontend      Skip frontend build"
  echo "  --skip-backend       Skip backend build"
  echo "  --profile <name>     Use specific AWS profile"
  echo "  --dry-run            Preview changes only (cdk diff)"
  echo "  --no-verify          Skip post-deploy health checks"
  echo "  --expect-ref <ref>   Abort unless HEAD resolves to <ref> (branch name, full or short sha)"
  echo "  --allow-deletions    Proceed even if cdk diff shows resource DELETIONS (default: refuse)"
  echo "  --allow-dirty        Proceed even if the working tree is dirty (default: refuse)"
  echo "  --admin-email <addr> Admin email for initial user (overrides ADMIN_EMAIL env var)"
  echo "  --help               Show this help message"
  exit 0
}

# --- Testability seam ---
# `DEPLOY_SH_SOURCE_ONLY=1 source deploy.sh` defines every function above
# and then returns here without running the main flow below, so a test
# harness can source this file and call functions (ensure_api_key_pepper,
# deploy_stack, classify_deploy_failure, cdk_diff, ...) directly with faked
# PATH binaries. Default (unset/non-"1") behaviour is byte-for-byte
# unchanged — this guard is a pure no-op unless the env var is explicitly set.
if [ "${DEPLOY_SH_SOURCE_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# --- Main ---
STACK_NAME=""
AWS_PROFILE=""
DEPLOY_MODE="all"
SKIP_FRONTEND_BUILD=false
SKIP_BACKEND_BUILD=false
DRY_RUN=false
NO_VERIFY=false
ADMIN_EMAIL_ARG=""
EXPECT_REF=""
ALLOW_DELETIONS=false
ALLOW_DIRTY=false
DEPLOY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

while [[ $# -gt 0 ]]; do
  case $1 in
    --help|-h)        show_help ;;
    --all)            DEPLOY_MODE="all"; shift ;;
    --backend-only)   DEPLOY_MODE="backend"; SKIP_FRONTEND_BUILD=true; shift ;;
    --frontend-only)  DEPLOY_MODE="frontend"; SKIP_BACKEND_BUILD=true; shift ;;
    --skip-frontend)  SKIP_FRONTEND_BUILD=true; shift ;;
    --skip-backend)   SKIP_BACKEND_BUILD=true; shift ;;
    --profile)        AWS_PROFILE="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=true; shift ;;
    --no-verify)      NO_VERIFY=true; shift ;;
    --expect-ref)     EXPECT_REF="$2"; shift 2 ;;
    --allow-deletions) ALLOW_DELETIONS=true; shift ;;
    --allow-dirty)    ALLOW_DIRTY=true; shift ;;
    --admin-email)    ADMIN_EMAIL_ARG="$2"; shift 2 ;;
    *)
      if [ -z "$STACK_NAME" ]; then
        STACK_NAME="$1"
        DEPLOY_MODE="single"
      fi
      shift ;;
  esac
done

header "Citadel Deployment"

# Load and validate environment
load_env "backend/.env"
validate_env
capture_git_info

# --- Provenance & divergence gates (findings 7f42ae86, 9c92a738) ---
# Run BEFORE any expensive build/synth so a wrong-clone / wrong-branch /
# divergent / dirty deploy fails fast, and so an unattended run without an
# explicit intended ref can never silently proceed.
if ! verify_expected_ref "$EXPECT_REF"; then
  exit 1
fi
if ! check_tree_state "$EXPECT_REF" "$ALLOW_DIRTY"; then
  exit 1
fi

[ -n "${AWS_PROFILE:-}" ] && { export AWS_PROFILE; ok "AWS Profile: $AWS_PROFILE"; } || unset AWS_PROFILE

# Resolve FRONTEND_ORIGIN (env override, else auto-discover from the
# frontend stack's output) before CDK synth/deploy so it's exported for cdk.
resolve_frontend_origin

# Pre-flight: ensure container runtime is available (needed for PythonFunction bundling)
DOCKER_CMD="${CDK_DOCKER:-docker}"
if ! command -v "$DOCKER_CMD" &>/dev/null; then
  err "Container runtime '$DOCKER_CMD' not found. Install Docker or Finch, or set CDK_DOCKER."
  exit 1
fi
if [ "$DOCKER_CMD" = "finch" ]; then
  if ! finch vm status 2>/dev/null | grep -qi "running"; then
    warn "Finch VM is not running. Starting it now..."
    finch vm start
    # Wait for VM to be ready
    retries=0
    while ! finch vm status 2>/dev/null | grep -qi "running"; do
      sleep 2
      retries=$((retries + 1))
      if [ $retries -ge 30 ]; then
        err "Finch VM failed to start after 60s. Run 'finch vm start' manually."
        exit 1
      fi
    done
    ok "Finch VM started"
  else
    ok "Finch VM running"
  fi
else
  if ! perl -e 'alarm 15; exec @ARGV' $DOCKER_CMD info &>/dev/null; then
    err "Docker daemon is not responding — restart Docker Desktop and retry"
    exit 1
  fi
  ok "Container runtime: $DOCKER_CMD"
fi

# Build phase
if [ "$SKIP_FRONTEND_BUILD" = false ]; then
  build_frontend
else
  warn "Skipping frontend build"
fi

if [ "$SKIP_BACKEND_BUILD" = false ]; then
  build_backend
else
  warn "Skipping backend build"
fi

# CDK synthesis requires backend node_modules AND dist/ even when --skip-backend
# (CDK runs `node dist/bin/app.js` which imports from node_modules)
# Check for a known critical dep rather than just the directory existing
if [ ! -f "backend/node_modules/source-map-support/register.js" ]; then
  log "Installing backend dependencies (required for CDK)..."
  pushd backend > /dev/null
  npm ci --prefer-offline 2>&1 | tail -1
  popd > /dev/null
fi
if [ ! -d "backend/dist" ]; then
  log "Building backend TypeScript (required for CDK synthesis)..."
  pushd backend > /dev/null
  npm run build 2>&1 | tee -a "$DEPLOY_LOG"
  popd > /dev/null
fi

# CDK synthesizes ALL stacks even when deploying one — ensure frontend/build exists
# so FrontendStack's BucketDeployment source doesn't fail during synth
if [ ! -d "frontend/build" ]; then
  log "Creating placeholder frontend/build (required for CDK synthesis)..."
  mkdir -p frontend/build
  echo "<html><body>placeholder</body></html>" > frontend/build/index.html
fi

# Ensure the API-key HMAC pepper exists before any stack deploys (idempotent)
ensure_api_key_pepper

# Recurrence guard: abort if this script's stack list has drifted from bin/app.ts
verify_stack_coverage

# Diff / dry-run
cdk_diff

# Verify CDK is targeting the correct region (AWS_DEFAULT_REGION was set in validate_env)
ok "Deploy target: account=$CDK_DEFAULT_ACCOUNT region=$AWS_DEFAULT_REGION"

if [ "$DRY_RUN" = true ]; then
  ok "Dry run complete — no changes deployed"
  exit 0
fi

# --- Deletion gate (finding 9c92a738) — FAIL CLOSED ---
# Parse the cdk diff captured just above for resource DELETIONS and REFUSE
# (naming each resource) unless --allow-deletions was passed. If the diff is
# empty or failed, refuse rather than assume no deletions.
diff_ok="true"
[ "${CDK_DIFF_RC:-1}" -eq 0 ] || diff_ok="false"
if ! deletion_gate "${CDK_DIFF_OUTPUT:-}" "$ALLOW_DELETIONS" "$diff_ok"; then
  exit 1
fi

# Deploy phase
case "$DEPLOY_MODE" in
  all)      deploy_all_stacks ;;
  backend)
    deploy_stack "citadel-backend-$ENVIRONMENT"
    deploy_stack "citadel-projects-$ENVIRONMENT"
    deploy_stack "citadel-registry-$ENVIRONMENT"
    deploy_stack "citadel-services-$ENVIRONMENT"
    deploy_stack "citadel-gateway-$ENVIRONMENT"
    deploy_stack "citadel-governance-$ENVIRONMENT"
    deploy_stack "citadel-arbiter-$ENVIRONMENT"
    deploy_stack "citadel-telemetry-$ENVIRONMENT"
    ;;
  frontend) deploy_stack "citadel-frontend-$ENVIRONMENT" ;;
  single)   deploy_stack "$STACK_NAME" ;;
esac

# Post-deploy: CloudFront invalidation + verification
if [ "$DEPLOY_MODE" = "all" ] || [ "$DEPLOY_MODE" = "frontend" ]; then
  # Extract distribution ID from CDK outputs
  if [ -f cdk-outputs.json ]; then
    DIST_ID=$(python3 -c "
import json
with open('cdk-outputs.json') as f:
    outputs = json.load(f)
stack = outputs.get('citadel-frontend-$ENVIRONMENT', {})
print(stack.get('CloudFrontDistributionId', ''))
" 2>/dev/null || echo "")

    if [ -n "$DIST_ID" ]; then
      invalidate_cloudfront "$DIST_ID"
      verify_frontend_bundle
    else
      warn "Could not extract CloudFront Distribution ID from outputs"
    fi
  fi

  if [ "$NO_VERIFY" = false ] && [ -f cdk-outputs.json ]; then
    FRONTEND_URL=$(python3 -c "
import json
with open('cdk-outputs.json') as f:
    outputs = json.load(f)
stack = outputs.get('citadel-frontend-$ENVIRONMENT', {})
print(stack.get('FrontendUrl', ''))
" 2>/dev/null || echo "")
    [ -n "$FRONTEND_URL" ] && health_check "$FRONTEND_URL"
  fi
fi

# Write manifest
write_manifest

header "✅ Deployment Complete"
ok "Environment: $ENVIRONMENT | Git: $GIT_BRANCH@$GIT_SHA | Log: $DEPLOY_LOG"
