/**
 * Tests for subscription debug tools
 * 
 * Validates Requirements 7.3, 7.4:
 * - Debug tools provide visibility into subscription state
 * - Verbose logging can be enabled/disabled
 * - Console commands work correctly
 */

import { 
  subscriptionDebug, 
  initializeSubscriptionDebug,
  logSubscriptionEvent,
  isVerboseLoggingEnabled
} from '../subscriptionDebug';
import { eventBus } from '../eventBus';
import { subscriptionManager } from '../subscriptionManager';

describe('SubscriptionDebug', () => {
  beforeEach(() => {
    // Use fake timers so leaked setTimeout calls in the real subscriptionManager
    // module (e.g. cleanup debounce) don't keep the event loop alive.
    jest.useFakeTimers();

    // Clear all subscriptions before each test
    eventBus.clear();
    subscriptionManager.clearAll();
    
    // Disable verbose logging
    if (isVerboseLoggingEnabled()) {
      subscriptionDebug.disableVerboseLogging();
    }
  });

  afterEach(() => {
    // Clean up after each test
    eventBus.clear();
    subscriptionManager.clearAll();

    // Re-enable fake timers in case a test switched to real timers, then
    // flush any pending timers and restore real timers.
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('getActiveSubscriptions', () => {
    it('should return empty array when no subscriptions are active', () => {
      const result = subscriptionDebug.getActiveSubscriptions();
      expect(result).toEqual([]);
    });

    it('should return active backend subscriptions', () => {
      // Initialize a subscription
      subscriptionManager.initializeSubscription(
        'chatter',
        'subscription { onChatter { id } }',
        {},
        (data) => data
      );
      
      // Add a local subscriber
      subscriptionManager.addLocalSubscriber('chatter');

      const result = subscriptionDebug.getActiveSubscriptions();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        eventType: 'chatter',
        subscriberCount: 1,
      });
    });
  });

  describe('getSubscriberCounts', () => {
    it('should return empty array when no local subscribers exist', () => {
      const result = subscriptionDebug.getSubscriberCounts();
      expect(result).toEqual([]);
    });

    it('should return subscriber counts for all event types', () => {
      // Add local subscribers
      const unsubscribe1 = eventBus.subscribe('chatter', () => {});
      const unsubscribe2 = eventBus.subscribe('chatter', () => {});
      const unsubscribe3 = eventBus.subscribe('fabrication', () => {});

      const result = subscriptionDebug.getSubscriberCounts();
      expect(result).toHaveLength(2);
      
      const chatterCount = result.find(r => r.eventType === 'chatter');
      const fabricationCount = result.find(r => r.eventType === 'fabrication');
      
      expect(chatterCount?.count).toBe(2);
      expect(fabricationCount?.count).toBe(1);

      // Clean up
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
    });
  });

  describe('getSubscriptionState', () => {
    it('should return comprehensive subscription state', () => {
      // Initialize backend subscription
      subscriptionManager.initializeSubscription(
        'chatter',
        'subscription { onChatter { id } }',
        {},
        (data) => data
      );
      subscriptionManager.addLocalSubscriber('chatter');
      subscriptionManager.addLocalSubscriber('chatter');

      // Add local-only subscription (shouldn't happen in normal operation)
      const unsubscribe = eventBus.subscribe('fabrication', () => {});

      const result = subscriptionDebug.getSubscriptionState();
      
      expect(result.activeBackendConnections).toBe(1);
      expect(result.totalLocalSubscribers).toBe(3); // 2 for chatter + 1 for fabrication
      expect(result.eventTypes).toHaveLength(2);

      const chatterState = result.eventTypes.find(e => e.eventType === 'chatter');
      const fabricationState = result.eventTypes.find(e => e.eventType === 'fabrication');

      expect(chatterState).toEqual({
        eventType: 'chatter',
        backendActive: true,
        localSubscribers: 2,
      });

      expect(fabricationState).toEqual({
        eventType: 'fabrication',
        backendActive: false,
        localSubscribers: 1,
      });

      // Clean up
      unsubscribe();
    });

    it('should return zero state when no subscriptions exist', () => {
      const result = subscriptionDebug.getSubscriptionState();
      
      expect(result.activeBackendConnections).toBe(0);
      expect(result.totalLocalSubscribers).toBe(0);
      expect(result.eventTypes).toEqual([]);
    });
  });

  describe('verbose logging', () => {
    it('should start with verbose logging disabled', () => {
      expect(subscriptionDebug.isVerboseLoggingEnabled()).toBe(false);
    });

    it('should enable verbose logging', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      subscriptionDebug.enableVerboseLogging();
      
      expect(subscriptionDebug.isVerboseLoggingEnabled()).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith('[SubscriptionDebug] Verbose logging enabled');
      
      consoleSpy.mockRestore();
    });

    it('should disable verbose logging', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      subscriptionDebug.enableVerboseLogging();
      subscriptionDebug.disableVerboseLogging();
      
      expect(subscriptionDebug.isVerboseLoggingEnabled()).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('[SubscriptionDebug] Verbose logging disabled');
      
      consoleSpy.mockRestore();
    });

    it('should log subscription events when verbose logging is enabled', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      subscriptionDebug.enableVerboseLogging();
      logSubscriptionEvent('Test event', { data: 'test' });
      
      expect(consoleSpy).toHaveBeenCalledWith(
        '[SubscriptionLifecycle] Test event',
        { data: 'test' }
      );
      
      consoleSpy.mockRestore();
    });

    it('should not log subscription events when verbose logging is disabled', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      subscriptionDebug.disableVerboseLogging();
      logSubscriptionEvent('Test event', { data: 'test' });
      
      // Should only have the disable message, not the event log
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith('[SubscriptionDebug] Verbose logging disabled');
      
      consoleSpy.mockRestore();
    });
  });

  describe('initializeSubscriptionDebug', () => {
    it('should expose __subscriptionDebug to window in development mode', () => {
      // Save original NODE_ENV
      const originalEnv = process.env.NODE_ENV;
      
      // Set to development
      process.env.NODE_ENV = 'development';
      
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      // Initialize
      initializeSubscriptionDebug();
      
      // Check that window has the debug object
      expect((window as any).__subscriptionDebug).toBeDefined();
      expect((window as any).__subscriptionDebug.getActiveSubscriptions).toBeDefined();
      expect((window as any).__subscriptionDebug.getSubscriberCounts).toBeDefined();
      expect((window as any).__subscriptionDebug.getSubscriptionState).toBeDefined();
      expect((window as any).__subscriptionDebug.enableVerboseLogging).toBeDefined();
      expect((window as any).__subscriptionDebug.disableVerboseLogging).toBeDefined();
      
      // Check that initialization message was logged
      expect(consoleSpy).toHaveBeenCalled();
      
      // Restore
      process.env.NODE_ENV = originalEnv;
      consoleSpy.mockRestore();
    });
  });

  describe('integration with EventBus', () => {
    it('should log subscription lifecycle events when verbose logging is enabled', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      
      subscriptionDebug.enableVerboseLogging();
      
      // Subscribe
      const unsubscribe = eventBus.subscribe('chatter', () => {});
      
      // Check that subscription was logged
      expect(consoleSpy).toHaveBeenCalledWith(
        '[SubscriptionLifecycle] Local subscription added for chatter',
        { subscriberCount: 1 }
      );
      
      // Emit event
      eventBus.emit('chatter', { test: 'data' });
      
      // Check that emission was logged
      expect(consoleSpy).toHaveBeenCalledWith(
        '[SubscriptionLifecycle] Event emitted for chatter',
        { subscriberCount: 1 }
      );
      
      // Unsubscribe
      unsubscribe();
      
      // Check that unsubscription was logged
      expect(consoleSpy).toHaveBeenCalledWith(
        '[SubscriptionLifecycle] Local subscription removed for chatter',
        { subscriberCount: 0 }
      );
      
      consoleSpy.mockRestore();
    });
  });
});
