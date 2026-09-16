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
  query GetFabricatorQueue($projectId: ID) {
    getFabricatorQueue(projectId: $projectId) {
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
// orgId is required by the backend schema (onFabricationEvent(orgId: ID!))
// and is authorized against the caller's own custom:organization claim
// (admins may pass any org). Callers must supply the caller's own
// organisation — never a hardcoded value or the org-selector's filter scope.
const onFabricationEventSubscription = /* GraphQL */ `
  subscription OnFabricationEvent($orgId: ID!) {
    onFabricationEvent(orgId: $orgId) {
      type
      requestId
      agentId
      errorMessage
      timestamp
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
 * Initialize the backend subscription for fabrication events for the given
 * organisation. Safe to call repeatedly — subscriptionManager no-ops if a
 * subscription for the same orgId is already active. If a subscription is
 * active for a *different* orgId, it is torn down first.
 */
function initializeFabricationSubscription(orgId: string): void {
  if (initializedOrgId !== null && initializedOrgId !== orgId) {
    // orgId changed (e.g. user/session switch) — tear down the stale
    // backend subscription before creating one scoped to the new org.
    subscriptionManager.cleanupSubscription(EVENT_TYPES.FABRICATION);
  }

  // Initialize backend subscription through SubscriptionManager. This is a
  // no-op if a subscription for this orgId is already active.
  subscriptionManager.initializeSubscription(
    EVENT_TYPES.FABRICATION,
    onFabricationEventSubscription,
    { orgId },
    (data: any) => {
      // Transform backend data to FabricationEvent format
      if (data?.onFabricationEvent) {
        return data.onFabricationEvent;
      }
      return null;
    }
  );

  initializedOrgId = orgId;
}

/**
 * Get the current state of the fabricator queue.
 *
 * @param projectId Optional project/orchestration id. When provided, only
 *   fabrication jobs for that project are returned. When omitted (e.g. the
 *   Agent Catalog drawer), all jobs are returned. The intake
 *   session_id === orchestrationId === projectId.
 */
export async function getFabricatorQueue(projectId?: string): Promise<FabricationQueueItem[]> {
  try {
    const response = await serverService.query<{ getFabricatorQueue: FabricationQueueItem[] }>(
      getFabricatorQueueQuery,
      { projectId }
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
 *
 * @param onEvent callback invoked with each fabrication event
 * @param orgId the caller's own organisation (from OrganizationContext /
 *   getCurrentUserProfile — never a hardcoded placeholder, never the
 *   org-selector filter value for non-admins). When falsy, no backend
 *   subscription is created and the returned unsubscribe is a no-op.
 * @param _onError optional error callback (currently unused, kept for
 *   backward compatibility with existing call sites)
 */
export function subscribeToFabricationEvents(
  onEvent: (event: FabricationEvent) => void,
  orgId?: string | null,
  _onError?: (error: any) => void
): () => void {
  if (!orgId) {
    // No organisation available for this caller yet — do not subscribe.
    return () => {};
  }

  // Initialize backend subscription if needed
  initializeFabricationSubscription(orgId);

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
