/**
 * useFabricationQueue(projectId) — shared polling hook.
 *
 * One poller, 10 s while any item is non-terminal (PENDING | PROCESSING),
 * stops when all items are terminal (COMPLETED | FAILED) or the component
 * unmounts. Real-time events update items IN PLACE (not remove them).
 *
 * Used by FabricationStatusPanel (top-right) AND FabricationStatusCard
 * (in-chat stream) so both share the same polling cadence and state.
 */

import { useState, useEffect, useCallback, useRef, useContext } from 'react';
import {
  fabricatorQueueService,
  type FabricationQueueItem,
  type FabricationEvent,
} from '../services/fabricatorQueueService';
import { OrganizationContext } from '../contexts/OrganizationContext';

const TERMINAL_STATUSES = new Set<string>(['COMPLETED', 'FAILED']);
const POLL_INTERVAL_MS = 10_000;

export interface UseFabricationQueueReturn {
  items: FabricationQueueItem[];
  isLoading: boolean;
  error: string | null;
  allTerminal: boolean;
  allBuilt: boolean;
  reload: () => Promise<void>;
}

export function useFabricationQueue(projectId: string): UseFabricationQueueReturn {
  const [items, setItems] = useState<FabricationQueueItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const subscriptionRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Optional context accessor: returns null outside OrganizationProvider
  // instead of throwing, so the hook is safe in tests and pages without
  // the provider.
  const orgCtx = useContext(OrganizationContext);
  const callerOrgId = orgCtx?.currentUser?.organization ?? null;

  const loadQueue = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const queue = await fabricatorQueueService.getFabricatorQueue(projectId);
      if (mountedRef.current) {
        setItems(queue);
      }
    } catch (err: unknown) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load fabrication queue');
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  // Handle real-time events: update items in place, don't remove them.
  const handleEvent = useCallback((event: FabricationEvent) => {
    setItems((prev) =>
      prev.map((item) =>
        item.requestId === event.requestId
          ? { ...item, status: event.type as FabricationQueueItem['status'], errorMessage: event.errorMessage ?? item.errorMessage }
          : item,
      ),
    );
  }, []);

  // Initial load + subscription
  useEffect(() => {
    mountedRef.current = true;
    loadQueue();

    if (callerOrgId) {
      const unsubscribe = fabricatorQueueService.subscribeToFabricationEvents(
        handleEvent,
        callerOrgId,
        (err) => console.error('Fabrication subscription error:', err),
      );
      subscriptionRef.current = unsubscribe;
    }

    return () => {
      mountedRef.current = false;
      if (subscriptionRef.current) {
        subscriptionRef.current();
        subscriptionRef.current = null;
      }
    };
  }, [loadQueue, handleEvent, callerOrgId]);

  // Derived state
  const allTerminal = items.length > 0 && items.every((i) => TERMINAL_STATUSES.has(i.status));
  const allBuilt = items.length > 0 && items.every((i) => i.status === 'COMPLETED');

  // Polling: 10 s while any item is non-terminal
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    const hasNonTerminal = items.length > 0 && !allTerminal;
    if (hasNonTerminal) {
      pollRef.current = setInterval(() => {
        loadQueue();
      }, POLL_INTERVAL_MS);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [allTerminal, items.length, loadQueue]);

  return {
    items,
    isLoading,
    error,
    allTerminal,
    allBuilt,
    reload: loadQueue,
  };
}
