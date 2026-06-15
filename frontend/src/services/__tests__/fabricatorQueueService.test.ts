/**
 * FabricatorQueueService Tests
 * Tests for the migrated fabricatorQueueService using event bus architecture
 */

import { subscribeToFabricationEvents, FabricationEvent } from '../fabricatorQueueService';
import { eventBus } from '../eventBus';
import { subscriptionManager } from '../subscriptionManager';
import { EVENT_TYPES } from '../eventTypes';

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
      const unsubscribe = subscribeToFabricationEvents(callback);
      
      expect(typeof unsubscribe).toBe('function');
      
      unsubscribe();
    });

    it('should register callback with event bus', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback);
      
      // Check that subscriber was added
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(1);
      
      unsubscribe();
    });

    it('should receive events through event bus', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback);
      
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
      const unsubscribe = subscribeToFabricationEvents(callback);
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(1);
      
      unsubscribe();
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
    });

    it('should support multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();
      
      const unsubscribe1 = subscribeToFabricationEvents(callback1);
      const unsubscribe2 = subscribeToFabricationEvents(callback2);
      const unsubscribe3 = subscribeToFabricationEvents(callback3);
      
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
      
      const unsubscribe = subscribeToFabricationEvents(callback);
      
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
        const unsubscribe = subscribeToFabricationEvents(callback);
        expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(1);
        unsubscribe();
        expect(eventBus.getSubscriberCount(EVENT_TYPES.FABRICATION)).toBe(0);
      }
    });

    it('should not receive events after unsubscribe', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToFabricationEvents(callback);
      
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
      const unsubscribe = subscribeToFabricationEvents(callback);
      
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
      const unsubscribe = subscribeToFabricationEvents(callback);
      
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
      const unsubscribe = subscribeToFabricationEvents(callback);
      
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
  });
});
