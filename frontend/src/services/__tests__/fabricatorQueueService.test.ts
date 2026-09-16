/**
 * FabricatorQueueService Tests
 * Tests for the migrated fabricatorQueueService using event bus architecture
 */

import { subscribeToFabricationEvents, FabricationEvent } from '../fabricatorQueueService';
import { eventBus } from '../eventBus';
import { subscriptionManager } from '../subscriptionManager';
import { EVENT_TYPES } from '../eventTypes';

// The backend authorizes onFabricationEvent(orgId) against the caller's own
// custom:organization claim; tests supply a stable stand-in org id.
const TEST_ORG_ID = 'org-test-1';

describe('FabricatorQueueService', () => {
  beforeEach(() => {
    // Clear event bus before each test
    eventBus.clear();
    // Clear subscription manager
    subscriptionManager.clearAll();
  });

  afterEach(() => {
    // Clean up after each test
    eventBus.clear();
    subscriptionManager.clearAll();
  });

  describe('subscribeToFabricationEvents', () => {
    it('should return an unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      expect(typeof unsubscribe).toBe('function');
      
      unsubscribe();
    });

    it('should register callback with event bus', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      // Check that subscriber was added
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(1);
      
      unsubscribe();
    });

    it('should receive events through event bus', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      const testEvent: FabricationEvent = {
        type: 'COMPLETED',
        requestId: 'test-request-1',
        agentId: 'test-agent-1',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      // Emit event through event bus
      eventBus.emit(EVENT_TYPES.FABRICATION, testEvent);
      
      // Verify callback was called with event
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(testEvent);
      
      unsubscribe();
    });

    it('should unsubscribe from event bus when unsubscribe is called', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(1);
      
      unsubscribe();
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
    });

    it('should support multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();
      
      const unsubscribe1 = subscribeToFabricationEvents(callback1, TEST_ORG_ID);
      const unsubscribe2 = subscribeToFabricationEvents(callback2, TEST_ORG_ID);
      const unsubscribe3 = subscribeToFabricationEvents(callback3, TEST_ORG_ID);
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(3);
      
      const testEvent: FabricationEvent = {
        type: 'FAILED',
        requestId: 'test-request-1',
        errorMessage: 'Test error',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      eventBus.emit(EVENT_TYPES.FABRICATION, testEvent);
      
      expect(callback1).toHaveBeenCalledWith(testEvent);
      expect(callback2).toHaveBeenCalledWith(testEvent);
      expect(callback3).toHaveBeenCalledWith(testEvent);
      
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
    });

    it('should maintain backward compatibility with existing API', () => {
      // Test that the API signature hasn't changed
      const callback = (event: FabricationEvent) => {
        expect(event).toHaveProperty('type');
        expect(event).toHaveProperty('requestId');
        expect(event).toHaveProperty('timestamp');
      };
      
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      const testEvent: FabricationEvent = {
        type: 'COMPLETED',
        requestId: 'test-request-1',
        agentId: 'test-agent-1',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      eventBus.emit(EVENT_TYPES.FABRICATION, testEvent);
      
      unsubscribe();
    });

    it('should handle rapid subscribe/unsubscribe cycles', () => {
      const callback = jest.fn();
      
      // Subscribe and unsubscribe multiple times
      for (let i = 0; i < 5; i++) {
        const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
        expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(1);
        unsubscribe();
        expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
      }
    });

    it('should not receive events after unsubscribe', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      const testEvent: FabricationEvent = {
        type: 'COMPLETED',
        requestId: 'test-request-1',
        agentId: 'test-agent-1',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      // Emit before unsubscribe
      eventBus.emit(EVENT_TYPES.FABRICATION, testEvent);
      expect(callback).toHaveBeenCalledTimes(1);
      
      // Unsubscribe
      unsubscribe();
      
      // Emit after unsubscribe
      eventBus.emit(EVENT_TYPES.FABRICATION, testEvent);
      
      // Should still be called only once (from before unsubscribe)
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle COMPLETED events correctly', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      const completedEvent: FabricationEvent = {
        type: 'COMPLETED',
        requestId: 'test-request-1',
        agentId: 'test-agent-1',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      eventBus.emit(EVENT_TYPES.FABRICATION, completedEvent);
      
      expect(callback).toHaveBeenCalledWith(completedEvent);
      expect(callback.mock.calls[0][0].type).toBe('COMPLETED');
      
      unsubscribe();
    });

    it('should handle FAILED events correctly', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      const failedEvent: FabricationEvent = {
        type: 'FAILED',
        requestId: 'test-request-1',
        errorMessage: 'Fabrication failed due to invalid configuration',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      eventBus.emit(EVENT_TYPES.FABRICATION, failedEvent);
      
      expect(callback).toHaveBeenCalledWith(failedEvent);
      expect(callback.mock.calls[0][0].type).toBe('FAILED');
      expect(callback.mock.calls[0][0].errorMessage).toBe('Fabrication failed due to invalid configuration');
      
      unsubscribe();
    });

    it('should handle events with optional fields', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);
      
      // Event without optional agentId
      const eventWithoutAgentId: FabricationEvent = {
        type: 'COMPLETED',
        requestId: 'test-request-1',
        timestamp: '2024-01-01T00:00:00Z',
      };
      
      eventBus.emit(EVENT_TYPES.FABRICATION, eventWithoutAgentId);
      
      expect(callback).toHaveBeenCalledWith(eventWithoutAgentId);
      expect(callback.mock.calls[0][0].agentId).toBeUndefined();
      
      unsubscribe();
    });

    it('subscribes with the caller org and creates a backend subscription scoped to it', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, TEST_ORG_ID);

      const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
      expect(activeSubscriptions).toHaveLength(1);
      expect(activeSubscriptions[0].eventType).toBe(EVENT_TYPES.FABRICATION);

      unsubscribe();
    });

    it('does not subscribe when orgId is missing (null)', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback, null);

      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
      expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);

      // Returned unsubscribe is a safe no-op.
      expect(() => unsubscribe()).not.toThrow();
    });

    it('does not subscribe when orgId is missing (undefined)', () => {
      const callback = jest.fn();
      subscribeToFabricationEvents(callback);

      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
      expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
    });

    it('does not subscribe when orgId is an empty string', () => {
      const callback = jest.fn();
      subscribeToFabricationEvents(callback, '');

      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
      expect(subscriptionManager.getActiveSubscriptions()).toHaveLength(0);
    });
  });
});
