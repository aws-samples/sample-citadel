/**
 * SubscriptionManager - Backend subscription coordinator
 * 
 * Manages backend WebSocket subscriptions and coordinates with the event bus.
 * Implements reference counting to ensure only one backend connection per event type
 * and automatic cleanup when no local subscribers remain.
 * Includes error handling with exponential backoff reconnection.
 */

import { EventType, SubscriptionError, EVENT_TYPES } from './eventTypes';
import { eventBus } from './eventBus';
import serverService from './server';
import { logSubscriptionEvent } from './subscriptionDebug';
import { subscriptionLogger } from './subscriptionLogger';

/**
 * Represents an active backend subscription
 */
export interface BackendSubscription {
  eventType: EventType;
  unsubscribe: () => void;
  subscriberCount: number;
}

/**
 * Internal subscription state
 */
interface SubscriptionState {
  eventType: EventType;
  backendUnsubscribe: (() => void) | null;
  localSubscriberCount: number;
  cleanupTimer: NodeJS.Timeout | null;
  isActive: boolean;
  subscriptionQuery: string;
  variables: Record<string, any>;
  transformer: (data: any) => any;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  maxReconnectAttempts: number;
}

/**
 * SubscriptionManager interface
 */
export interface SubscriptionManagerInterface {
  /**
   * Initialize a backend subscription for an event type
   * @param eventType - The event type to subscribe to
   * @param subscriptionQuery - GraphQL subscription query
   * @param variables - Variables for the subscription query
   * @param transformer - Function to transform backend data before emitting
   */
  initializeSubscription(
    eventType: EventType,
    subscriptionQuery: string,
    variables: Record<string, any>,
    transformer: (data: any) => any
  ): void;

  /**
   * Increment local subscriber count
   * @param eventType - The event type
   */
  addLocalSubscriber(eventType: EventType): void;

  /**
   * Decrement local subscriber count and cleanup if needed
   * @param eventType - The event type
   */
  removeLocalSubscriber(eventType: EventType): void;

  /**
   * Get active backend subscriptions
   * @returns Array of active backend subscriptions
   */
  getActiveSubscriptions(): BackendSubscription[];

  /**
   * Force cleanup of a subscription
   * @param eventType - The event type to cleanup
   */
  cleanupSubscription(eventType: EventType): void;
}

/**
 * SubscriptionManager implementation
 * Singleton class that manages backend subscriptions
 */
class SubscriptionManager implements SubscriptionManagerInterface {
  private static instance: SubscriptionManager | null = null;
  private subscriptions: Map<EventType, SubscriptionState>;
  private readonly CLEANUP_DEBOUNCE_MS = 1000; // 1 second debounce
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly INITIAL_RECONNECT_DELAY_MS = 1000; // 1 second
  private readonly MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds

  private constructor() {
    this.subscriptions = new Map();
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): SubscriptionManager {
    if (!SubscriptionManager.instance) {
      SubscriptionManager.instance = new SubscriptionManager();
    }
    return SubscriptionManager.instance;
  }

  /**
   * Initialize a backend subscription for an event type
   * This sets up the WebSocket connection to AppSync and configures
   * the data transformation and emission to the local event bus.
   */
  public initializeSubscription(
    eventType: EventType,
    subscriptionQuery: string,
    variables: Record<string, any>,
    transformer: (data: any) => any
  ): void {
    // Check if subscription already exists
    const existingState = this.subscriptions.get(eventType);
    if (existingState?.isActive) {
      // Subscription already initialized, just cancel any pending cleanup
      if (existingState.cleanupTimer) {
        clearTimeout(existingState.cleanupTimer);
        existingState.cleanupTimer = null;
      }
      return;
    }

    // Create the subscription with error handling
    this.createBackendSubscription(eventType, subscriptionQuery, variables, transformer);
  }

  /**
   * Create a backend subscription with error handling
   * Separated from initializeSubscription to allow reconnection
   */
  private createBackendSubscription(
    eventType: EventType,
    subscriptionQuery: string,
    variables: Record<string, any>,
    transformer: (data: any) => any
  ): void {
    try {
      // Wrap the subscription to catch errors
      let hasReceivedData = false;
      let errorOccurred = false;

      // Create new backend subscription with error handling
      const backendUnsubscribe = serverService.subscribe(
        subscriptionQuery,
        variables,
        (data: any) => {
          try {
            hasReceivedData = true;
            
            // Transform the data
            const transformedData = transformer(data);
            
            // Emit to local event bus if data is valid
            if (transformedData !== null && transformedData !== undefined) {
              eventBus.emit(eventType, transformedData);
              
              // Reset reconnect attempts on successful data reception
              const state = this.subscriptions.get(eventType);
              if (state) {
                // Track reconnection success if this was a reconnection
                if (state.reconnectAttempts > 0) {
                  subscriptionLogger.trackReconnectionSuccess(eventType);
                }
                state.reconnectAttempts = 0;
              }
            }
          } catch (error) {
            const state = this.subscriptions.get(eventType);
            const subscriberCount = state?.localSubscriberCount || 0;
            
            // Log error with production-safe logging (Requirement 7.5)
            subscriptionLogger.error(
              `Error processing subscription data for ${eventType}`,
              error as Error,
              { 
                eventType,
                subscriberCount,
              }
            );
            
            // Emit error event to local subscribers
            this.emitSubscriptionError(eventType, error as Error, state?.reconnectAttempts || 0);
          }
        }
      );

      // Monitor for connection errors by checking if we receive data
      // If no data is received within a reasonable time and the subscription is active,
      // we may need to handle connection issues
      const connectionCheckTimer = setTimeout(() => {
        if (!hasReceivedData && !errorOccurred) {
          const state = this.subscriptions.get(eventType);
          if (state?.isActive) {
            // Connection may have failed silently
            if (process.env.NODE_ENV === 'development') {
              console.warn(
                `[SubscriptionManager] No data received for ${eventType} after connection. This may indicate a connection issue.`
              );
            }
          }
        }
      }, 10000); // 10 second check

      // Get or create subscription state
      let state = this.subscriptions.get(eventType);
      
      if (!state) {
        // Create new state
        state = {
          eventType,
          backendUnsubscribe: () => {
            clearTimeout(connectionCheckTimer);
            backendUnsubscribe();
          },
          localSubscriberCount: 0,
          cleanupTimer: null,
          isActive: true,
          subscriptionQuery,
          variables,
          transformer,
          reconnectAttempts: 0,
          reconnectTimer: null,
          maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
        };
        this.subscriptions.set(eventType, state);
      } else {
        // Update existing state
        state.backendUnsubscribe = () => {
          clearTimeout(connectionCheckTimer);
          backendUnsubscribe();
        };
        state.isActive = true;
        state.subscriptionQuery = subscriptionQuery;
        state.variables = variables;
        state.transformer = transformer;
      }

      // Track connection created in metrics
      subscriptionLogger.trackConnectionCreated(eventType);

      // Log in development mode
      if (process.env.NODE_ENV === 'development') {
        console.log(`[SubscriptionManager] Initialized backend subscription for ${eventType}`);
      }

      // Log lifecycle event in verbose mode
      logSubscriptionEvent(
        `Backend subscription initialized for ${eventType}`,
        { subscriberCount: state.localSubscriberCount }
      );
    } catch (error) {
      const state = this.subscriptions.get(eventType);
      const subscriberCount = state?.localSubscriberCount || 0;
      
      // Log error with production-safe logging (Requirement 7.5)
      subscriptionLogger.error(
        `Failed to create backend subscription for ${eventType}`,
        error as Error,
        { 
          eventType,
          subscriberCount,
        }
      );
      
      // Emit error event
      this.emitSubscriptionError(eventType, error as Error, state?.reconnectAttempts || 0);
      
      // Attempt reconnection
      this.scheduleReconnection(eventType);
    }
  }

  /**
   * Increment local subscriber count
   * Cancels any pending cleanup for this event type
   */
  public addLocalSubscriber(eventType: EventType): void {
    const state = this.subscriptions.get(eventType);
    
    if (!state) {
      console.warn(
        `[SubscriptionManager] Cannot add subscriber for ${eventType}: subscription not initialized`
      );
      return;
    }

    // Cancel any pending cleanup
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }

    // Increment subscriber count
    state.localSubscriberCount++;

    // Log in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[SubscriptionManager] Added local subscriber for ${eventType} (count: ${state.localSubscriberCount})`
      );
    }

    // Log lifecycle event in verbose mode
    logSubscriptionEvent(
      `Local subscriber added to backend subscription for ${eventType}`,
      { subscriberCount: state.localSubscriberCount }
    );
  }

  /**
   * Decrement local subscriber count and schedule cleanup if needed
   * Uses debounced cleanup to prevent rapid connect/disconnect cycles
   */
  public removeLocalSubscriber(eventType: EventType): void {
    const state = this.subscriptions.get(eventType);
    
    if (!state) {
      console.warn(
        `[SubscriptionManager] Cannot remove subscriber for ${eventType}: subscription not found`
      );
      return;
    }

    // Decrement subscriber count
    state.localSubscriberCount = Math.max(0, state.localSubscriberCount - 1);

    // Log in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[SubscriptionManager] Removed local subscriber for ${eventType} (count: ${state.localSubscriberCount})`
      );
    }

    // Log lifecycle event in verbose mode
    logSubscriptionEvent(
      `Local subscriber removed from backend subscription for ${eventType}`,
      { subscriberCount: state.localSubscriberCount }
    );

    // Schedule cleanup if no subscribers remain
    if (state.localSubscriberCount === 0) {
      this.scheduleCleanup(eventType);
    }
  }

  /**
   * Schedule debounced cleanup for a subscription
   * Waits 1 second before actually closing the connection
   */
  private scheduleCleanup(eventType: EventType): void {
    const state = this.subscriptions.get(eventType);
    
    if (!state) {
      return;
    }

    // Clear any existing cleanup timer
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
    }

    // Schedule new cleanup
    state.cleanupTimer = setTimeout(() => {
      // Double-check subscriber count before cleanup
      if (state.localSubscriberCount === 0) {
        this.performCleanup(eventType);
      }
    }, this.CLEANUP_DEBOUNCE_MS);

    // Log in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[SubscriptionManager] Scheduled cleanup for ${eventType} in ${this.CLEANUP_DEBOUNCE_MS}ms`
      );
    }

    // Log lifecycle event in verbose mode
    logSubscriptionEvent(
      `Cleanup scheduled for ${eventType}`,
      { delayMs: this.CLEANUP_DEBOUNCE_MS }
    );
  }

  /**
   * Perform actual cleanup of a subscription
   * Closes the WebSocket connection and removes state
   */
  private performCleanup(eventType: EventType): void {
    const state = this.subscriptions.get(eventType);
    
    if (!state) {
      return;
    }

    // Clear cleanup timer
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }

    // Clear reconnect timer
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    // Unsubscribe from backend
    if (state.backendUnsubscribe) {
      try {
        state.backendUnsubscribe();
      } catch (error) {
        subscriptionLogger.error(
          `Error during backend unsubscribe for ${eventType}`,
          error as Error,
          { eventType }
        );
      }
      state.backendUnsubscribe = null;
    }

    // Track connection closed in metrics
    subscriptionLogger.trackConnectionClosed(eventType);

    // Mark as inactive
    state.isActive = false;

    // Remove from map
    this.subscriptions.delete(eventType);

    // Log in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[SubscriptionManager] Cleaned up backend subscription for ${eventType}`
      );
    }

    // Log lifecycle event in verbose mode
    logSubscriptionEvent(`Backend subscription cleaned up for ${eventType}`);
  }

  /**
   * Get active backend subscriptions
   * Returns information about all currently active subscriptions
   */
  public getActiveSubscriptions(): BackendSubscription[] {
    const activeSubscriptions: BackendSubscription[] = [];

    this.subscriptions.forEach((state, eventType) => {
      if (state.isActive && state.backendUnsubscribe) {
        activeSubscriptions.push({
          eventType,
          unsubscribe: state.backendUnsubscribe,
          subscriberCount: state.localSubscriberCount,
        });
      }
    });

    return activeSubscriptions;
  }

  /**
   * Force cleanup of a subscription
   * Immediately closes the connection without debounce
   */
  public cleanupSubscription(eventType: EventType): void {
    const state = this.subscriptions.get(eventType);
    
    if (!state) {
      return;
    }

    // Clear any pending cleanup timer
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }

    // Clear any pending reconnect timer
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    // Perform immediate cleanup
    this.performCleanup(eventType);
  }

  /**
   * Emit a subscription error event to local subscribers
   * Includes event type, error details, timestamp, and attempt count
   */
  private emitSubscriptionError(eventType: EventType, error: Error, attemptCount: number): void {
    const state = this.subscriptions.get(eventType);
    const subscriberCount = state?.localSubscriberCount || 0;
    
    // Log error with production-safe logging (Requirement 7.5)
    subscriptionLogger.error(
      `Error in subscription for ${eventType}`,
      error,
      { 
        eventType,
        subscriberCount,
        attemptCount,
      }
    );

    // Create error event
    const errorEvent: SubscriptionError = {
      eventType,
      error,
      timestamp: new Date().toISOString(),
      attemptCount,
    };

    // Emit error event to local subscribers (Requirement 3.3)
    eventBus.emit(EVENT_TYPES.SUBSCRIPTION_ERROR, errorEvent);
  }

  /**
   * Schedule reconnection with exponential backoff
   * Implements exponential backoff: 1s, 2s, 4s, 8s, max 30s
   * Stops after MAX_RECONNECT_ATTEMPTS (5) failed attempts
   */
  private scheduleReconnection(eventType: EventType): void {
    const state = this.subscriptions.get(eventType);
    
    if (!state) {
      return;
    }

    // Check if we've exceeded max reconnect attempts
    if (state.reconnectAttempts >= state.maxReconnectAttempts) {
      const error = new Error(`Max reconnection attempts (${state.maxReconnectAttempts}) reached`);
      
      // Track reconnection failure
      subscriptionLogger.trackReconnectionFailure(eventType, error);
      
      // Emit final error event
      this.emitSubscriptionError(
        eventType,
        error,
        state.reconnectAttempts
      );
      
      // Mark as inactive but keep state for potential manual reconnection
      state.isActive = false;
      return;
    }

    // Clear any existing reconnect timer
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    // Calculate exponential backoff delay: 2^attempt * initial delay, capped at max
    const delay = Math.min(
      Math.pow(2, state.reconnectAttempts) * this.INITIAL_RECONNECT_DELAY_MS,
      this.MAX_RECONNECT_DELAY_MS
    );

    // Increment attempt count
    state.reconnectAttempts++;

    // Track reconnection attempt
    subscriptionLogger.trackReconnectionAttempt(eventType, state.reconnectAttempts);

    // Log reconnection attempt
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[SubscriptionManager] Scheduling reconnection for ${eventType} in ${delay}ms (attempt ${state.reconnectAttempts}/${state.maxReconnectAttempts})`
      );
    }

    // Log lifecycle event in verbose mode
    logSubscriptionEvent(
      `Reconnection scheduled for ${eventType}`,
      { 
        delayMs: delay,
        attempt: state.reconnectAttempts,
        maxAttempts: state.maxReconnectAttempts
      }
    );

    // Schedule reconnection
    state.reconnectTimer = setTimeout(() => {
      if (process.env.NODE_ENV === 'development') {
        console.log(
          `[SubscriptionManager] Attempting reconnection for ${eventType} (attempt ${state.reconnectAttempts}/${state.maxReconnectAttempts})`
        );
      }

      // Log lifecycle event in verbose mode
      logSubscriptionEvent(
        `Reconnection attempt for ${eventType}`,
        { 
          attempt: state.reconnectAttempts,
          maxAttempts: state.maxReconnectAttempts
        }
      );

      // Clean up old subscription if it exists
      if (state.backendUnsubscribe) {
        try {
          state.backendUnsubscribe();
        } catch (error) {
          console.error(
            `[SubscriptionManager] Error cleaning up old subscription for ${eventType}:`,
            error
          );
        }
        state.backendUnsubscribe = null;
      }

      // Attempt to recreate the subscription
      this.createBackendSubscription(
        state.eventType,
        state.subscriptionQuery,
        state.variables,
        state.transformer
      );
    }, delay);
  }

  /**
   * Clear all subscriptions (for testing)
   */
  public clearAll(): void {
    this.subscriptions.forEach((_state, eventType) => {
      this.cleanupSubscription(eventType);
    });
    this.subscriptions.clear();
  }
}

// Export singleton instance
export const subscriptionManager = SubscriptionManager.getInstance();

// Export class for testing
export { SubscriptionManager };
