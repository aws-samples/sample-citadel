/**
 * Conversation Service
 * Handles real-time messaging with agents via AppSync subscriptions
 * Migrated to use event bus architecture for centralized subscription management
 */

import serverService from './server';
import { eventBus } from './eventBus';
import { subscriptionManager } from './subscriptionManager';
import { EVENT_TYPES, ConversationEvent } from './eventTypes';

// Re-export ConversationMessage for backward compatibility
export type ConversationMessage = ConversationEvent;

// GraphQL Queries
const getConversationHistory = /* GraphQL */ `
  query GetConversationHistory($projectId: ID!, $limit: Int, $nextToken: String) {
    getConversationHistory(projectId: $projectId, limit: $limit, nextToken: $nextToken) {
      items {
        id
        projectId
        agentId
        message
        messageType
        timestamp
        metadata
        correlationId
      }
      nextToken
    }
  }
`;

// GraphQL Mutations
const sendMessage = /* GraphQL */ `
  mutation SendMessage($projectId: ID!, $message: ConversationMessageInput!) {
    sendMessage(projectId: $projectId, message: $message) {
      id
      projectId
      agentId
      message
      messageType
      timestamp
      metadata
      correlationId
    }
  }
`;

// GraphQL Subscriptions
const onConversationMessage = /* GraphQL */ `
  subscription OnConversationMessage($projectId: ID!) {
    onConversationMessage(projectId: $projectId) {
      id
      projectId
      agentId
      message
      messageType
      timestamp
      metadata
      correlationId
    }
  }
`;

/**
 * Send a message to an agent
 */
export async function sendMessageToAgent(
  projectId: string,
  agentId: string,
  message: string,
  metadata?: Record<string, any>
): Promise<ConversationMessage> {
  try {
    const response = await serverService.mutate<{ sendMessage: ConversationMessage }>(
      sendMessage,
      {
        projectId,
        message: {
          agentId,
          message,
          messageType: "USER_INPUT",
          ...(metadata && { metadata: JSON.stringify(metadata) }),
        },
      }
    );

    return response.sendMessage;
  } catch (error) {
    console.error("Error sending message:", error);
    throw error;
  }
}

/**
 * Get conversation history for a project
 */
export async function getConversationHistoryForProject(
  projectId: string,
  limit?: number,
  nextToken?: string,
): Promise<{ items: ConversationMessage[]; nextToken: string | null }> {
  try {
    const response = await serverService.query<{ getConversationHistory: { items: ConversationMessage[]; nextToken: string | null } }>(
      getConversationHistory,
      { projectId, limit: limit || 50, nextToken }
    );

    const result = response.getConversationHistory;
    // Backward compatibility: handle both old (array) and new (paginated) response
    if (Array.isArray(result)) {
      return { items: result, nextToken: null };
    }
    return result || { items: [], nextToken: null };
  } catch (error) {
    console.error("Error getting conversation history:", error);
    throw error;
  }
}

// Track initialized subscriptions by projectId
const initializedProjects = new Set<string>();

/**
 * Initialize the backend subscription for conversation events for a specific project
 * This is called once per projectId on the first local subscription
 */
function initializeConversationSubscription(projectId: string): void {
  if (initializedProjects.has(projectId)) {
    return;
  }

  // Initialize backend subscription through SubscriptionManager
  // Note: We use a composite event type that includes the projectId
  // to ensure separate backend connections per project
  const eventType = EVENT_TYPES.CONVERSATION;
  
  subscriptionManager.initializeSubscription(
    eventType,
    onConversationMessage,
    { projectId },
    (data: any) => {
      // Transform backend data to ConversationEvent format
      if (data?.onConversationMessage) {
        return data.onConversationMessage;
      }
      return null;
    }
  );

  initializedProjects.add(projectId);
}

/**
 * Subscribe to conversation messages for a project
 * Returns an unsubscribe function
 * 
 * This function maintains backward compatibility with the previous API
 * while using the new event bus architecture internally.
 * 
 * Note: Conversation subscriptions are projectId-specific, so we filter
 * events locally to ensure each subscriber only receives messages for
 * their specific project.
 */
export function subscribeToConversation(
  projectId: string,
  onMessage: (message: ConversationMessage) => void,
  _onError?: (error: any) => void
): () => void {
  // Initialize backend subscription if needed
  initializeConversationSubscription(projectId);

  // Add local subscriber to reference count
  subscriptionManager.addLocalSubscriber(EVENT_TYPES.CONVERSATION);

  // Subscribe to local event bus with projectId filtering
  // Since conversation events are project-specific, we need to filter
  // to ensure this subscriber only receives messages for their project
  const filteredCallback = (message: ConversationMessage) => {
    if (message.projectId === projectId) {
      onMessage(message);
    }
  };

  const unsubscribe = eventBus.subscribe<ConversationMessage>(
    EVENT_TYPES.CONVERSATION,
    filteredCallback
  );

  // Return cleanup function that handles both local and backend cleanup
  return () => {
    // Unsubscribe from local event bus
    unsubscribe();

    // Remove local subscriber from reference count
    // This will trigger backend cleanup if no subscribers remain
    subscriptionManager.removeLocalSubscriber(EVENT_TYPES.CONVERSATION);
  };
}

/**
 * Parse metadata from JSON string
 */
export function parseMetadata(
  metadata?: string
): Record<string, any> | undefined {
  if (!metadata) return undefined;

  try {
    return JSON.parse(metadata);
  } catch (error) {
    console.error("Error parsing metadata:", error);
    return undefined;
  }
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
