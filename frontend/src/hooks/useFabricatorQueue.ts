/**
 * useFabricatorQueue Hook
 * 
 * Custom hook for managing fabricator queue state and real-time updates
 * 
 * Features:
 * - Loads current queue state from backend
 * - Subscribes to real-time fabrication events
 * - Automatically updates queue when events occur
 * - Shows toast notifications for completions and failures
 * - Handles errors and loading states
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  fabricatorQueueService,
  FabricationQueueItem,
  FabricationEvent,
} from '../services/fabricatorQueueService';

interface UseFabricatorQueueReturn {
  queueItems: FabricationQueueItem[];
  error: string | null;
  isLoading: boolean;
  reload: () => Promise<void>;
  addPendingItem: (requestId: string, agentName: string, taskDescription: string) => void;
}

interface UseFabricatorQueueOptions {
  onFabricationComplete?: (agentId?: string) => void;
}

/**
 * Hook for managing fabricator queue state and subscriptions
 */
export function useFabricatorQueue(options?: UseFabricatorQueueOptions): UseFabricatorQueueReturn {
  const [queueItems, setQueueItems] = useState<FabricationQueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const subscriptionRef = useRef<(() => void) | null>(null);
  
  // Store the callback in a ref to avoid recreating the effect
  const onFabricationCompleteRef = useRef(options?.onFabricationComplete);
  
  // Update the ref when the callback changes
  useEffect(() => {
    onFabricationCompleteRef.current = options?.onFabricationComplete;
  }, [options?.onFabricationComplete]);

  /**
   * Load queue items from backend
   */
  const loadQueue = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      const items = await fabricatorQueueService.getFabricatorQueue();
      setQueueItems(items);
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to load fabricator queue';
      setError(errorMessage);
      console.error('Error loading fabricator queue:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Handle fabrication events from subscription
   */
  const handleFabricationEvent = useCallback((event: FabricationEvent) => {
    console.log('Received fabrication event:', event);

    // Remove the completed/failed item from queue
    setQueueItems((prevItems) =>
      prevItems.filter((item) => item.requestId !== event.requestId)
    );

    // Show appropriate notification
    if (event.type === 'COMPLETED') {
      toast.success('Agent created successfully!', {
        description: event.agentId 
          ? `Agent ${event.agentId} is now available in the catalog`
          : 'Your agent is now available in the catalog',
      });
      
      // Call the onFabricationComplete callback if provided
      if (onFabricationCompleteRef.current) {
        onFabricationCompleteRef.current(event.agentId);
      }
    } else if (event.type === 'FAILED') {
      toast.error('Agent creation failed', {
        description: event.errorMessage || 'An error occurred during fabrication',
      });
    }
  }, []);

  /**
   * Set up queue loading and subscription on mount
   */
  useEffect(() => {
    // Load initial queue state
    loadQueue();

    // Subscribe to real-time fabrication events
    const unsubscribe = fabricatorQueueService.subscribeToFabricationEvents(
      handleFabricationEvent,
      (subscriptionError) => {
        console.error('Subscription error:', subscriptionError);
        // Don't set error state for subscription errors to avoid disrupting UI
        // The subscription will automatically reconnect
      }
    );

    subscriptionRef.current = unsubscribe;

    // Cleanup: unsubscribe on component unmount
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current();
        subscriptionRef.current = null;
      }
    };
  }, [loadQueue, handleFabricationEvent]);

  /**
   * Add a pending item to the queue immediately (optimistic update)
   */
  const addPendingItem = useCallback((requestId: string, agentName: string, taskDescription: string) => {
    const newItem: FabricationQueueItem = {
      requestId,
      agentName,
      taskDescription,
      status: 'PENDING',
      submittedAt: new Date().toISOString(),
    };
    
    setQueueItems((prevItems) => [...prevItems, newItem]);
  }, []);

  return {
    queueItems,
    error,
    isLoading,
    reload: loadQueue,
    addPendingItem,
  };
}
