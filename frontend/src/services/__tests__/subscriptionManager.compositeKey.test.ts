/**
 * SubscriptionManager — composite subscription keying (per-project).
 *
 * Before the fix, `initializeSubscription`/`addLocalSubscriber`/
 * `removeLocalSubscriber`/`cleanupSubscription` keyed their internal state
 * Map by `eventType` alone. For a per-entity event type like
 * EVENT_TYPES.CONVERSATION (one backend subscription per projectId), two
 * different projects collided on the SAME map entry: initializing project
 * B's subscription while project A's was still live (e.g. within the 1s
 * cleanup debounce) was treated as "already active" and silently reused
 * project A's backend connection and variables, so project B's messages
 * never arrived.
 *
 * The fix adds an optional composite `subscriptionKey` parameter (distinct
 * from `eventType`, which is still used to emit on the local event bus so
 * existing non-keyed consumers are unaffected). When omitted, the key
 * defaults to `eventType` — fully backward compatible with every other
 * caller (chatterService, fabricatorQueueService, projectService).
 */
import { SubscriptionManager } from '../subscriptionManager';
import { eventBus } from '../eventBus';
import serverService from '../server';

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn(),
  },
}));

describe('SubscriptionManager — composite subscription keying', () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = SubscriptionManager.getInstance();
    manager.clearAll();
    eventBus.clear();
    jest.clearAllMocks();
    (serverService.subscribe as jest.Mock).mockImplementation(() => jest.fn());
  });

  afterEach(() => {
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('creates a separate backend subscription per composite key for the same eventType', () => {
    const query = 'subscription OnConversationMessage($projectId: ID!) { onConversationMessage(projectId: $projectId) { id } }';
    const transformer = (data: unknown) => (data as { onConversationMessage?: unknown } | undefined)?.onConversationMessage;

    manager.initializeSubscription('conversation', query, { projectId: 'proj-A' }, transformer, 'conversation:proj-A');
    manager.initializeSubscription('conversation', query, { projectId: 'proj-B' }, transformer, 'conversation:proj-B');

    expect(serverService.subscribe).toHaveBeenCalledTimes(2);
    expect(serverService.subscribe).toHaveBeenNthCalledWith(
      1, query, { projectId: 'proj-A' }, expect.any(Function),
    );
    expect(serverService.subscribe).toHaveBeenNthCalledWith(
      2, query, { projectId: 'proj-B' }, expect.any(Function),
    );
  });

  it('switching projects within the cleanup debounce window still creates a subscription for the new project', () => {
    const query = 'subscription OnConversationMessage($projectId: ID!) { onConversationMessage(projectId: $projectId) { id } }';
    const transformer = (data: unknown) => (data as { onConversationMessage?: unknown } | undefined)?.onConversationMessage;

    // Project A subscribes then unsubscribes (schedules a debounced cleanup).
    manager.initializeSubscription('conversation', query, { projectId: 'proj-A' }, transformer, 'conversation:proj-A');
    manager.addLocalSubscriber('conversation', 'conversation:proj-A');
    manager.removeLocalSubscriber('conversation', 'conversation:proj-A');

    // Within the 1s debounce window, project B initializes — must get its
    // OWN backend subscription, not be treated as a duplicate of A's.
    jest.advanceTimersByTime(200);
    manager.initializeSubscription('conversation', query, { projectId: 'proj-B' }, transformer, 'conversation:proj-B');
    manager.addLocalSubscriber('conversation', 'conversation:proj-B');

    expect(serverService.subscribe).toHaveBeenCalledTimes(2);

    const active = manager.getActiveSubscriptions();
    const keys = active.map((s) => s.eventType);
    expect(keys).toContain('conversation');
    expect(active).toHaveLength(2);
  });

  it('cleanup removes only the targeted composite key, not sibling keys sharing the same eventType', () => {
    const query = 'subscription OnConversationMessage($projectId: ID!) { onConversationMessage(projectId: $projectId) { id } }';
    const transformer = (data: unknown) => (data as { onConversationMessage?: unknown } | undefined)?.onConversationMessage;
    const unsubA = jest.fn();
    const unsubB = jest.fn();
    (serverService.subscribe as jest.Mock)
      .mockImplementationOnce(() => unsubA)
      .mockImplementationOnce(() => unsubB);

    manager.initializeSubscription('conversation', query, { projectId: 'proj-A' }, transformer, 'conversation:proj-A');
    manager.initializeSubscription('conversation', query, { projectId: 'proj-B' }, transformer, 'conversation:proj-B');

    expect(manager.getActiveSubscriptions()).toHaveLength(2);

    manager.cleanupSubscription('conversation', 'conversation:proj-A');

    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).not.toHaveBeenCalled();
    expect(manager.getActiveSubscriptions()).toHaveLength(1);
  });

  it('defaults the composite key to eventType for backward-compatible callers (no key argument)', () => {
    const query = 'subscription { onChatter { id } }';
    const transformer = (data: unknown) => (data as { onChatter?: unknown } | undefined)?.onChatter;

    manager.initializeSubscription('chatter', query, {}, transformer);
    manager.addLocalSubscriber('chatter');

    expect(serverService.subscribe).toHaveBeenCalledTimes(1);
    expect(manager.getActiveSubscriptions()).toHaveLength(1);
    expect(manager.getActiveSubscriptions()[0].subscriberCount).toBe(1);

    manager.removeLocalSubscriber('chatter');
    jest.advanceTimersByTime(1500);
    expect(manager.getActiveSubscriptions()).toHaveLength(0);
  });
});
