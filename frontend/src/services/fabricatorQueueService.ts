/**
 * Fabricator Queue Service
 * Handles querying the fabricator queue and subscribing to fabrication events
 * Migrated to use event bus architecture for centralized subscription management
 */

import serverService from './server';
import { eventBus } from './eventBus';
import { subscriptionManager } from './subscriptionManager';
import { EVENT_TYPES, FabricationEvent } from './eventTypes';

// Re-export FabricationEvent for backward compatibility
export type { FabricationEvent };

export interface FabricationQueueItem {
  requestId: string;
  agentName: string;
  taskDescription: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  submittedAt: string;
  errorMessage?: string;
  metadata?: Record<string, any>;
  appId?: string;
  appName?: string;
}

// GraphQL Queries
const getFabricatorQueueQuery = /* GraphQL */ `
  query GetFabricatorQueue {
    getFabricatorQueue {
      requestId
      agentName
      taskDescription
      status
      submittedAt
      errorMessage
      metadata
    }
  }
`;

// GraphQL Subscriptions
const onFabricationEventSubscription = /* GraphQL */ `
  subscription OnFabricationEvent {
    onFabricationEvent {
      type
      requestId
      agentId
      errorMessage
      timestamp
    }
  }
`;

// Track if backend subscription has been initialized
let isInitialized = false;

/**
 * Initialize the backend subscription for fabrication events
 * This is called once on the first local subscription
 */
function initializeFabricationSubscription(): void {
  if (isInitialized) {
    return;
  }

  // Initialize backend subscription through SubscriptionManager
  subscriptionManager.initializeSubscription(
    EVENT_TYPES.FABRICATION,
    onFabricationEventSubscription,
    {}, // No variables needed for fabrication subscription
    (data: any) => {
      // Transform backend data to FabricationEvent format
      if (data?.onFabricationEvent) {
        return data.onFabricationEvent;
      }
      return null;
    }
  );

  isInitialized = true;
}

/**
 * Get the current state of the fabricator queue
 */
export async function getFabricatorQueue(): Promise<FabricationQueueItem[]> {
  try {
    const response = await serverService.query<{ getFabricatorQueue: FabricationQueueItem[] }>(
      getFabricatorQueueQuery
    );

    const items = response.getFabricatorQueue || [];
    
    // Parse metadata if it's a JSON string
    return items.map((item: any) => ({
      ...item,
      metadata: item.metadata && typeof item.metadata === 'string' 
        ? JSON.parse(item.metadata) 
        : item.metadata,
    }));
  } catch (error) {
    console.error("Error getting fabricator queue:", error);
    throw error;
  }
}

/**
 * Subscribe to fabrication events
 * Returns an unsubscribe function
 * 
 * This function maintains backward compatibility with the previous API
 * while using the new event bus architecture internally.
 */
export function subscribeToFabricationEvents(
  onEvent: (event: FabricationEvent) => void,
  onError?: (error: any) => void
): () => void {
  // Initialize backend subscription if needed
  initializeFabricationSubscription();

  // Add local subscriber to reference count
  subscriptionManager.addLocalSubscriber(EVENT_TYPES.FABRICATION);

  // Subscribe to local event bus
  const unsubscribe = eventBus.subscribe<FabricationEvent>(
    EVENT_TYPES.FABRICATION,
    onEvent
  );

  // Return cleanup function that handles both local and backend cleanup
  return () => {
    // Unsubscribe from local event bus
    unsubscribe();

    // Remove local subscriber from reference count
    // This will trigger backend cleanup if no subscribers remain
    subscriptionManager.removeLocalSubscriber(EVENT_TYPES.FABRICATION);
  };
}

/**
 * Fabricator Queue Service object
 */
export const fabricatorQueueService = {
  getFabricatorQueue,
  subscribeToFabricationEvents,
};
