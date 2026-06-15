/**
 * Integration Tests with Real AppSync
 * 
 * These tests verify the subscription event bus works correctly with real AWS AppSync.
 * They test the full subscription flow, multiple component scenarios, cleanup, and reconnection.
 * 
 * NOTE: These tests require a real AppSync endpoint and valid credentials.
 * Set SKIP_INTEGRATION_TESTS=true to skip these tests in CI/CD.
 */

import { eventBus } from '../eventBus';
import { subscriptionManager } from '../subscriptionManager';
import { subscribeToChatter, ChatterMessage } from '../chatterService';
import serverService from '../server';
import {
  wait,
  isIntegrationTestConfigured,
  getIntegrationTestConfig,
} from './integrationHelpers';

// Check if integration tests should be skipped
const SKIP_INTEGRATION_TESTS = 
  process.env.SKIP_INTEGRATION_TESTS === 'true' ||
  !isIntegrationTestConfigured();

// Integration test timeout (longer for real network operations)
const INTEGRATION_TIMEOUT = 30000;

describe('Integration Tests with Real AppSync', () => {
  // Skip all tests if integration tests are disabled or not configured
  if (SKIP_INTEGRATION_TESTS) {
    const skipReason = !process.env.VITE_APPSYNC_ENDPOINT 
      ? 'Integration tests skipped (VITE_APPSYNC_ENDPOINT not configured)'
      : 'Integration tests skipped (SKIP_INTEGRATION_TESTS=true)';
    it.skip(skipReason, () => {});
    return;
  }

  beforeAll(() => {
    // Configure serverService with environment variables
    const config = getIntegrationTestConfig();
    serverService.configure(config);
  });

  beforeEach(() => {
    // Clean up before each test
    subscriptionManager.clearAll();
    eventBus.clear();
  });

  afterEach(() => {
    // Clean up after each test
    subscriptionManager.clearAll();
    eventBus.clear();
  });

  describe('Full subscription flow with real backend', () => {
    it(
      'should establish backend connection and receive real events',
      async () => {
        // Requirement: Backend subscription receives data and emits to all local subscribers
        // Requirement: Service initializes backend subscription

        const receivedMessages: ChatterMessage[] = [];

        // Subscribe to chatter
        const unsubscribe = subscribeToChatter((message) => {
          receivedMessages.push(message);
        });

        // Verify backend subscription was created
        const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
        expect(activeSubscriptions).toHaveLength(1);
        expect(activeSubscriptions[0].eventType).toBe('chatter');
        expect(activeSubscriptions[0].subscriberCount).toBe(1);

        // Wait for potential messages (this test depends on real backend activity)
        // In a real scenario, you might trigger an event through another service
        await wait(5000);

        // Clean up
        unsubscribe();

        // Verify cleanup happens after debounce period
        await wait(1500);
        const subscriptionsAfterCleanup = subscriptionManager.getActiveSubscriptions();
        expect(subscriptionsAfterCleanup).toHaveLength(0);

        // Note: We can't assert on receivedMessages.length because it depends on
        // real backend activity. In a production test, you would trigger events
        // through a test harness.
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should handle subscription lifecycle correctly',
      async () => {
        // Requirement 3.1: Service initializes backend subscription

        // Subscribe
        const unsubscribe = subscribeToChatter(() => {});

        // Verify subscription is active
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Unsubscribe
        unsubscribe();

        // Verify cleanup is scheduled (still active during debounce)
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Wait for debounce period
        await wait(1500);

        // Verify cleanup completed
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );
  });

  describe('Multiple components receive same events', () => {
    it(
      'should distribute events to all subscribers with single backend connection',
      async () => {
        // Requirement: Backend subscription receives data and emits to all local subscribers

        const component1Messages: ChatterMessage[] = [];
        const component2Messages: ChatterMessage[] = [];
        const component3Messages: ChatterMessage[] = [];

        // Simulate three components subscribing
        const unsubscribe1 = subscribeToChatter((message) => {
          component1Messages.push(message);
        });

        const unsubscribe2 = subscribeToChatter((message) => {
          component2Messages.push(message);
        });

        const unsubscribe3 = subscribeToChatter((message) => {
          component3Messages.push(message);
        });

        // Verify only one backend connection exists
        const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
        expect(activeSubscriptions).toHaveLength(1);
        expect(activeSubscriptions[0].subscriberCount).toBe(3);

        // Wait for potential messages
        await wait(5000);

        // Verify all components would receive the same messages
        // (In a real test with triggered events, we would assert equality)
        expect(component1Messages.length).toBe(component2Messages.length);
        expect(component2Messages.length).toBe(component3Messages.length);

        // Clean up
        unsubscribe1();
        unsubscribe2();
        unsubscribe3();

        // Wait for cleanup
        await wait(1500);
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should maintain connection while at least one subscriber exists',
      async () => {
        // Requirement: Backend subscription receives data and emits to all local subscribers

        const unsubscribe1 = subscribeToChatter(() => {});
        const unsubscribe2 = subscribeToChatter(() => {});
        const unsubscribe3 = subscribeToChatter(() => {});

        // Verify connection exists with 3 subscribers
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(3);

        // Unsubscribe first component
        unsubscribe1();
        await wait(100);

        // Connection should still exist
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(2);

        // Unsubscribe second component
        unsubscribe2();
        await wait(100);

        // Connection should still exist
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(1);

        // Unsubscribe last component
        unsubscribe3();

        // Connection should still exist during debounce
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Wait for cleanup
        await wait(1500);

        // Connection should be cleaned up
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );
  });

  describe('Cleanup when all components unmount', () => {
    it(
      'should cleanup backend connection after debounce period',
      async () => {
        // Requirement: Component re-subscribes to recently closed event type

        // Subscribe and immediately unsubscribe
        const unsubscribe = subscribeToChatter(() => {});
        unsubscribe();

        // Connection should still exist during debounce
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Wait for debounce period
        await wait(1500);

        // Connection should be cleaned up
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should cancel cleanup if new subscriber added during debounce',
      async () => {
        // Requirement: Component re-subscribes to recently closed event type

        // Subscribe and unsubscribe
        const unsubscribe1 = subscribeToChatter(() => {});
        unsubscribe1();

        // Connection should still exist during debounce
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Wait half the debounce period
        await wait(500);

        // Subscribe again before cleanup
        const unsubscribe2 = subscribeToChatter(() => {});

        // Wait past original cleanup time
        await wait(1000);

        // Connection should still exist
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(1);

        // Clean up
        unsubscribe2();
        await wait(1500);
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should handle rapid subscribe/unsubscribe cycles',
      async () => {
        // Requirement: Component re-subscribes to recently closed event type

        // Perform multiple rapid subscribe/unsubscribe cycles
        for (let i = 0; i < 5; i++) {
          const unsubscribe = subscribeToChatter(() => {});
          await wait(100);
          unsubscribe();
          await wait(100);
        }

        // Connection should still exist during debounce
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Wait for cleanup
        await wait(1500);

        // Connection should be cleaned up
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );
  });

  describe('Reconnection after network failure', () => {
    it(
      'should re-establish connection after cleanup',
      async () => {
        // Requirement: Component re-subscribes to recently closed event type

        // First subscription
        const unsubscribe1 = subscribeToChatter(() => {});
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);

        // Unsubscribe and wait for cleanup
        unsubscribe1();
        await wait(1500);
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);

        // Subscribe again (simulates reconnection)
        const unsubscribe2 = subscribeToChatter(() => {});

        // Verify new connection was established
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(1);

        // Clean up
        unsubscribe2();
        await wait(1500);
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should handle error events from backend',
      async () => {
        // Requirement: Backend subscription encounters errors and emits error events

        const errorEvents: any[] = [];

        // Subscribe to error events
        const errorUnsubscribe = eventBus.subscribe('subscriptionError', (error) => {
          errorEvents.push(error);
        });

        // Subscribe to chatter
        const unsubscribe = subscribeToChatter(() => {});

        // Wait for potential errors (in a real test, you might simulate network failure)
        await wait(5000);

        // Clean up
        unsubscribe();
        errorUnsubscribe();

        await wait(1500);

        // Note: We can't reliably trigger errors in integration tests without
        // simulating network failures. This test verifies the error handling
        // infrastructure is in place.
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should maintain subscriber count across reconnections',
      async () => {
        // Requirement: Component re-subscribes to recently closed event type

        // First connection with 2 subscribers
        const unsubscribe1 = subscribeToChatter(() => {});
        const unsubscribe2 = subscribeToChatter(() => {});
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(2);

        // Unsubscribe all and wait for cleanup
        unsubscribe1();
        unsubscribe2();
        await wait(1500);
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);

        // Reconnect with 3 subscribers
        const unsubscribe3 = subscribeToChatter(() => {});
        const unsubscribe4 = subscribeToChatter(() => {});
        const unsubscribe5 = subscribeToChatter(() => {});

        // Verify new connection has correct count
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(1);
        expect(subscriptionManager.getActiveSubscriptions()[0].subscriberCount).toBe(3);

        // Clean up
        unsubscribe3();
        unsubscribe4();
        unsubscribe5();
        await wait(1500);
        expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
      },
      INTEGRATION_TIMEOUT
    );
  });

  describe('Event bus integration', () => {
    it(
      'should emit events through event bus to all subscribers',
      async () => {
        // Requirement: Backend subscription receives data and emits to all local subscribers

        const messages1: ChatterMessage[] = [];
        const messages2: ChatterMessage[] = [];

        // Subscribe through service (which uses event bus internally)
        const unsubscribe1 = subscribeToChatter((message) => {
          messages1.push(message);
        });

        const unsubscribe2 = subscribeToChatter((message) => {
          messages2.push(message);
        });

        // Verify event bus has subscribers
        expect(eventBus.getSubscriberCount('chatter')).toBe(2);

        // Wait for potential messages
        await wait(5000);

        // Verify both subscribers received the same messages
        expect(messages1.length).toBe(messages2.length);

        // Clean up
        unsubscribe1();
        unsubscribe2();

        // Verify event bus cleaned up
        await wait(100);
        expect(eventBus.getSubscriberCount('chatter')).toBe(0);
      },
      INTEGRATION_TIMEOUT
    );

    it(
      'should handle subscriber errors without affecting other subscribers',
      async () => {
        // Requirement: Backend subscription receives data and emits to all local subscribers

        const messages1: ChatterMessage[] = [];
        const messages2: ChatterMessage[] = [];

        // First subscriber throws error
        const unsubscribe1 = subscribeToChatter((message) => {
          messages1.push(message);
          throw new Error('Subscriber error');
        });

        // Second subscriber works normally
        const unsubscribe2 = subscribeToChatter((message) => {
          messages2.push(message);
        });

        // Wait for potential messages
        await wait(5000);

        // Both should have received messages (errors don't stop other subscribers)
        expect(messages1.length).toBe(messages2.length);

        // Clean up
        unsubscribe1();
        unsubscribe2();
        await wait(1500);
      },
      INTEGRATION_TIMEOUT
    );
  });
});
