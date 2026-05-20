#!/bin/bash

# Script to run integration tests with real AppSync
# This script helps ensure environment variables are loaded correctly

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Running Integration Tests with Real AppSync${NC}"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
  echo -e "${RED}Error: .env file not found${NC}"
  echo "Please create a .env file with your AppSync configuration"
  echo "See .env.example for required variables"
  exit 1
fi

# Load environment variables
set -a
source .env
set +a

# Check required variables
if [ -z "$VITE_APPSYNC_ENDPOINT" ]; then
  echo -e "${RED}Error: VITE_APPSYNC_ENDPOINT is not set${NC}"
  echo "Please configure VITE_APPSYNC_ENDPOINT in your .env file"
  exit 1
fi

echo -e "${YELLOW}Configuration:${NC}"
echo "  AppSync Endpoint: $VITE_APPSYNC_ENDPOINT"
echo "  AWS Region: ${VITE_AWS_REGION:-ap-southeast-2}"
echo "  Auth Type: ${VITE_APPSYNC_AUTH_TYPE:-AMAZON_COGNITO_USER_POOLS}"
echo ""

# Run the tests
echo -e "${GREEN}Running tests...${NC}"
npm test -- integration.test.ts "$@"

echo ""
echo -e "${GREEN}Integration tests complete!${NC}"
