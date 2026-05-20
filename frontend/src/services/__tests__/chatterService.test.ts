/**
 * ChatterService Tests
 * Tests for the migrated chatterService using event bus architecture
 */

import { subscribeToChatter, ChatterMessage } from '../chatterService';
import { eventBus } from '../eventBus';
import { subscriptionManager } from '../subscriptionManager';
import { EVENT_TYPES } from '../eventTypes';

describe('ChatterService', () => {
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

  describe('subscribeToChatter', () => {
    it('should return an unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToChatter(callback);
      
      expect(typeof unsubscribe).toBe('function');
      
      unsubscribe();
    });

    it('should register callback with event bus', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToChatter(callback);
      
      // Check that subscriber was added
      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(1);
      
      unsubscribe();
    });

    it('should receive messages through event bus', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToChatter(callback);
      
      const testMessage: ChatterMessage = {
        id: 'test-1',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test-source',
        detailType: 'test-detail',
        detail: { test: 'data' },
      };
      
      // Emit message through event bus
      eventBus.emit(EVENT_TYPES.CHATTER, testMessage);
      
      // Verify callback was called with message
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(testMessage);
      
      unsubscribe();
    });

    it('should unsubscribe from event bus when unsubscribe is called', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToChatter(callback);
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(1);
      
      unsubscribe();
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(0);
    });

    it('should support multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();
      
      const unsubscribe1 = subscribeToChatter(callback1);
      const unsubscribe2 = subscribeToChatter(callback2);
      const unsubscribe3 = subscribeToChatter(callback3);
      
      expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(3);
      
      const testMessage: ChatterMessage = {
        id: 'test-1',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test-source',
        detailType: 'test-detail',
        detail: { test: 'data' },
      };
      
      eventBus.emit(EVENT_TYPES.CHATTER, testMessage);
      
      expect(callback1).toHaveBeenCalledWith(testMessage);
      expect(callback2).toHaveBeenCalledWith(testMessage);
      expect(callback3).toHaveBeenCalledWith(testMessage);
      
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
    });

    it('should maintain backward compatibility with existing API', () => {
      // Test that the API signature hasn't changed
      const callback = (message: ChatterMessage) => {
        expect(message).toHaveProperty('id');
        expect(message).toHaveProperty('timestamp');
        expect(message).toHaveProperty('source');
        expect(message).toHaveProperty('detailType');
        expect(message).toHaveProperty('detail');
      };
      
      const unsubscribe = subscribeToChatter(callback);
      
      const testMessage: ChatterMessage = {
        id: 'test-1',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test-source',
        detailType: 'test-detail',
        detail: { test: 'data' },
      };
      
      eventBus.emit(EVENT_TYPES.CHATTER, testMessage);
      
      unsubscribe();
    });

    it('should handle rapid subscribe/unsubscribe cycles', () => {
      const callback = jest.fn();
      
      // Subscribe and unsubscribe multiple times
      for (let i = 0; i < 5; i++) {
        const unsubscribe = subscribeToChatter(callback);
        expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(1);
        unsubscribe();
        expect(eventBus.getSubscriberCount(EVENT_TYPES.CHATTER)).toBe(0);
      }
    });

    it('should not receive messages after unsubscribe', () => {
      const callback = jest.fn();
      const unsubscribe = subscribeToChatter(callback);
      
      const testMessage: ChatterMessage = {
        id: 'test-1',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test-source',
        detailType: 'test-detail',
        detail: { test: 'data' },
      };
      
      // Emit before unsubscribe
      eventBus.emit(EVENT_TYPES.CHATTER, testMessage);
      expect(callback).toHaveBeenCalledTimes(1);
      
      // Unsubscribe
      unsubscribe();
      
      // Emit after unsubscribe
      eventBus.emit(EVENT_TYPES.CHATTER, testMessage);
      
      // Should still be called only once (from before unsubscribe)
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
