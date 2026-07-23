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

# --- Capture git metadata ---
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
  $diff_cmd --all 2>&1 | tee -a "$DEPLOY_LOG" || true
  popd > /dev/null
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
    log "Deploying $stack_name (attempt $attempt/$max_attempts)..."
    pushd backend > /dev/null
    local cmd="npx cdk deploy $stack_name --require-approval never --outputs-file ../cdk-outputs.json"
    [ -n "${AWS_PROFILE:-}" ] && cmd="$cmd --profile $AWS_PROFILE"

    # Pass admin email as CDK context if provided via --admin-email or ADMIN_EMAIL env var
    local admin_email="${ADMIN_EMAIL_ARG:-${ADMIN_EMAIL:-}}"
    [ -n "$admin_email" ] && cmd="$cmd -c adminEmail=$admin_email"

    if $cmd 2>&1 | tee -a "$DEPLOY_LOG"; then
      ok "$stack_name deployed successfully"
      popd > /dev/null
      return 0
    fi
    popd > /dev/null

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
      warn "$stack_name failed, retrying in 10s..."
      sleep 10
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
  #   services      ← backend
  #   gateway       ← backend
  #   governance    ← backend      (governance tables + resolvers split from backend)
  #   arbiter       ← services
  #   frontend      ← arbiter
  #
  # Stacks sharing a parent deploy sequentially here (rather than in parallel)
  # so a rollback in one doesn't disturb a sibling mid-deploy. The CDK tooling
  # handles the topological ordering internally; this list only enforces
  # which stacks deploy.sh attempts and in what order.
  deploy_stack "citadel-backend-$env" || failed+=("backend")

  if [ ${#failed[@]} -eq 0 ]; then
    # ServicesStack, GatewayStack, and GovernanceStack all depend on
    # BackendStack only (no interdependency among the three).
    deploy_stack "citadel-services-$env"   || failed+=("services")
    deploy_stack "citadel-gateway-$env"    || failed+=("gateway")
    deploy_stack "citadel-governance-$env" || failed+=("governance")
  else
    warn "Skipping services/gateway/governance — backend failed"
  fi

  if [ ${#failed[@]} -eq 0 ] || [[ ! " ${failed[*]} " =~ " backend " && ! " ${failed[*]} " =~ " services " ]]; then
    deploy_stack "citadel-arbiter-$env" || failed+=("arbiter")
  else
    warn "Skipping arbiter — dependency failed (${failed[*]})"
  fi

  if [ ${#failed[@]} -eq 0 ] || [[ ! " ${failed[*]} " =~ " backend " && ! " ${failed[*]} " =~ " arbiter " ]]; then
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
write_manifest() {
  local manifest_file="deployment-manifest.json"
  local deployer
  deployer=$(aws sts get-caller-identity --query 'Arn' --output text ${AWS_PROFILE:+--profile $AWS_PROFILE} 2>/dev/null || echo "unknown")

  cat > "$manifest_file" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "environment": "$ENVIRONMENT",
  "region": "$CDK_DEFAULT_REGION",
  "account": "$CDK_DEFAULT_ACCOUNT",
  "git_sha": "$GIT_SHA",
  "git_branch": "$GIT_BRANCH",
  "git_dirty": "$GIT_DIRTY",
  "deployer": "$deployer",
  "stacks_deployed": "$DEPLOY_MODE"
}
EOF
  ok "Deployment manifest written to $manifest_file"
}

# --- Help ---
show_help() {
  echo "Citadel Deployment Script"
  echo ""
  echo "Usage: ./deploy.sh [options] [stack-name]"
  echo ""
  echo "Options:"
  echo "  --all                Deploy all stacks (default)"
  echo "  --backend-only       Deploy only backend stacks (backend + services + gateway + governance + arbiter)"
  echo "  --frontend-only      Deploy only frontend stack"
  echo "  --skip-frontend      Skip frontend build"
  echo "  --skip-backend       Skip backend build"
  echo "  --profile <name>     Use specific AWS profile"
  echo "  --dry-run            Preview changes only (cdk diff)"
  echo "  --no-verify          Skip post-deploy health checks"
  echo "  --admin-email <addr> Admin email for initial user (overrides ADMIN_EMAIL env var)"
  echo "  --help               Show this help message"
  exit 0
}

# --- Main ---
STACK_NAME=""
AWS_PROFILE=""
DEPLOY_MODE="all"
SKIP_FRONTEND_BUILD=false
SKIP_BACKEND_BUILD=false
DRY_RUN=false
NO_VERIFY=false
ADMIN_EMAIL_ARG=""

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

[ -n "${AWS_PROFILE:-}" ] && { export AWS_PROFILE; ok "AWS Profile: $AWS_PROFILE"; } || unset AWS_PROFILE

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

# Diff / dry-run
cdk_diff

# Verify CDK is targeting the correct region (AWS_DEFAULT_REGION was set in validate_env)
ok "Deploy target: account=$CDK_DEFAULT_ACCOUNT region=$AWS_DEFAULT_REGION"

if [ "$DRY_RUN" = true ]; then
  ok "Dry run complete — no changes deployed"
  exit 0
fi

# Deploy phase
case "$DEPLOY_MODE" in
  all)      deploy_all_stacks ;;
  backend)
    deploy_stack "citadel-backend-$ENVIRONMENT"
    deploy_stack "citadel-services-$ENVIRONMENT"
    deploy_stack "citadel-gateway-$ENVIRONMENT"
    deploy_stack "citadel-governance-$ENVIRONMENT"
    deploy_stack "citadel-arbiter-$ENVIRONMENT"
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
