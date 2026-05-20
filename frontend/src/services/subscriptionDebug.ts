/**
 * Subscription Debug Tools
 * 
 * Development mode debugging utilities for inspecting subscription state.
 * Exposes a global __subscriptionDebug object in development mode only.
 * 
 * Requirements: 7.3, 7.4
 */

import { eventBus } from './eventBus';
import { subscriptionManager } from './subscriptionManager';
import { EventType } from './eventTypes';
import { subscriptionLogger } from './subscriptionLogger';

/**
 * Debug interface exposed to window in development mode
 */
export interface SubscriptionDebugInterface {
  /**
   * Get all active backend subscriptions
   * Shows which event types have active WebSocket connections
   */
  getActiveSubscriptions(): {
    eventType: EventType;
    subscriberCount: number;
  }[];

  /**
   * Get subscriber counts for all event types
   * Shows how many local subscribers exist for each event type
   */
  getSubscriberCounts(): {
    eventType: EventType;
    count: number;
  }[];

  /**
   * Get comprehensive subscription state
   * Combines backend and local subscription information
   */
  getSubscriptionState(): {
    activeBackendConnections: number;
    totalLocalSubscribers: number;
    eventTypes: {
      eventType: EventType;
      backendActive: boolean;
      localSubscribers: number;
    }[];
  };

  /**
   * Enable verbose logging for subscription lifecycle events
   */
  enableVerboseLogging(): void;

  /**
   * Disable verbose logging
   */
  disableVerboseLogging(): void;

  /**
   * Check if verbose logging is enabled
   */
  isVerboseLoggingEnabled(): boolean;

  /**
   * Get subscription metrics
   * Shows detailed metrics about subscription activity
   */
  getMetrics(): any;

  /**
   * Log current metrics summary
   */
  logMetricsSummary(): void;

  /**
   * Reset metrics counters
   */
  resetMetrics(): void;
}

/**
 * Verbose logging state
 */
let verboseLoggingEnabled = false;

/**
 * Implementation of debug interface
 */
const subscriptionDebug: SubscriptionDebugInterface = {
  getActiveSubscriptions() {
    const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
    
    return activeSubscriptions.map(sub => ({
      eventType: sub.eventType,
      subscriberCount: sub.subscriberCount,
    }));
  },

  getSubscriberCounts() {
    const activeEventTypes = eventBus.getActiveEventTypes();
    
    return activeEventTypes.map(eventType => ({
      eventType,
      count: eventBus.getSubscriberCount(eventType),
    }));
  },

  getSubscriptionState() {
    const activeSubscriptions = subscriptionManager.getActiveSubscriptions();
    const activeEventTypes = eventBus.getActiveEventTypes();
    
    // Create a map of all event types (both backend and local)
    const eventTypeMap = new Map<EventType, {
      backendActive: boolean;
      localSubscribers: number;
    }>();

    // Add backend subscriptions
    activeSubscriptions.forEach(sub => {
      eventTypeMap.set(sub.eventType, {
        backendActive: true,
        localSubscribers: sub.subscriberCount,
      });
    });

    // Add local-only subscriptions (shouldn't happen in normal operation)
    activeEventTypes.forEach(eventType => {
      if (!eventTypeMap.has(eventType)) {
        eventTypeMap.set(eventType, {
          backendActive: false,
          localSubscribers: eventBus.getSubscriberCount(eventType),
        });
      }
    });

    // Calculate totals
    const activeBackendConnections = activeSubscriptions.length;
    let totalLocalSubscribers = 0;
    eventTypeMap.forEach(state => {
      totalLocalSubscribers += state.localSubscribers;
    });

    // Convert map to array
    const eventTypes = Array.from(eventTypeMap.entries()).map(([eventType, state]) => ({
      eventType,
      backendActive: state.backendActive,
      localSubscribers: state.localSubscribers,
    }));

    return {
      activeBackendConnections,
      totalLocalSubscribers,
      eventTypes,
    };
  },

  enableVerboseLogging() {
    verboseLoggingEnabled = true;
    console.log('[SubscriptionDebug] Verbose logging enabled');
  },

  disableVerboseLogging() {
    verboseLoggingEnabled = false;
    console.log('[SubscriptionDebug] Verbose logging disabled');
  },

  isVerboseLoggingEnabled() {
    return verboseLoggingEnabled;
  },

  getMetrics() {
    const metrics = subscriptionLogger.getMetrics();
    
    // Convert Maps to objects for easier console viewing
    return {
      ...metrics,
      connectionsByEventType: Object.fromEntries(metrics.connectionsByEventType),
      subscribersByEventType: Object.fromEntries(metrics.subscribersByEventType),
      eventsEmittedByType: Object.fromEntries(metrics.eventsEmittedByType),
      errorsByEventType: Object.fromEntries(metrics.errorsByEventType),
    };
  },

  logMetricsSummary() {
    subscriptionLogger.logMetricsSummary();
  },

  resetMetrics() {
    subscriptionLogger.resetMetrics();
    console.log('[SubscriptionDebug] Metrics reset');
  },
};

/**
 * Check if verbose logging is enabled
 * Used by other modules to conditionally log
 */
export function isVerboseLoggingEnabled(): boolean {
  return verboseLoggingEnabled;
}

/**
 * Log a subscription lifecycle event if verbose logging is enabled
 * @param message - The log message
 * @param data - Optional data to log
 */
export function logSubscriptionEvent(message: string, data?: any): void {
  if (verboseLoggingEnabled) {
    if (data !== undefined) {
      console.log(`[SubscriptionLifecycle] ${message}`, data);
    } else {
      console.log(`[SubscriptionLifecycle] ${message}`);
    }
  }
}

/**
 * Initialize debug tools in development mode
 * Exposes __subscriptionDebug to window object
 */
export function initializeSubscriptionDebug(): void {
  if (process.env.NODE_ENV === 'development') {
    // Expose debug interface to window
    (window as any).__subscriptionDebug = subscriptionDebug;
    
    console.log(
      '%c[SubscriptionDebug] Debug tools initialized',
      'color: #00ff00; font-weight: bold'
    );
    console.log(
      '%cAvailable commands:',
      'color: #00aaff; font-weight: bold'
    );
    console.log('  __subscriptionDebug.getActiveSubscriptions()');
    console.log('  __subscriptionDebug.getSubscriberCounts()');
    console.log('  __subscriptionDebug.getSubscriptionState()');
    console.log('  __subscriptionDebug.enableVerboseLogging()');
    console.log('  __subscriptionDebug.disableVerboseLogging()');
    console.log('  __subscriptionDebug.getMetrics()');
    console.log('  __subscriptionDebug.logMetricsSummary()');
    console.log('  __subscriptionDebug.resetMetrics()');
  }
}

// Export for testing
export { subscriptionDebug };
