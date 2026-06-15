/**
 * Tests for conversationService migration to event bus
 */

import { subscribeToConversation, ConversationMessage } from '../conversationService';
import { eventBus } from '../eventBus';
import { subscriptionManager } from '../subscriptionManager';
import { EVENT_TYPES } from '../eventTypes';

// Mock the dependencies
jest.mock('../eventBus');
jest.mock('../subscriptionManager');
jest.mock('../server', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn(),
  },
}));

describe('conversationService', () => {
  beforeEach(() => {
    // Fake timers swallow any leaked setTimeout calls (e.g. from un-mocked
    // dependencies) so they don't keep the event loop alive between tests.
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Re-enable fake timers in case a test switched to real timers, flush
    // pending fake timers, then restore real timers.
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('subscribeToConversation', () => {
    it('should initialize backend subscription on first call', () => {
      const projectId = 'test-project-123';
      const mockCallback = jest.fn();
      const mockUnsubscribe = jest.fn();

      // Mock eventBus.subscribe to return unsubscribe function
      (eventBus.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);

      // Subscribe
      const unsubscribe = subscribeToConversation(projectId, mockCallback);

      // Verify subscriptionManager.initializeSubscription was called
      expect(subscriptionManager.initializeSubscription).toHaveBeenCalledWith(
        EVENT_TYPES.CONVERSATION,
        expect.stringContaining('subscription OnConversationMessage'),
        { projectId },
        expect.any(Function)
      );

      // Verify addLocalSubscriber was called
      expect(subscriptionManager.addLocalSubscriber).toHaveBeenCalledWith(
        EVENT_TYPES.CONVERSATION
      );

      // Verify eventBus.subscribe was called
      expect(eventBus.subscribe).toHaveBeenCalledWith(
        EVENT_TYPES.CONVERSATION,
        expect.any(Function)
      );

      // Cleanup
      unsubscribe();
    });

    it('should add local subscriber reference count', () => {
      const projectId = 'test-project-123';
      const mockCallback = jest.fn();
      const mockUnsubscribe = jest.fn();

      (eventBus.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);

      subscribeToConversation(projectId, mockCallback);

      expect(subscriptionManager.addLocalSubscriber).toHaveBeenCalledWith(
        EVENT_TYPES.CONVERSATION
      );
    });

    it('should remove local subscriber on unsubscribe', () => {
      const projectId = 'test-project-123';
      const mockCallback = jest.fn();
      const mockUnsubscribe = jest.fn();

      (eventBus.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);

      const unsubscribe = subscribeToConversation(projectId, mockCallback);
      unsubscribe();

      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(subscriptionManager.removeLocalSubscriber).toHaveBeenCalledWith(
        EVENT_TYPES.CONVERSATION
      );
    });

    it('should filter messages by projectId', () => {
      const projectId = 'test-project-123';
      const mockCallback = jest.fn();
      const mockUnsubscribe = jest.fn();
      let capturedFilterCallback: ((message: ConversationMessage) => void) | null = null;

      // Capture the filtered callback passed to eventBus.subscribe
      (eventBus.subscribe as jest.Mock).mockImplementation((_eventType, callback) => {
        capturedFilterCallback = callback;
        return mockUnsubscribe;
      });

      subscribeToConversation(projectId, mockCallback);

      // Simulate receiving a message for the correct project
      const matchingMessage: ConversationMessage = {
        id: 'msg-1',
        projectId: 'test-project-123',
        agentId: 'agent-1',
        message: 'Hello',
        messageType: 'AGENT_RESPONSE',
        timestamp: new Date().toISOString(),
      };

      capturedFilterCallback!(matchingMessage);
      expect(mockCallback).toHaveBeenCalledWith(matchingMessage);

      // Simulate receiving a message for a different project
      mockCallback.mockClear();
      const nonMatchingMessage: ConversationMessage = {
        id: 'msg-2',
        projectId: 'different-project',
        agentId: 'agent-1',
        message: 'Hello',
        messageType: 'AGENT_RESPONSE',
        timestamp: new Date().toISOString(),
      };

      capturedFilterCallback!(nonMatchingMessage);
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should maintain backward compatibility with previous API', () => {
      const projectId = 'test-project-123';
      const mockCallback = jest.fn();
      const mockUnsubscribe = jest.fn();

      (eventBus.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);

      // The API should accept projectId, callback, and optional error handler
      const unsubscribe = subscribeToConversation(
        projectId,
        mockCallback,
        (error) => console.error(error)
      );

      // Should return an unsubscribe function
      expect(typeof unsubscribe).toBe('function');

      // Calling unsubscribe should work
      expect(() => unsubscribe()).not.toThrow();
    });
  });
});
