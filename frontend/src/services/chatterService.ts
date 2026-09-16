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
// orgId is required by the backend schema (onChatter(orgId: ID!)) and is
// authorized against the caller's own custom:organization claim (admins
// may pass any org). Callers must supply the caller's own organisation —
// never a hardcoded value or the org-selector's filter scope.
const onChatterSubscription = `
  subscription OnChatter($orgId: ID!) {
    onChatter(orgId: $orgId) {
      id
      timestamp
      source
      detailType
      detail
    }
  }
`;

// Track which orgId the backend subscription was last initialized for, so a
// change in orgId (e.g. user/session switch) can be detected and the stale
// backend subscription torn down first. subscriptionManager itself already
// guards against redundant re-initialization for the *same* orgId (see its
// own isActive check), so this flag is only consulted for org changes.
let initializedOrgId: string | null = null;

/**
 * Initialize the backend subscription for chatter events for the given
 * organisation. Safe to call repeatedly — subscriptionManager no-ops if a
 * subscription for the same orgId is already active. If a subscription is
 * active for a *different* orgId, it is torn down first.
 */
function initializeChatterSubscription(orgId: string): void {
  if (initializedOrgId !== null && initializedOrgId !== orgId) {
    // orgId changed (e.g. user/session switch) — tear down the stale
    // backend subscription before creating one scoped to the new org.
    subscriptionManager.cleanupSubscription(EVENT_TYPES.CHATTER);
  }

  // Initialize backend subscription through SubscriptionManager. This is a
  // no-op if a subscription for this orgId is already active.
  subscriptionManager.initializeSubscription(
    EVENT_TYPES.CHATTER,
    onChatterSubscription,
    { orgId },
    (data: any) => {
      // Transform backend data to ChatterEvent format
      if (data?.onChatter) {
        return data.onChatter;
      }
      return null;
    }
  );

  initializedOrgId = orgId;
}

/**
 * Subscribe to chatter messages
 * Returns an unsubscribe function
 *
 * This function maintains backward compatibility with the previous API
 * while using the new event bus architecture internally.
 *
 * @param onMessage callback invoked with each chatter message
 * @param orgId the caller's own organisation (from OrganizationContext /
 *   getCurrentUserProfile — never a hardcoded placeholder, never the
 *   org-selector filter value for non-admins). When falsy, no backend
 *   subscription is created and the returned unsubscribe is a no-op.
 */
export function subscribeToChatter(
  onMessage: (message: ChatterMessage) => void,
  orgId?: string | null
): () => void {
  if (!orgId) {
    // No organisation available for this caller yet — do not subscribe.
    return () => {};
  }

  // Initialize backend subscription if needed
  initializeChatterSubscription(orgId);

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
