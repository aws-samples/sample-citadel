/**
 * useSubscriptionHealth — Tracks subscription connectivity and drives
 * reconnect with capped exponential backoff (1, 2, 4, 8 s; max 5 tries).
 *
 * On reconnect it refetches conversation history since the last seen
 * message timestamp and merges new messages into the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { eventBus } from '../services/eventBus';
import { EVENT_TYPES, SubscriptionError } from '../services/eventTypes';
import { subscriptionManager } from '../services/subscriptionManager';
import {
  getConversationHistoryForProject,
  ConversationMessage,
} from '../services/conversationService';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_STEPS = [1, 2, 4, 8, 8]; // seconds

export function useSubscriptionHealth(
  projectId: string,
  lastSeenTimestamp: string | null,
  onNewMessages: (msgs: ConversationMessage[]) => void,
) {
  const [status, setStatus] = useState<ConnectionStatus>('connected');
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  // Listen for SUBSCRIPTION_ERROR events from the event bus.
  useEffect(() => {
    const handleError = (evt: SubscriptionError) => {
      if (evt.eventType !== EVENT_TYPES.CONVERSATION) return;
      setStatus('reconnecting');
      attemptReconnect();
    };
    const unsub = eventBus.subscribe<SubscriptionError>(
      EVENT_TYPES.SUBSCRIPTION_ERROR,
      handleError,
    );
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const attemptReconnect = useCallback(() => {
    if (retriesRef.current >= MAX_RETRIES) {
      setStatus('disconnected');
      return;
    }
    const delay = BACKOFF_STEPS[Math.min(retriesRef.current, BACKOFF_STEPS.length - 1)] * BACKOFF_BASE_MS;
    retriesRef.current += 1;
    setStatus('reconnecting');
    timerRef.current = setTimeout(async () => {
      try {
        // Force cleanup and re-initialise the backend subscription.
        subscriptionManager.cleanupSubscription(EVENT_TYPES.CONVERSATION);
        // Remove the project from the initialised set so subscribeToConversation re-inits.
        // The set is module-private; the simplest way is to call cleanupSubscription which
        // already marks the subscription inactive — the next subscribeToConversation call
        // with this projectId will re-initialize.

        // Refetch messages since last seen.
        if (lastSeenTimestamp) {
          const history = await getConversationHistoryForProject(projectId, 50);
          const newer = history.items.filter((m) => m.timestamp > lastSeenTimestamp);
          if (newer.length > 0) onNewMessages(newer);
        }
        // Success — reset.
        retriesRef.current = 0;
        setStatus('connected');
      } catch {
        // Retry again.
        attemptReconnect();
      }
    }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, lastSeenTimestamp]);

  const manualReconnect = useCallback(() => {
    retriesRef.current = 0;
    attemptReconnect();
  }, [attemptReconnect]);

  return { connectionStatus: status, manualReconnect };
}
