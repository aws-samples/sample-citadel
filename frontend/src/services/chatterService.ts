/**
 * Chatter Service
 * Handles real-time chatter messages via AppSync subscriptions
 * Migrated to use event bus architecture for centralized subscription management
 */

import { eventBus } from './eventBus';
import { subscriptionManager } from './subscriptionManager';
import { EVENT_TYPES, ChatterEvent } from './eventTypes';

// Re-export ChatterMessage for backward compatibility
export type ChatterMessage = ChatterEvent;

// GraphQL Subscription
const onChatterSubscription = `
  subscription OnChatter {
    onChatter {
      id
      timestamp
      source
      detailType
      detail
    }
  }
`;

// Track if backend subscription has been initialized
let isInitialized = false;

/**
 * Initialize the backend subscription for chatter events
 * This is called once on the first local subscription
 */
function initializeChatterSubscription(): void {
  if (isInitialized) {
    return;
  }

  // Initialize backend subscription through SubscriptionManager
  subscriptionManager.initializeSubscription(
    EVENT_TYPES.CHATTER,
    onChatterSubscription,
    {}, // No variables needed for chatter subscription
    (data: any) => {
      // Transform backend data to ChatterEvent format
      if (data?.onChatter) {
        return data.onChatter;
      }
      return null;
    }
  );

  isInitialized = true;
}

/**
 * Subscribe to chatter messages
 * Returns an unsubscribe function
 * 
 * This function maintains backward compatibility with the previous API
 * while using the new event bus architecture internally.
 */
export function subscribeToChatter(
  onMessage: (message: ChatterMessage) => void
): () => void {
  // Initialize backend subscription if needed
  initializeChatterSubscription();

  // Add local subscriber to reference count
  subscriptionManager.addLocalSubscriber(EVENT_TYPES.CHATTER);

  // Subscribe to local event bus
  const unsubscribe = eventBus.subscribe<ChatterMessage>(
    EVENT_TYPES.CHATTER,
    onMessage
  );

  // Return cleanup function that handles both local and backend cleanup
  return () => {
    // Unsubscribe from local event bus
    unsubscribe();

    // Remove local subscriber from reference count
    // This will trigger backend cleanup if no subscribers remain
    subscriptionManager.removeLocalSubscriber(EVENT_TYPES.CHATTER);
  };
}

/**
 * Chatter service object
 */
export const chatterService = {
  subscribeToChatter,
};
