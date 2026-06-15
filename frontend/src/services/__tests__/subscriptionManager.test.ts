/**
 * SubscriptionManager Unit Tests
 * 
 * Basic unit tests to verify SubscriptionManager functionality
 */

import { SubscriptionManager, subscriptionManager } from '../subscriptionManager';
import { eventBus } from '../eventBus';
import serverService from '../server';

// Mock serverService
jest.mock('../server', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn(),
  },
}));

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    // Use fake timers so leaked setTimeout calls in the real subscriptionManager
    // module (e.g. cleanup debounce) don't keep the event loop alive between tests.
    jest.useFakeTimers();

    // Create a fresh instance for each test
    manager = SubscriptionManager.getInstance();
    manager.clearAll();
    eventBus.clear();

    // Setup mock unsubscribe function
    mockUnsubscribe = jest.fn();
    (serverService.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Re-enable fake timers in case a test switched to real timers, then
    // flush any pending timers and restore real timers for cleanliness.
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = SubscriptionManager.getInstance();
      const instance2 = SubscriptionManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should export a singleton instance', () => {
      expect(subscriptionManager).toBeInstanceOf(SubscriptionManager);
    });
  });

  describe('initializeSubscription', () => {
    it('should create a backend subscription', () => {
      const query = 'subscription { onChatter { id } }';
      const variables = {};
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, variables, transformer);

      expect(serverService.subscribe).toHaveBeenCalledTimes(1);
      expect(serverService.subscribe).toHaveBeenCalledWith(
        query,
        variables,
        expect.any(Function)
      );
    });

    it('should not create duplicate subscriptions for the same event type', () => {
      const query = 'subscription { onChatter { id } }';
      const variables = {};
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, variables, transformer);
      manager.initializeSubscription('chatter', query, variables, transformer);

      expect(serverService.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should emit transformed data to event bus', () => {
      const query = 'subscription { onChatter { id } }';
      const variables = {};
      const testData = { onChatter: { id: '123', message: 'test' } };
      const transformer = (data: any) => data?.onChatter;

      // Capture the callback passed to serverService.subscribe
      let subscriptionCallback: ((data: any) => void) | null = null;
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, callback: (data: any) => void) => {
          subscriptionCallback = callback;
          return mockUnsubscribe;
        }
      );

      // Initialize subscription
      manager.initializeSubscription('chatter', query, variables, transformer);

      // Subscribe to event bus
      const eventCallback = jest.fn();
      eventBus.subscribe('chatter', eventCallback);

      // Simulate backend data
      if (subscriptionCallback) {
        (subscriptionCallback as (data: any) => void)(testData);
      }

      // Verify event was emitted with transformed data
      expect(eventCallback).toHaveBeenCalledTimes(1);
      expect(eventCallback).toHaveBeenCalledWith({ id: '123', message: 'test' });
    });

    it('should handle errors in transformer gracefully', () => {
      const query = 'subscription { onChatter { id } }';
      const variables = {};
      const transformer = () => {
        throw new Error('Transform error');
      };

      // Capture the callback
      let subscriptionCallback: ((data: any) => void) | null = null;
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, callback: (data: any) => void) => {
          subscriptionCallback = callback;
          return mockUnsubscribe;
        }
      );

      // Suppress console.error for this test
      const consoleError = jest.spyOn(console, 'error').mockImplementation();

      manager.initializeSubscription('chatter', query, variables, transformer);

      // Simulate backend data
      if (subscriptionCallback) {
        expect(() => (subscriptionCallback as (data: any) => void)({ data: 'test' })).not.toThrow();
      }

      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('addLocalSubscriber', () => {
    it('should increment subscriber count', () => {
      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');

      const subscriptions = manager.getActiveSubscriptions();
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].subscriberCount).toBe(1);
    });

    it('should cancel pending cleanup when adding subscriber', () => {
      jest.useFakeTimers();

      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');
      manager.removeLocalSubscriber('chatter');

      // Cleanup should be scheduled
      expect(manager.getActiveSubscriptions()).toHaveLength(1);

      // Add subscriber before cleanup executes
      manager.addLocalSubscriber('chatter');

      // Fast-forward time
      jest.advanceTimersByTime(1500);

      // Subscription should still be active
      expect(manager.getActiveSubscriptions()).toHaveLength(1);
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('removeLocalSubscriber', () => {
    it('should decrement subscriber count', () => {
      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');
      manager.addLocalSubscriber('chatter');

      expect(manager.getActiveSubscriptions()[0].subscriberCount).toBe(2);

      manager.removeLocalSubscriber('chatter');

      expect(manager.getActiveSubscriptions()[0].subscriberCount).toBe(1);
    });

    it('should schedule cleanup when subscriber count reaches zero', () => {
      jest.useFakeTimers();

      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');
      manager.removeLocalSubscriber('chatter');

      // Should still be active (cleanup is debounced)
      expect(manager.getActiveSubscriptions()).toHaveLength(1);

      // Fast-forward past debounce period
      jest.advanceTimersByTime(1500);

      // Should be cleaned up now
      expect(manager.getActiveSubscriptions()).toHaveLength(0);
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it('should not go below zero subscriber count', () => {
      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data?.onChatter;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');

      manager.removeLocalSubscriber('chatter');
      manager.removeLocalSubscriber('chatter');
      manager.removeLocalSubscriber('chatter');

      // Should not throw and count should be 0
      const subscriptions = manager.getActiveSubscriptions();
      expect(subscriptions[0]?.subscriberCount || 0).toBe(0);
    });
  });

  describe('getActiveSubscriptions', () => {
    it('should return empty array when no subscriptions exist', () => {
      expect(manager.getActiveSubscriptions()).toEqual([]);
    });

    it('should return all active subscriptions', () => {
      const query1 = 'subscription { onChatter { id } }';
      const query2 = 'subscription { onFabrication { id } }';
      const transformer = (data: any) => data;

      manager.initializeSubscription('chatter', query1, {}, transformer);
      manager.initializeSubscription('fabrication', query2, {}, transformer);

      const subscriptions = manager.getActiveSubscriptions();

      expect(subscriptions).toHaveLength(2);
      expect(subscriptions.map(s => s.eventType)).toContain('chatter');
      expect(subscriptions.map(s => s.eventType)).toContain('fabrication');
    });

    it('should not include cleaned up subscriptions', () => {
      jest.useFakeTimers();

      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');

      expect(manager.getActiveSubscriptions()).toHaveLength(1);

      manager.removeLocalSubscriber('chatter');
      jest.advanceTimersByTime(1500);

      expect(manager.getActiveSubscriptions()).toHaveLength(0);

      jest.useRealTimers();
    });
  });

  describe('cleanupSubscription', () => {
    it('should immediately cleanup a subscription', () => {
      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');

      expect(manager.getActiveSubscriptions()).toHaveLength(1);

      manager.cleanupSubscription('chatter');

      expect(manager.getActiveSubscriptions()).toHaveLength(0);
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('should cancel pending cleanup timer', () => {
      jest.useFakeTimers();

      const query = 'subscription { onChatter { id } }';
      const transformer = (data: any) => data;

      manager.initializeSubscription('chatter', query, {}, transformer);
      manager.addLocalSubscriber('chatter');
      manager.removeLocalSubscriber('chatter');

      // Force cleanup before timer fires
      manager.cleanupSubscription('chatter');

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

      // Advance timers - should not call unsubscribe again
      jest.advanceTimersByTime(1500);

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });

  describe('clearAll', () => {
    it('should cleanup all subscriptions', () => {
      const query1 = 'subscription { onChatter { id } }';
      const query2 = 'subscription { onFabrication { id } }';
      const transformer = (data: any) => data;

      manager.initializeSubscription('chatter', query1, {}, transformer);
      manager.initializeSubscription('fabrication', query2, {}, transformer);

      expect(manager.getActiveSubscriptions()).toHaveLength(2);

      manager.clearAll();

      expect(manager.getActiveSubscriptions()).toHaveLength(0);
      expect(mockUnsubscribe).toHaveBeenCalledTimes(2);
    });
  });
});
