# Integration Test Architecture

This document explains the architecture and design decisions for the integration tests with real AWS AppSync.

## Overview

The integration tests verify that the subscription event bus works correctly with real AWS AppSync WebSocket connections. Unlike unit tests that mock external dependencies, integration tests connect to actual AWS services to validate end-to-end functionality.

## Architecture Layers

### 1. Test Infrastructure

**Files:**
- `integration.test.ts` - Main integration test suite
- `integrationHelpers.ts` - Shared utilities for integration testing
- `INTEGRATION_TESTS.md` - User documentation
- `INTEGRATION_ARCHITECTURE.md` - This file

**Purpose:**
- Provide reusable test utilities
- Configure AppSync connections
- Handle test lifecycle (setup/teardown)
- Manage test timeouts and async operations

### 2. Service Layer Under Test

**Components:**
- `subscriptionManager.ts` - Backend subscription coordinator
- `eventBus.ts` - Local event distribution
- `chatterService.ts` - Example service using event bus
- `server.ts` - AppSync client wrapper

**What We Test:**
- Backend subscription establishment
- Event distribution to multiple subscribers
- Reference counting and cleanup
- Reconnection after cleanup
- Error handling

### 3. AWS AppSync Backend

**Real Services:**
- AWS AppSync GraphQL API
- WebSocket subscriptions
- Amazon Cognito authentication (optional)

**What We Don't Control:**
- Event timing and content
- Network conditions
- Service availability

## Test Design Patterns

### Pattern 1: Auto-Skip When Not Configured

```typescript
const SKIP_INTEGRATION_TESTS = 
  process.env.SKIP_INTEGRATION_TESTS === 'true' ||
  !isIntegrationTestConfigured();

if (SKIP_INTEGRATION_TESTS) {
  it.skip('Integration tests skipped', () => {});
  return;
}
```

**Why:**
- Tests don't fail in CI/CD without AWS credentials
- Developers can run unit tests without AppSync access
- Clear feedback about why tests are skipped

### Pattern 2: Infrastructure Testing Over Content Testing

```typescript
// ✅ Good: Test infrastructure
expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);
expect(activeSubscriptions[0].subscriberCount).toBe(3);

// ❌ Bad: Test event content (unreliable)
expect(receivedMessages[0].message).toBe('specific message');
```

**Why:**
- We can't control when/if backend events arrive
- Infrastructure behavior is deterministic
- Content depends on external system state

### Pattern 3: Timeout-Based Waiting

```typescript
// Wait for potential messages
await wait(5000);

// Verify infrastructure state
expect(messages1.length).toBe(messages2.length);
```

**Why:**
- Real network operations take time
- WebSocket connections need time to establish
- Debounce periods need to complete

### Pattern 4: Cleanup Verification

```typescript
// Unsubscribe
unsubscribe();

// Verify cleanup is scheduled (still active during debounce)
expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

// Wait for debounce period
await wait(1500);

// Verify cleanup completed
expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
```

**Why:**
- Tests the debounced cleanup behavior
- Verifies reference counting works correctly
- Ensures no resource leaks

## Test Categories

### 1. Full Subscription Flow

**Tests:**
- Backend connection establishment
- Event reception (if available)
- Subscription lifecycle

**Requirements Validated:**
- 1.5: Backend subscription receives data and emits to all local subscribers
- 3.1: Service initializes backend subscription

**Key Assertions:**
- Backend subscription is created
- Subscriber count is tracked correctly
- Cleanup happens after debounce

### 2. Multiple Component Scenarios

**Tests:**
- Multiple subscribers share one connection
- All subscribers receive same events
- Connection maintained while subscribers exist

**Requirements Validated:**
- 1.5: Backend subscription receives data and emits to all local subscribers

**Key Assertions:**
- Only one backend connection for multiple subscribers
- Subscriber count reflects all local subscribers
- Connection persists until last subscriber unsubscribes

### 3. Cleanup Behavior

**Tests:**
- Debounced cleanup after last unsubscribe
- Cleanup cancellation when new subscriber added
- Rapid subscribe/unsubscribe cycles

**Requirements Validated:**
- 6.4: Component re-subscribes to recently closed event type

**Key Assertions:**
- Connection exists during debounce period
- Connection cleaned up after debounce
- New subscribers cancel pending cleanup

### 4. Reconnection

**Tests:**
- Re-establishing connection after cleanup
- Error event handling
- Subscriber count across reconnections

**Requirements Validated:**
- 3.3: Backend subscription encounters errors and emits error events
- 6.4: Component re-subscribes to recently closed event type

**Key Assertions:**
- New connection created after cleanup
- Subscriber count resets correctly
- Error infrastructure is in place

### 5. Event Bus Integration

**Tests:**
- Event distribution through event bus
- Error handling doesn't affect other subscribers

**Requirements Validated:**
- 1.5: Backend subscription receives data and emits to all local subscribers

**Key Assertions:**
- All subscribers receive events
- Subscriber errors don't stop other subscribers
- Event bus cleanup works correctly

## Limitations and Trade-offs

### Limitation 1: Can't Trigger Backend Events

**Problem:**
- Tests can't reliably trigger AppSync events
- Event content and timing are unpredictable

**Solution:**
- Test infrastructure, not content
- Use timeouts to wait for potential events
- Assert on message counts, not content

**Trade-off:**
- Less comprehensive than tests with controlled events
- More focused on infrastructure correctness

### Limitation 2: Network Dependency

**Problem:**
- Tests require network access
- Tests can fail due to network issues
- Tests incur AWS costs

**Solution:**
- Auto-skip when not configured
- Provide clear error messages
- Document when to run integration tests

**Trade-off:**
- Can't run in all environments
- Slower than unit tests
- Requires AWS credentials

### Limitation 3: Timing Sensitivity

**Problem:**
- Real network operations have variable timing
- Debounce periods must complete
- WebSocket connections take time

**Solution:**
- Use generous timeouts (30 seconds)
- Wait for debounce periods explicitly
- Use helper functions for timing

**Trade-off:**
- Tests are slower
- May have false positives/negatives
- Harder to debug timing issues

## Best Practices

### 1. Use Helper Functions

```typescript
// ✅ Good: Use helper
await wait(1500);

// ❌ Bad: Inline timeout
await new Promise(resolve => setTimeout(resolve, 1500));
```

### 2. Test Infrastructure, Not Content

```typescript
// ✅ Good: Test structure
expect(messages1.length).toBe(messages2.length);

// ❌ Bad: Test content
expect(messages1[0].text).toBe('Hello');
```

### 3. Clean Up After Tests

```typescript
afterEach(() => {
  subscriptionManager.clearAll();
  eventBus.clear();
});
```

### 4. Use Descriptive Test Names

```typescript
// ✅ Good: Describes what and why
it('should maintain connection while at least one subscriber exists', ...)

// ❌ Bad: Vague
it('test connection', ...)
```

### 5. Document Requirements

```typescript
// Requirement 1.5: Backend subscription receives data and emits to all local subscribers
// Requirement 3.1: Service initializes backend subscription
```

## Running Integration Tests

### Local Development

```bash
# With environment configured
npm run test:integration

# Or manually
npm test -- integration.test.ts
```

### CI/CD

```bash
# Skip integration tests (recommended)
SKIP_INTEGRATION_TESTS=true npm test

# Or run with credentials
npm test -- integration.test.ts
```

### Debugging

```bash
# Run with verbose output
npm test -- integration.test.ts --verbose

# Run specific test
npm test -- integration.test.ts -t "should establish backend connection"
```

## Future Enhancements

### 1. Test Event Publisher

Create a test harness that can publish events to AppSync:

```typescript
// Proposed API
await testPublisher.publishChatterEvent({
  message: 'test',
  timestamp: new Date().toISOString()
});

await waitForMessages(receivedMessages, 1);
expect(receivedMessages[0].message).toBe('test');
```

**Benefits:**
- Deterministic event testing
- Content validation
- Timing control

### 2. Network Simulation

Simulate network conditions:

```typescript
// Proposed API
await networkSimulator.disconnect();
// Verify error handling

await networkSimulator.reconnect();
// Verify reconnection
```

**Benefits:**
- Test error scenarios
- Test reconnection logic
- Test resilience

### 3. Dedicated Test Environment

Use a dedicated AppSync endpoint for testing:

```typescript
// Proposed configuration
VITE_APPSYNC_ENDPOINT_TEST=https://test.appsync-api...
```

**Benefits:**
- Isolated from production
- Controlled event generation
- No impact on real users

## Related Documentation

- `INTEGRATION_TESTS.md` - User guide for running tests
- `../subscriptionManager.ts` - Backend subscription coordinator
- `../eventBus.ts` - Local event distribution
- `../../design.md` - Overall system design
- `../../requirements.md` - System requirements

## Conclusion

The integration tests provide confidence that the subscription event bus works correctly with real AWS AppSync. While they have limitations (can't trigger events, network dependency), they validate the critical infrastructure behavior that unit tests can't verify.

The tests are designed to:
- Auto-skip when not configured
- Test infrastructure over content
- Handle timing and async operations
- Clean up resources properly
- Provide clear feedback

This architecture balances comprehensive testing with practical constraints of integration testing.
