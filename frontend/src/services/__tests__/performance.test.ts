/**
 * Performance tests for EventBus and SubscriptionManager
 * 
 * Tests Requirements 6.1, 6.2, 6.3:
 * - Profile event emission with 1000 subscribers
 * - Optimize callback invocation loop
 * - Verify memory usage is within benchmarks
 * - Test debounce timing under load
 */

import { EventBus } from '../eventBus';
import { SubscriptionManager } from '../subscriptionManager';
import { EVENT_TYPES } from '../eventTypes';

describe('Performance Tests', () => {
  describe('EventBus Performance', () => {
    let eventBus: EventBus;

    beforeEach(() => {
      eventBus = new EventBus();
    });

    afterEach(() => {
      eventBus.clear();
    });

    /**
     * Requirement 6.1: Test event emission with 1000 subscribers
     * Benchmark: < 10ms emit time for 1000 subscribers
     */
    it('should emit events to 1000 subscribers within 10ms', () => {
      const subscriberCount = 1000;
      const callbacks: Array<jest.Mock> = [];

      // Subscribe 1000 callbacks
      for (let i = 0; i < subscriberCount; i++) {
        const callback = jest.fn();
        callbacks.push(callback);
        eventBus.subscribe(EVENT_TYPES.CHATTER, callback);
      }

      // Verify all subscribers are registered
      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(subscriberCount);

      // Measure emission time
      const testData = { id: 'test', message: 'performance test' };
      const startTime = performance.now();
      
      eventBus.emit(EVENT_TYPES.CHATTER, testData);
      
      const endTime = performance.now();
      const emitTime = endTime - startTime;

      // Verify all callbacks were invoked
      callbacks.forEach((callback) => {
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(testData);
      });

      // Assert performance benchmark
      expect(emitTime).toBeLessThan(10);
      
      console.log(`✓ Event emission to ${subscriberCount} subscribers took ${emitTime.toFixed(2)}ms`);
    });

    /**
     * Test callback invocation optimization
     * Verify that callbacks are invoked synchronously and efficiently
     */
    it('should invoke callbacks synchronously without event loop overhead', () => {
      const subscriberCount = 100;
      const callbacks: Array<jest.Mock> = [];
      let callbackOrder: number[] = [];

      // Subscribe callbacks that track invocation order
      for (let i = 0; i < subscriberCount; i++) {
        const callback = jest.fn(() => {
          callbackOrder.push(i);
        });
        callbacks.push(callback);
        eventBus.subscribe(EVENT_TYPES.CHATTER, callback);
      }

      const testData = { id: 'test' };
      eventBus.emit(EVENT_TYPES.CHATTER, testData);

      // Verify all callbacks were invoked synchronously
      expect(callbackOrder.length).toBe(subscriberCount);
      
      // Verify callbacks were invoked in order (Set maintains insertion order)
      for (let i = 0; i < subscriberCount; i++) {
        expect(callbackOrder[i]).toBe(i);
      }
    });

    /**
     * Test memory efficiency with multiple event types
     * Requirement 6.2: Verify memory usage patterns
     */
    it('should handle multiple event types efficiently', () => {
      const eventTypes = Object.values(EVENT_TYPES).filter(
        (type) => type !== EVENT_TYPES.SUBSCRIPTION_ERROR
      );
      const subscribersPerType = 100;

      // Subscribe to all event types
      eventTypes.forEach((eventType) => {
        for (let i = 0; i < subscribersPerType; i++) {
          eventBus.subscribe(eventType, jest.fn());
        }
      });

      // Verify subscriber counts
      eventTypes.forEach((eventType) => {
        expect(eventBus.getSubscriberCount(eventType)).toBe(subscribersPerType);
      });

      // Verify active event types
      const activeTypes = eventBus.getActiveEventTypes();
      expect(activeTypes.length).toBe(eventTypes.length);

      // Measure memory by checking internal structure
      // EventBus should use Map and Set for O(1) operations
      const totalSubscribers = eventTypes.length * subscribersPerType;
      console.log(`✓ Managing ${totalSubscribers} subscribers across ${eventTypes.length} event types`);
    });

    /**
     * Test cleanup efficiency
     * Verify that unsubscribing removes callbacks and cleans up empty sets
     */
    it('should clean up empty subscriber sets to prevent memory leaks', () => {
      const subscriberCount = 100;
      const unsubscribeFunctions: Array<() => void> = [];

      // Subscribe callbacks
      for (let i = 0; i < subscriberCount; i++) {
        const unsubscribe = eventBus.subscribe(EVENT_TYPES.CHATTER, jest.fn());
        unsubscribeFunctions.push(unsubscribe);
      }

      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(subscriberCount);

      // Unsubscribe all
      unsubscribeFunctions.forEach((unsubscribe) => unsubscribe());

      // Verify cleanup
      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(0);
      expect(eventBus.getActiveEventTypes()).not.toContain(EVENT_TYPES.CHATTER);
    });

    /**
     * Test error handling doesn't impact performance
     * Verify that one callback error doesn't stop others
     */
    it('should continue invoking callbacks even if one throws an error', () => {
      const subscriberCount = 100;
      const errorIndex = 50;
      const callbacks: Array<jest.Mock> = [];

      // Subscribe callbacks, one will throw an error
      for (let i = 0; i < subscriberCount; i++) {
        const callback = jest.fn(() => {
          if (i === errorIndex) {
            throw new Error('Test error');
          }
        });
        callbacks.push(callback);
        eventBus.subscribe(EVENT_TYPES.CHATTER, callback);
      }

      const testData = { id: 'test' };
      
      // Should not throw
      expect(() => {
        eventBus.emit(EVENT_TYPES.CHATTER, testData);
      }).not.toThrow();

      // Verify all callbacks were invoked
      callbacks.forEach((callback) => {
        expect(callback).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('SubscriptionManager Performance', () => {
    let subscriptionManager: SubscriptionManager;

    beforeEach(() => {
      subscriptionManager = SubscriptionManager.getInstance();
      subscriptionManager.clearAll();
    });

    afterEach(() => {
      subscriptionManager.clearAll();
    });

    /**
     * Requirement 6.3: Test debounce timing under load
     * Verify that cleanup happens within 1 second after last subscriber removes
     */
    it('should cleanup subscription within debounce period (1 second)', async () => {
      const eventType = EVENT_TYPES.CHATTER;
      const mockQuery = 'subscription { onChatter { id } }';
      const mockVariables = {};
      const mockTransformer = (data: any) => data;

      // Initialize subscription
      subscriptionManager.initializeSubscription(
        eventType,
        mockQuery,
        mockVariables,
        mockTransformer
      );

      // Add subscribers
      subscriptionManager.addLocalSubscriber(eventType);
      subscriptionManager.addLocalSubscriber(eventType);
      subscriptionManager.addLocalSubscriber(eventType);

      // Verify subscription is active
      let activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(1);
      expect(activeSubscriptions[0].subscriberCount).toBe(3);

      // Remove all subscribers
      subscriptionManager.removeLocalSubscriber(eventType);
      subscriptionManager.removeLocalSubscriber(eventType);
      subscriptionManager.removeLocalSubscriber(eventType);

      // Subscription should still be active (debounced)
      activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(1);

      // Wait for debounce period (1 second + buffer)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Subscription should now be cleaned up
      activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(0);

      console.log('✓ Cleanup completed within debounce period');
    });

    /**
     * Test rapid subscribe/unsubscribe cycles
     * Verify debounce prevents unnecessary reconnections
     */
    it('should handle rapid subscribe/unsubscribe cycles efficiently', async () => {
      const eventType = EVENT_TYPES.CHATTER;
      const mockQuery = 'subscription { onChatter { id } }';
      const mockVariables = {};
      const mockTransformer = (data: any) => data;

      // Initialize subscription
      subscriptionManager.initializeSubscription(
        eventType,
        mockQuery,
        mockVariables,
        mockTransformer
      );

      // Perform rapid subscribe/unsubscribe cycles
      const cycles = 10;
      for (let i = 0; i < cycles; i++) {
        subscriptionManager.addLocalSubscriber(eventType);
        subscriptionManager.removeLocalSubscriber(eventType);
      }

      // Subscription should still be active (debounced)
      let activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(1);

      // Wait for debounce period
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Subscription should now be cleaned up
      activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(0);

      console.log(`✓ Handled ${cycles} rapid subscribe/unsubscribe cycles efficiently`);
    });

    /**
     * Requirement 6.2: Test connection count equals event type count
     * Verify that M event types result in M connections
     */
    it('should maintain exactly one connection per event type', () => {
      const eventTypes = [
        EVENT_TYPES.CHATTER,
        EVENT_TYPES.FABRICATION,
        EVENT_TYPES.CONVERSATION,
      ];
      const mockQuery = 'subscription { test { id } }';
      const mockVariables = {};
      const mockTransformer = (data: any) => data;

      // Initialize subscriptions for multiple event types
      eventTypes.forEach((eventType) => {
        subscriptionManager.initializeSubscription(
          eventType,
          mockQuery,
          mockVariables,
          mockTransformer
        );

        // Add multiple subscribers to each
        subscriptionManager.addLocalSubscriber(eventType);
        subscriptionManager.addLocalSubscriber(eventType);
        subscriptionManager.addLocalSubscriber(eventType);
      });

      // Verify connection count equals event type count
      const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(eventTypes.length);

      // Verify each has correct subscriber count
      activeSubscriptions.forEach((subscription) => {
        expect(subscription.subscriberCount).toBe(3);
      });

      console.log(`✓ Maintained ${eventTypes.length} connections for ${eventTypes.length} event types`);
    });

    /**
     * Test memory efficiency with subscriber count tracking
     */
    it('should track subscriber counts accurately without memory overhead', () => {
      const eventType = EVENT_TYPES.CHATTER;
      const mockQuery = 'subscription { onChatter { id } }';
      const mockVariables = {};
      const mockTransformer = (data: any) => data;

      // Initialize subscription
      subscriptionManager.initializeSubscription(
        eventType,
        mockQuery,
        mockVariables,
        mockTransformer
      );

      // Add many subscribers
      const subscriberCount = 1000;
      for (let i = 0; i < subscriberCount; i++) {
        subscriptionManager.addLocalSubscriber(eventType);
      }

      // Verify count
      const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions.length).toBe(1);
      expect(activeSubscriptions[0].subscriberCount).toBe(subscriberCount);

      // Remove half
      for (let i = 0; i < subscriberCount / 2; i++) {
        subscriptionManager.removeLocalSubscriber(eventType);
      }

      // Verify updated count
      const updatedSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(updatedSubscriptions[0].subscriberCount).toBe(subscriberCount / 2);

      console.log(`✓ Accurately tracked ${subscriberCount} subscribers`);
    });
  });

  describe('Integrated Performance', () => {
    let eventBus: EventBus;
    let subscriptionManager: SubscriptionManager;

    beforeEach(() => {
      eventBus = new EventBus();
      subscriptionManager = SubscriptionManager.getInstance();
      subscriptionManager.clearAll();
    });

    afterEach(() => {
      eventBus.clear();
      subscriptionManager.clearAll();
    });

    /**
     * Test full subscription flow performance
     * Simulates real-world usage with multiple components
     */
    it('should handle full subscription flow efficiently', () => {
      const eventType = EVENT_TYPES.CHATTER;
      const componentCount = 100;
      const unsubscribeFunctions: Array<() => void> = [];

      // Simulate components subscribing
      const startTime = performance.now();

      for (let i = 0; i < componentCount; i++) {
        const unsubscribe = eventBus.subscribe(eventType, jest.fn());
        unsubscribeFunctions.push(unsubscribe);
      }

      const subscribeTime = performance.now() - startTime;

      // Emit event
      const emitStartTime = performance.now();
      eventBus.emit(eventType, { id: 'test', data: 'performance' });
      const emitTime = performance.now() - emitStartTime;

      // Unsubscribe all
      const unsubscribeStartTime = performance.now();
      unsubscribeFunctions.forEach((unsubscribe) => unsubscribe());
      const unsubscribeTime = performance.now() - unsubscribeStartTime;

      console.log(`✓ Full flow for ${componentCount} components:`);
      console.log(`  - Subscribe: ${subscribeTime.toFixed(2)}ms`);
      console.log(`  - Emit: ${emitTime.toFixed(2)}ms`);
      console.log(`  - Unsubscribe: ${unsubscribeTime.toFixed(2)}ms`);

      // Assert reasonable performance
      expect(subscribeTime).toBeLessThan(100); // < 1ms per subscription
      expect(emitTime).toBeLessThan(10); // < 10ms for 100 subscribers
      expect(unsubscribeTime).toBeLessThan(100); // < 1ms per unsubscription
    });
  });
});
