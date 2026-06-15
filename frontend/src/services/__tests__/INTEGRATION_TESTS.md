# Integration Tests with Real AppSync

This document describes how to run integration tests that connect to a real AWS AppSync endpoint.

## Overview

The integration tests in `integration.test.ts` verify that the subscription event bus works correctly with real AWS AppSync WebSocket connections. These tests cover:

1. **Full subscription flow** - Establishing backend connections and receiving real events
2. **Multiple component scenarios** - Verifying multiple subscribers share a single backend connection
3. **Cleanup behavior** - Testing debounced cleanup when all components unmount
4. **Reconnection** - Verifying connections can be re-established after cleanup

## Requirements

### Environment Variables

The integration tests require the following environment variables to be set:

```bash
# Required
VITE_APPSYNC_ENDPOINT=https://xxxxx.appsync-api.ap-southeast-2.amazonaws.com/graphql
VITE_AWS_REGION=ap-southeast-2
VITE_APPSYNC_REGION=ap-southeast-2
VITE_APPSYNC_AUTH_TYPE=AMAZON_COGNITO_USER_POOLS

# Required for Cognito auth
VITE_COGNITO_USER_POOL_ID=ap-southeast-2_xxxxxxxxx
VITE_COGNITO_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional
VITE_COGNITO_IDENTITY_POOL_ID=ap-southeast-2:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
VITE_APPSYNC_API_KEY=da2-xxxxxxxxxxxxxxxxxxxxxxxxxx  # Only if using API_KEY auth
```

### AWS Credentials

If using `AMAZON_COGNITO_USER_POOLS` authentication (default), you'll need valid Cognito credentials. The tests use the Amplify Auth module which handles authentication automatically.

For API_KEY authentication, set `VITE_APPSYNC_AUTH_TYPE=API_KEY` and provide `VITE_APPSYNC_API_KEY`.

## Running the Tests

### Local Development

1. **Set up environment variables**:
   ```bash
   cd frontend
   cp .env.example .env
   # Edit .env with your AppSync endpoint and credentials
   ```

2. **Run integration tests**:
   ```bash
   npm test -- integration.test.ts
   ```

3. **Run with verbose output**:
   ```bash
   npm test -- integration.test.ts --verbose
   ```

### Skipping Integration Tests

Integration tests are automatically skipped in CI/CD environments or when you don't want to connect to real AWS services:

```bash
# Skip integration tests
SKIP_INTEGRATION_TESTS=true npm test
```

This is useful for:
- CI/CD pipelines without AWS credentials
- Local development without AppSync access
- Running only unit tests

### CI/CD Configuration

In your CI/CD pipeline, you can either:

1. **Skip integration tests** (recommended for most pipelines):
   ```yaml
   test:
     script:
       - cd frontend
       - SKIP_INTEGRATION_TESTS=true npm test
   ```

2. **Run integration tests** (requires AWS credentials):
   ```yaml
   integration-test:
     script:
       - cd frontend
       - npm test -- integration.test.ts
     variables:
       VITE_APPSYNC_ENDPOINT: $APPSYNC_ENDPOINT
       VITE_AWS_REGION: $AWS_REGION
       # ... other variables from CI/CD secrets
   ```

## Test Structure

### Test Suites

1. **Full subscription flow with real backend**
   - Tests establishing connections and receiving events
   - Verifies subscription lifecycle (subscribe → receive → unsubscribe → cleanup)

2. **Multiple components receive same events**
   - Tests that multiple subscribers share one backend connection
   - Verifies all subscribers receive the same events
   - Tests connection maintenance while subscribers exist

3. **Cleanup when all components unmount**
   - Tests debounced cleanup (1 second delay)
   - Verifies cleanup cancellation when new subscribers added
   - Tests rapid subscribe/unsubscribe cycles

4. **Reconnection after network failure**
   - Tests re-establishing connections after cleanup
   - Verifies error handling infrastructure
   - Tests subscriber count across reconnections

5. **Event bus integration**
   - Tests event distribution through event bus
   - Verifies error handling doesn't affect other subscribers

### Test Timeouts

Integration tests use a 30-second timeout to account for:
- Network latency
- WebSocket connection establishment
- Debounce periods (1 second)
- Waiting for real backend events

## Limitations

### Event Triggering

The integration tests cannot reliably trigger backend events because:
- They don't have access to the backend event publishing mechanism
- Real events depend on other system activity

Therefore, some tests wait for potential events but don't assert on specific message content. In a production environment, you would:

1. Create a test harness that can publish events to AppSync
2. Use a dedicated test environment with controlled event generation
3. Mock the backend subscription for more deterministic testing

### Network Conditions

The tests assume:
- Stable network connection
- AppSync endpoint is accessible
- Valid authentication credentials

They don't test:
- Network interruptions (would require network simulation)
- Authentication failures (would require invalid credentials)
- Rate limiting (would require high-volume testing)

## Troubleshooting

### Tests Timeout

If tests timeout, check:
1. AppSync endpoint is correct and accessible
2. Network connection is stable
3. Authentication credentials are valid
4. AWS region matches your AppSync endpoint

### Connection Errors

If you see connection errors:
1. Verify `VITE_APPSYNC_ENDPOINT` is correct
2. Check authentication type matches your AppSync configuration
3. Ensure Cognito credentials are valid (if using Cognito auth)
4. Verify API key is valid (if using API_KEY auth)

### No Events Received

This is expected behavior in integration tests because:
- Tests don't trigger backend events
- Real events depend on system activity
- Tests verify infrastructure, not event content

To test event reception:
1. Manually trigger events through your application
2. Create a test harness for event publishing
3. Use a dedicated test environment

## Best Practices

1. **Use environment-specific endpoints**: Don't run integration tests against production
2. **Skip in CI/CD**: Use `SKIP_INTEGRATION_TESTS=true` unless you have a test environment
3. **Run locally**: Integration tests are most useful during local development
4. **Combine with unit tests**: Integration tests complement, not replace, unit tests
5. **Monitor costs**: Real AppSync connections incur AWS costs

## Related Files

- `integration.test.ts` - Integration test suite
- `subscriptionManager.test.ts` - Unit tests for SubscriptionManager
- `eventBus.test.ts` - Unit tests for EventBus
- `chatterService.ts` - Service implementation using event bus
- `subscriptionManager.ts` - Backend subscription coordinator
- `eventBus.ts` - Local event distribution

## Requirements Validated

These integration tests validate the following requirements from the design document:

- **Requirement 1.5**: Backend subscription receives data and emits to all local subscribers
- **Requirement 3.1**: Service initializes backend subscription
- **Requirement 3.3**: Backend subscription encounters errors and emits error events
- **Requirement 6.4**: Component re-subscribes to recently closed event type

For complete requirement coverage, see the unit tests and property-based tests.
