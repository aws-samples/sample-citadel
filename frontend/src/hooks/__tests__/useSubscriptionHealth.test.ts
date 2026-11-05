/**
 * Tests for useSubscriptionHealth hook — reconnect with capped backoff.
 */
import { renderHook, act } from '@testing-library/react';
import { useSubscriptionHealth } from '../../hooks/useSubscriptionHealth';
import { eventBus } from '../../services/eventBus';
import { EVENT_TYPES } from '../../services/eventTypes';

// Mock dependencies
jest.mock('../../services/subscriptionManager');
jest.mock('../../services/conversationService', () => ({
  getConversationHistoryForProject: jest.fn(),
}));

import { getConversationHistoryForProject } from '../../services/conversationService';
const mockGetHistory = getConversationHistoryForProject as jest.MockedFunction<typeof getConversationHistoryForProject>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  eventBus.clear();
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('useSubscriptionHealth', () => {
  const projectId = 'proj-1';
  const onNewMessages = jest.fn();

  it('starts in connected state', () => {
    const { result } = renderHook(() =>
      useSubscriptionHealth(projectId, null, onNewMessages),
    );
    expect(result.current.connectionStatus).toBe('connected');
  });

  it('shows reconnecting on SUBSCRIPTION_ERROR event', () => {
    const { result } = renderHook(() =>
      useSubscriptionHealth(projectId, null, onNewMessages),
    );

    act(() => {
      eventBus.emit(EVENT_TYPES.SUBSCRIPTION_ERROR, {
        eventType: EVENT_TYPES.CONVERSATION,
        error: new Error('ws closed'),
        timestamp: new Date().toISOString(),
        attemptCount: 1,
      });
    });

    expect(result.current.connectionStatus).toBe('reconnecting');
  });

  it('shows disconnected after 5 retries', async () => {
    mockGetHistory.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useSubscriptionHealth(projectId, '2026-01-01T00:00:00Z', onNewMessages),
    );

    // Fire the initial error.
    act(() => {
      eventBus.emit(EVENT_TYPES.SUBSCRIPTION_ERROR, {
        eventType: EVENT_TYPES.CONVERSATION,
        error: new Error('ws closed'),
        timestamp: new Date().toISOString(),
        attemptCount: 5,
      });
    });

    // Each retry: advance past backoff, then flush the async rejection so the
    // recursive attemptReconnect() fires. Backoff steps: 1, 2, 4, 8, 8 s.
    const steps = [1_000, 2_000, 4_000, 8_000, 8_000];
    for (const delay of steps) {
      await act(async () => { jest.advanceTimersByTime(delay + 100); });
    }

    expect(result.current.connectionStatus).toBe('disconnected');
  });

  it('refetches messages on successful reconnect', async () => {
    const newMsg = {
      id: 'msg-new',
      projectId,
      agentId: 'agent1',
      message: 'hello',
      messageType: 'AGENT_RESPONSE' as const,
      timestamp: '2026-01-01T00:01:00Z',
    };
    mockGetHistory.mockResolvedValue({ items: [newMsg], nextToken: null });

    const { result } = renderHook(() =>
      useSubscriptionHealth(projectId, '2026-01-01T00:00:00Z', onNewMessages),
    );

    // Trigger error.
    act(() => {
      eventBus.emit(EVENT_TYPES.SUBSCRIPTION_ERROR, {
        eventType: EVENT_TYPES.CONVERSATION,
        error: new Error('ws closed'),
        timestamp: new Date().toISOString(),
        attemptCount: 1,
      });
    });

    // Advance past first backoff (1 s).
    await act(async () => { jest.advanceTimersByTime(1_500); });

    expect(mockGetHistory).toHaveBeenCalledWith(projectId, 50);
    expect(onNewMessages).toHaveBeenCalledWith([newMsg]);
    expect(result.current.connectionStatus).toBe('connected');
  });

  it('manual reconnect resets retry counter', async () => {
    mockGetHistory.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useSubscriptionHealth(projectId, '2026-01-01T00:00:00Z', onNewMessages),
    );

    // Exhaust auto retries.
    act(() => {
      eventBus.emit(EVENT_TYPES.SUBSCRIPTION_ERROR, {
        eventType: EVENT_TYPES.CONVERSATION,
        error: new Error('ws closed'),
        timestamp: new Date().toISOString(),
        attemptCount: 5,
      });
    });
    const steps = [1_000, 2_000, 4_000, 8_000, 8_000];
    for (const delay of steps) {
      await act(async () => { jest.advanceTimersByTime(delay + 100); });
    }
    expect(result.current.connectionStatus).toBe('disconnected');

    // Manual reconnect.
    act(() => { result.current.manualReconnect(); });
    expect(result.current.connectionStatus).toBe('reconnecting');
  });
});
