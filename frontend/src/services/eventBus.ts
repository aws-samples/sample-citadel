/**
 * EventBus - Type-safe local pub/sub mechanism for distributing events to components
 * 
 * This class provides a centralized event distribution system that allows components
 * to subscribe to specific event types and receive updates without managing WebSocket
 * connections directly.
 */

import { EventType } from './eventTypes';
import { logSubscriptionEvent } from './subscriptionDebug';
import { subscriptionLogger } from './subscriptionLogger';

export type EventCallback<T = any> = (data: T) => void;

// Re-export EventType for backward compatibility
export type { EventType };

export interface EventBusInterface {
  /**
   * Subscribe to an event type
   * @param eventType - The type of event to subscribe to
   * @param callback - Function to call when event is emitted
   * @returns Unsubscribe function
   */
  subscribe<T = any>(
    eventType: EventType,
    callback: EventCallback<T>
  ): () => void;

  /**
   * Emit an event to all subscribers
   * @param eventType - The type of event to emit
   * @param data - The event data to send to subscribers
   */
  emit<T = any>(eventType: EventType, data: T): void;

  /**
   * Unsubscribe a specific callback from an event type
   * @param eventType - The type of event to unsubscribe from
   * @param callback - The callback to remove
   */
  unsubscribe<T = any>(eventType: EventType, callback: EventCallback<T>): void;

  /**
   * Get subscriber count for debugging
   * @param eventType - The event type to check
   * @returns Number of subscribers for the event type
   */
  getSubscriberCount(eventType: EventType): number;

  /**
   * Get all active event types
   * @returns Array of event types that have at least one subscriber
   */
  getActiveEventTypes(): EventType[];

  /**
   * Clear all subscribers (for testing)
   */
  clear(): void;
}

/**
 * EventBus implementation using Map and Set for O(1) operations
 */
class EventBus implements EventBusInterface {
  private subscribers: Map<EventType, Set<EventCallback>>;

  constructor() {
    this.subscribers = new Map();
  }

  /**
   * Subscribe to an event type
   * Returns an unsubscribe function that removes the specific callback
   */
  subscribe<T = any>(
    eventType: EventType,
    callback: EventCallback<T>
  ): () => void {
    // Get or create the subscriber set for this event type
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }

    const subscriberSet = this.subscribers.get(eventType)!;
    subscriberSet.add(callback);

    // Track subscriber added in metrics
    subscriptionLogger.trackSubscriberAdded(eventType);

    // Log subscription in verbose mode
    logSubscriptionEvent(
      `Local subscription added for ${eventType}`,
      { subscriberCount: subscriberSet.size }
    );

    // Return unsubscribe function that removes this specific callback
    return () => {
      this.unsubscribe(eventType, callback);
    };
  }

  /**
   * Emit an event to all subscribers synchronously
   */
  emit<T = any>(eventType: EventType, data: T): void {
    const subscriberSet = this.subscribers.get(eventType);
    
    if (!subscriberSet || subscriberSet.size === 0) {
      return;
    }

    // Track event emission in metrics
    subscriptionLogger.trackEventEmitted(eventType, subscriberSet.size);

    // Log emission in verbose mode
    logSubscriptionEvent(
      `Event emitted for ${eventType}`,
      { subscriberCount: subscriberSet.size }
    );

    // Invoke all callbacks synchronously
    subscriberSet.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        // Log error with production-safe logging
        subscriptionLogger.error(
          `Error in event callback for ${eventType}`,
          error as Error,
          { 
            eventType,
            subscriberCount: subscriberSet.size,
          }
        );
      }
    });
  }

  /**
   * Unsubscribe a specific callback from an event type
   */
  unsubscribe<T = any>(eventType: EventType, callback: EventCallback<T>): void {
    const subscriberSet = this.subscribers.get(eventType);
    
    if (subscriberSet) {
      subscriberSet.delete(callback);
      
      // Track subscriber removed in metrics
      subscriptionLogger.trackSubscriberRemoved(eventType);
      
      // Log unsubscription in verbose mode
      logSubscriptionEvent(
        `Local subscription removed for ${eventType}`,
        { subscriberCount: subscriberSet.size }
      );
      
      // Clean up empty sets to prevent memory leaks
      if (subscriberSet.size === 0) {
        this.subscribers.delete(eventType);
        logSubscriptionEvent(`All local subscribers removed for ${eventType}`);
      }
    }
  }

  /**
   * Get the number of subscribers for a specific event type
   */
  getSubscriberCount(eventType: EventType): number {
    const subscriberSet = this.subscribers.get(eventType);
    return subscriberSet ? subscriberSet.size : 0;
  }

  /**
   * Get all event types that currently have subscribers
   */
  getActiveEventTypes(): EventType[] {
    return Array.from(this.subscribers.keys()).filter(
      (eventType) => this.getSubscriberCount(eventType) > 0
    );
  }

  /**
   * Clear all subscribers (primarily for testing)
   */
  clear(): void {
    this.subscribers.clear();
  }
}

// Export singleton instance
export const eventBus = new EventBus();

// Export class for testing
export { EventBus };
