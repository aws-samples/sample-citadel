/**
 * EventBus Unit Tests
 * 
 * Basic unit tests to verify EventBus functionality
 */

import { EventBus, eventBus, EventType } from '../eventBus';

describe('EventBus', () => {
  let testBus: EventBus;

  beforeEach(() => {
    // Create a fresh instance for each test
    testBus = new EventBus();
  });

  describe('subscribe', () => {
    it('should register a callback and return an unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = testBus.subscribe('chatter', callback);

      expect(typeof unsubscribe).toBe('function');
      expect(testBus.getSubscriberCount('chatter')).toBe(1);
    });

    it('should allow multiple subscribers to the same event type', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      testBus.subscribe('chatter', callback1);
      testBus.subscribe('chatter', callback2);
      testBus.subscribe('chatter', callback3);

      expect(testBus.getSubscriberCount('chatter')).toBe(3);
    });
  });

  describe('emit', () => {
    it('should invoke all registered callbacks with the event data', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const testData = { message: 'test' };

      testBus.subscribe('chatter', callback1);
      testBus.subscribe('chatter', callback2);

      testBus.emit('chatter', testData);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledWith(testData);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledWith(testData);
    });

    it('should not throw if no subscribers exist', () => {
      expect(() => {
        testBus.emit('chatter', { message: 'test' });
      }).not.toThrow();
    });

    it('should continue invoking callbacks even if one throws an error', () => {
      const callback1 = jest.fn(() => {
        throw new Error('Callback error');
      });
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      testBus.subscribe('chatter', callback1);
      testBus.subscribe('chatter', callback2);
      testBus.subscribe('chatter', callback3);

      // Suppress console.error for this test
      const consoleError = jest.spyOn(console, 'error').mockImplementation();

      testBus.emit('chatter', { message: 'test' });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });
  });

  describe('unsubscribe', () => {
    it('should remove a specific callback when unsubscribe function is called', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const unsubscribe1 = testBus.subscribe('chatter', callback1);
      testBus.subscribe('chatter', callback2);

      expect(testBus.getSubscriberCount('chatter')).toBe(2);

      unsubscribe1();

      expect(testBus.getSubscriberCount('chatter')).toBe(1);

      testBus.emit('chatter', { message: 'test' });

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should clean up empty subscriber sets', () => {
      const callback = jest.fn();
      const unsubscribe = testBus.subscribe('chatter', callback);

      expect(testBus.getActiveEventTypes()).toContain('chatter');

      unsubscribe();

      expect(testBus.getActiveEventTypes()).not.toContain('chatter');
      expect(testBus.getSubscriberCount('chatter')).toBe(0);
    });
  });

  describe('getSubscriberCount', () => {
    it('should return 0 for event types with no subscribers', () => {
      expect(testBus.getSubscriberCount('chatter')).toBe(0);
    });

    it('should return the correct count of subscribers', () => {
      testBus.subscribe('chatter', jest.fn());
      testBus.subscribe('chatter', jest.fn());
      testBus.subscribe('fabrication', jest.fn());

      expect(testBus.getSubscriberCount('chatter')).toBe(2);
      expect(testBus.getSubscriberCount('fabrication')).toBe(1);
    });
  });

  describe('getActiveEventTypes', () => {
    it('should return an empty array when no subscribers exist', () => {
      expect(testBus.getActiveEventTypes()).toEqual([]);
    });

    it('should return all event types with active subscribers', () => {
      testBus.subscribe('chatter', jest.fn());
      testBus.subscribe('fabrication', jest.fn());
      testBus.subscribe('conversation', jest.fn());

      const activeTypes = testBus.getActiveEventTypes();

      expect(activeTypes).toHaveLength(3);
      expect(activeTypes).toContain('chatter');
      expect(activeTypes).toContain('fabrication');
      expect(activeTypes).toContain('conversation');
    });

    it('should not include event types after all subscribers unsubscribe', () => {
      const unsubscribe1 = testBus.subscribe('chatter', jest.fn());
      const unsubscribe2 = testBus.subscribe('chatter', jest.fn());

      expect(testBus.getActiveEventTypes()).toContain('chatter');

      unsubscribe1();
      expect(testBus.getActiveEventTypes()).toContain('chatter');

      unsubscribe2();
      expect(testBus.getActiveEventTypes()).not.toContain('chatter');
    });
  });

  describe('clear', () => {
    it('should remove all subscribers from all event types', () => {
      testBus.subscribe('chatter', jest.fn());
      testBus.subscribe('fabrication', jest.fn());
      testBus.subscribe('conversation', jest.fn());

      expect(testBus.getActiveEventTypes().length).toBeGreaterThan(0);

      testBus.clear();

      expect(testBus.getActiveEventTypes()).toEqual([]);
      expect(testBus.getSubscriberCount('chatter')).toBe(0);
      expect(testBus.getSubscriberCount('fabrication')).toBe(0);
      expect(testBus.getSubscriberCount('conversation')).toBe(0);
    });
  });

  describe('singleton instance', () => {
    it('should export a singleton instance', () => {
      expect(eventBus).toBeInstanceOf(EventBus);
    });
  });
});
