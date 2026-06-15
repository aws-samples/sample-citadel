#!/bin/bash
# Citadel Cleanup Script (Improved)
#
# Usage:
#   ./clean.sh [options]
#
# Options:
#   --local          Clean local artifacts only (default)
#   --aws            Destroy all AWS stacks for the configured environment
#   --aws-only       Destroy AWS stacks without cleaning local artifacts
#   --keep-modules   Keep node_modules (faster rebuilds)
#   --profile <name> AWS profile for stack destruction
#   --yes            Skip confirmation prompts
#   --help           Show this help

set -euo pipefail

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${BLUE}==>${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

MODE="local"
KEEP_MODULES=false
AWS_PROFILE=""
AUTO_YES=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --local)        MODE="local"; shift ;;
    --aws)          MODE="all"; shift ;;
    --aws-only)     MODE="aws"; shift ;;
    --keep-modules) KEEP_MODULES=true; shift ;;
    --profile)      AWS_PROFILE="$2"; shift 2 ;;
    --yes|-y)       AUTO_YES=true; shift ;;
    --help|-h)
      echo "Usage: ./clean.sh [--local|--aws|--aws-only] [--keep-modules] [--profile <name>] [--yes]"
      exit 0 ;;
    *) shift ;;
  esac
done

# --- Local cleanup ---
clean_local() {
  log "Cleaning local artifacts..."

  if [ "$KEEP_MODULES" = false ]; then
    log "Removing node_modules..."
    # Only remove known node_modules locations, not inside .venv
    for dir in node_modules frontend/node_modules backend/node_modules; do
      [ -d "$dir" ] && rm -rf "$dir" && ok "Removed $dir"
    done
  else
    warn "Keeping node_modules"
  fi

  log "Removing Python cache..."
  find . -type d -name "__pycache__" -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null || true
  find . -type d -name ".pytest_cache" -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null || true
  find . -type d -name "*.egg-info" -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null || true
  find . -type d -name ".mypy_cache" -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null || true

  log "Removing build artifacts..."
  for dir in backend/dist frontend/build backend/cdk.out; do
    [ -d "$dir" ] && rm -rf "$dir" && ok "Removed $dir"
  done

  log "Removing logs and coverage..."
  find . -type f -name "*.log" -not -path "*/node_modules/*" -not -path "./.venv/*" -delete 2>/dev/null || true
  find . -type d -name "coverage" -not -path "*/node_modules/*" -exec rm -rf {} + 2>/dev/null || true
  find . -type d -name ".nyc_output" -exec rm -rf {} + 2>/dev/null || true
  find . -type d -name "htmlcov" -exec rm -rf {} + 2>/dev/null || true
  find . -type f -name ".coverage" -delete 2>/dev/null || true

  log "Removing temporary and OS files..."
  find . -type f -name ".DS_Store" -delete 2>/dev/null || true
  find . -type f \( -name "*.bak" -o -name "*.backup" -o -name "*~" \) -delete 2>/dev/null || true

  log "Removing deployment artifacts..."
  find . -maxdepth 1 -type f -name "deploy-*.log" -delete 2>/dev/null || true
  find . -maxdepth 1 -type f -name "deployment-manifest.json" -delete 2>/dev/null || true
  find . -maxdepth 1 -type f -name "cdk-outputs.json" -delete 2>/dev/null || true
  find . -type f -name "agent*_api.zip" -delete 2>/dev/null || true

  ok "Local cleanup complete"
}

# --- AWS resource teardown ---
clean_aws() {
  # Load environment
  if [ -f backend/.env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
      line="${line%%#*}"
      line="$(echo "$line" | xargs)"
      [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "$line"
    done < backend/.env
  fi

  : "${ENVIRONMENT:?ENVIRONMENT must be set in backend/.env}"
  : "${CDK_DEFAULT_REGION:?CDK_DEFAULT_REGION must be set in backend/.env}"

  local profile_flag=""
  [ -n "$AWS_PROFILE" ] && profile_flag="--profile $AWS_PROFILE" && export AWS_PROFILE
  local region="$CDK_DEFAULT_REGION"

  warn "This will DESTROY all Citadel stacks for environment: $ENVIRONMENT"
  warn "Region: $region"
  [ -n "$AWS_PROFILE" ] && warn "Profile: $AWS_PROFILE"

  if [ "$AUTO_YES" = false ]; then
    echo ""
    read -rp "Type 'destroy' to confirm: " confirm
    if [ "$confirm" != "destroy" ]; then
      warn "Aborted"
      exit 0
    fi
  fi

  # Stacks in reverse dependency order
  local stacks=(
    "citadel-frontend-${ENVIRONMENT}"
    "citadel-gateway-${ENVIRONMENT}"
    "citadel-arbiter-${ENVIRONMENT}"
    "citadel-services-${ENVIRONMENT}"
    "citadel-backend-${ENVIRONMENT}"
  )

  for stack in "${stacks[@]}"; do
    log "Checking $stack..."
    local status
    status=$(aws cloudformation describe-stacks \
      --stack-name "$stack" \
      --region "$region" \
      $profile_flag \
      --query 'Stacks[0].StackStatus' \
      --output text 2>/dev/null || echo "NOT_FOUND")

    if [ "$status" = "NOT_FOUND" ]; then
      ok "$stack does not exist, skipping"
      continue
    fi

    if [[ "$status" == *"FAILED"* ]] || [[ "$status" == *"ROLLBACK"* ]]; then
      warn "$stack is in $status state — attempting delete anyway"
    fi

    log "Deleting $stack (status: $status)..."
    aws cloudformation delete-stack \
      --stack-name "$stack" \
      --region "$region" \
      $profile_flag

    log "Waiting for $stack deletion..."
    if aws cloudformation wait stack-delete-complete \
      --stack-name "$stack" \
      --region "$region" \
      $profile_flag 2>/dev/null; then
      ok "$stack deleted"
    else
      err "$stack deletion may have failed — check CloudFormation console"
    fi
  done

  # Clean up orphaned IAM roles created by Credential Vender
  log "Checking for orphaned citadel-agent-* IAM roles..."
  local orphan_roles
  orphan_roles=$(aws iam list-roles \
    --path-prefix "/" \
    $profile_flag \
    --query "Roles[?starts_with(RoleName, 'citadel-agent-')].RoleName" \
    --output text 2>/dev/null || echo "")

  if [ -n "$orphan_roles" ]; then
    warn "Found orphaned roles: $orphan_roles"
    warn "These were created by the Credential Vender and must be deleted manually:"
    for role in $orphan_roles; do
      echo "  aws iam delete-role-policy --role-name $role --policy-name agent-policy $profile_flag"
      echo "  aws iam delete-role --role-name $role $profile_flag"
    done
  else
    ok "No orphaned agent roles found"
  fi

  ok "AWS cleanup complete"
}

# --- Execute ---
case "$MODE" in
  local) clean_local ;;
  aws)   clean_aws ;;
  all)   clean_aws; clean_local ;;
esac
