/**
 * SubscriptionManager Usage Example
 * 
 * This file demonstrates how to use the SubscriptionManager
 * to migrate existing services to the event bus pattern.
 */

import { subscriptionManager } from '../subscriptionManager';
import { eventBus } from '../eventBus';
import { EVENT_TYPES } from '../eventTypes';

/**
 * Example: Migrating chatterService to use SubscriptionManager
 * 
 * Before migration:
 * - Direct serverService.subscribe() call
 * - Returns unsubscribe function directly
 * 
 * After migration:
 * - Initialize backend subscription through SubscriptionManager
 * - Subscribe to local event bus
 * - Return cleanup function that handles both
 */

// GraphQL subscription query
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

// Track if backend subscription is initialized
let isChatterInitialized = false;

/**
 * Subscribe to chatter events using the new pattern
 */
export function subscribeToChatterWithEventBus(
  onMessage: (message: any) => void
): () => void {
  // Initialize backend subscription on first call
  if (!isChatterInitialized) {
    subscriptionManager.initializeSubscription(
      EVENT_TYPES.CHATTER,
      onChatterSubscription,
      {}, // variables
      (data) => data?.onChatter // transformer
    );
    isChatterInitialized = true;
  }

  // Increment local subscriber count
  subscriptionManager.addLocalSubscriber(EVENT_TYPES.CHATTER);

  // Subscribe to local event bus
  const unsubscribe = eventBus.subscribe(EVENT_TYPES.CHATTER, onMessage);

  // Return cleanup function
  return () => {
    unsubscribe();
    subscriptionManager.removeLocalSubscriber(EVENT_TYPES.CHATTER);
  };
}

/**
 * Example: Using the subscription in a React component
 * 
 * This would typically be in a hook like useChatterSubscription
 */
export function exampleComponentUsage() {
  // In useEffect or similar
  const unsubscribe = subscribeToChatterWithEventBus((message) => {
    console.log('Received chatter message:', message);
  });

  // Cleanup on unmount
  return () => {
    unsubscribe();
  };
}

/**
 * Example: Multiple components subscribing to the same event
 * 
 * This demonstrates the key benefit: only one backend WebSocket connection
 * is created even though multiple components are subscribing
 */
export function exampleMultipleSubscribers() {
  // Component 1 subscribes
  const unsubscribe1 = subscribeToChatterWithEventBus((message) => {
    console.log('Component 1 received:', message);
  });

  // Component 2 subscribes (reuses same backend connection)
  const unsubscribe2 = subscribeToChatterWithEventBus((message) => {
    console.log('Component 2 received:', message);
  });

  // Component 3 subscribes (still only one backend connection)
  const unsubscribe3 = subscribeToChatterWithEventBus((message) => {
    console.log('Component 3 received:', message);
  });

  // Check active subscriptions
  const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
  console.log('Active backend connections:', activeSubscriptions.length); // Should be 1
  console.log('Local subscribers:', activeSubscriptions[0]?.subscriberCount); // Should be 3

  // Cleanup
  return () => {
    unsubscribe1();
    unsubscribe2();
    unsubscribe3();
    // After 1 second, backend connection will be closed automatically
  };
}

/**
 * Example: Debugging subscription state
 * 
 * In development mode, you can inspect the subscription state
 */
export function exampleDebugging() {
  // Get all active subscriptions
  const subscriptions = subscriptionManager.getActiveSubscriptions();

  subscriptions.forEach((sub) => {
    console.log(`Event Type: ${sub.eventType}`);
    console.log(`Subscriber Count: ${sub.subscriberCount}`);
  });

  // Get subscriber count from event bus
  const chatterCount = eventBus.getSubscriberCount(EVENT_TYPES.CHATTER);
  console.log(`Local chatter subscribers: ${chatterCount}`);

  // Get all active event types
  const activeTypes = eventBus.getActiveEventTypes();
  console.log('Active event types:', activeTypes);
}
