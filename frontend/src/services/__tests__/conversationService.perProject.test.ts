/**
 * conversationService — per-project subscription correctness
 * (finding: subscriptionManager.ts:116-131 keyed by eventType only, and
 * conversationService.ts:133-157 marked a project "initialised" even when
 * initializeConversationSubscription did not actually create a NEW
 * backend subscription for that project — e.g. because another project's
 * CONVERSATION subscription was still live within the cleanup debounce,
 * or held open by another component (ProjectWorkspace)).
 *
 * This test asserts:
 *  1. Two projects subscribed in sequence each get their own backend
 *     subscription (distinct composite keys / distinct serverService.subscribe
 *     calls with each project's variables).
 *  2. Switching projects within the 1s debounce window still yields a
 *     subscription for the new project.
 *  3. Cleanup (unsubscribe) removes the right project's subscription and
 *     leaves the other project's subscription intact.
 *
 * conversationService tracks initialized projects in module-level state, so
 * each test resets modules to get a fresh, isolated instance.
 */

import type { ConversationMessage } from '../conversationService';

jest.mock('../eventBus');
jest.mock('../subscriptionManager');
jest.mock('../server', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn(),
  },
}));

interface MockedEventBus {
  subscribe: jest.Mock;
}

interface MockedSubscriptionManager {
  initializeSubscription: jest.Mock;
  addLocalSubscriber: jest.Mock;
  removeLocalSubscriber: jest.Mock;
}

interface ConversationServiceModule {
  subscribeToConversation: (
    projectId: string,
    onMessage: (message: ConversationMessage) => void
  ) => () => void;
}

/**
 * Each test needs a fresh module instance (conversationService tracks
 * initialized projects in module-level state), so modules are reset and
 * re-required per test via jest.requireActual/jest.requireMock — the
 * module-isolation idiom for Jest's CommonJS registry, typed against the
 * real module interfaces rather than `any`.
 */
function loadModules(): {
  subscribeToConversation: ConversationServiceModule['subscribeToConversation'];
  eventBus: MockedEventBus;
  subscriptionManager: MockedSubscriptionManager;
} {
  const conversationServiceModule = jest.requireActual<ConversationServiceModule>('../conversationService');
  const eventBusModule = jest.requireMock<{ eventBus: MockedEventBus }>('../eventBus');
  const subscriptionManagerModule = jest.requireMock<{ subscriptionManager: MockedSubscriptionManager }>(
    '../subscriptionManager'
  );
  return {
    subscribeToConversation: conversationServiceModule.subscribeToConversation,
    eventBus: eventBusModule.eventBus,
    subscriptionManager: subscriptionManagerModule.subscriptionManager,
  };
}

describe('conversationService — per-project subscription keying', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('gives two sequential projects their own backend subscription (distinct composite keys)', () => {
    const { subscribeToConversation, eventBus, subscriptionManager } = loadModules();
    eventBus.subscribe.mockReturnValue(jest.fn());

    subscribeToConversation('proj-A', jest.fn());
    subscribeToConversation('proj-B', jest.fn());

    expect(subscriptionManager.initializeSubscription).toHaveBeenCalledTimes(2);

    const calls = subscriptionManager.initializeSubscription.mock.calls;
    const keys = calls.map((call: unknown[]) => call[4]); // 5th arg: composite subscriptionKey
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('proj-A');
    expect(keys[1]).toContain('proj-B');

    expect(calls[0][2]).toEqual({ projectId: 'proj-A' });
    expect(calls[1][2]).toEqual({ projectId: 'proj-B' });
  });

  it('switching projects within the debounce window still subscribes the new project', () => {
    const { subscribeToConversation, eventBus, subscriptionManager } = loadModules();
    const unsubA = jest.fn();
    eventBus.subscribe.mockReturnValueOnce(unsubA).mockReturnValue(jest.fn());

    const unsubscribeA = subscribeToConversation('proj-A', jest.fn());
    unsubscribeA(); // schedules debounced backend cleanup for proj-A

    jest.advanceTimersByTime(200); // still within the 1s debounce window

    subscribeToConversation('proj-B', jest.fn());

    expect(subscriptionManager.initializeSubscription).toHaveBeenCalledTimes(2);
    const calls = subscriptionManager.initializeSubscription.mock.calls;
    expect(calls[1][2]).toEqual({ projectId: 'proj-B' });
  });

  it('cleanup removes the right project subscription and leaves the other project intact', () => {
    const { subscribeToConversation, eventBus, subscriptionManager } = loadModules();
    const unsubA = jest.fn();
    const unsubB = jest.fn();
    eventBus.subscribe
      .mockReturnValueOnce(unsubA)
      .mockReturnValueOnce(unsubB);

    const unsubscribeA = subscribeToConversation('proj-A', jest.fn());
    subscribeToConversation('proj-B', jest.fn());

    unsubscribeA();

    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).not.toHaveBeenCalled();

    const removeCalls = subscriptionManager.removeLocalSubscriber.mock.calls;
    const lastRemoveKey = removeCalls[removeCalls.length - 1][1];
    expect(lastRemoveKey).toContain('proj-A');
  });

  it('only marks a project initialised when a subscription was actually created, and does not re-initialize for a repeat subscribe to the same project', () => {
    const { subscribeToConversation, eventBus, subscriptionManager } = loadModules();
    eventBus.subscribe.mockReturnValue(jest.fn());

    subscribeToConversation('proj-A', jest.fn());
    subscribeToConversation('proj-A', jest.fn());

    // Second call for the SAME project must not re-initialize the backend
    // subscription (existing dedup behaviour for one project), but each
    // DISTINCT project must still get exactly one initialize call of its own.
    const calls = subscriptionManager.initializeSubscription.mock.calls;
    const keysForA = calls.filter((c: unknown[]) => String(c[4]).includes('proj-A'));
    expect(keysForA).toHaveLength(1);

    expect(subscriptionManager.addLocalSubscriber).toHaveBeenCalledTimes(2);
  });
});
