/**
 * Event Type Registry
 * Central registry of all event types used in the subscription event bus
 */

export const EVENT_TYPES = {
  CHATTER: 'chatter',
  FABRICATION: 'fabrication',
  CONVERSATION: 'conversation',
  PROJECT_PROGRESS: 'projectProgress',
  ASSESSMENT_COMPLETE: 'assessmentComplete',
  DESIGN_PROGRESS: 'designProgress',
  SUBSCRIPTION_ERROR: 'subscriptionError',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

/**
 * Event Data Interfaces
 * Type definitions for all event data structures
 */

export interface ChatterEvent {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: any;
}

export interface FabricationEvent {
  type: 'COMPLETED' | 'FAILED';
  requestId: string;
  agentId?: string;
  errorMessage?: string;
  timestamp: string;
}

export interface ConversationEvent {
  id: string;
  projectId: string;
  agentId: string;
  message: string;
  messageType: 'USER_INPUT' | 'AGENT_RESPONSE' | 'SYSTEM_NOTIFICATION' | 'PROGRESS_UPDATE';
  timestamp: string;
  metadata?: string;
  correlationId?: string;
}

export interface ProjectProgressEvent {
  projectId: string;
  assessment: number;
}

export interface AssessmentCompleteEvent {
  projectId: string;
  allDimensionsComplete: boolean;
  timestamp: string;
}

export interface DesignProgressEvent {
  projectId: string;
  sectionId: string;
  completionPercentage: number;
}

/**
 * SubscriptionError - Error event for subscription failures
 * Emitted when a backend subscription encounters an error
 */
export interface SubscriptionError {
  eventType: EventType;
  error: Error;
  timestamp: string;
  attemptCount: number;
}

/**
 * EventDataMap - Type map for type-safe subscriptions
 * Maps event types to their corresponding data structures
 */
export interface EventDataMap {
  [EVENT_TYPES.CHATTER]: ChatterEvent;
  [EVENT_TYPES.FABRICATION]: FabricationEvent;
  [EVENT_TYPES.CONVERSATION]: ConversationEvent;
  [EVENT_TYPES.PROJECT_PROGRESS]: ProjectProgressEvent;
  [EVENT_TYPES.ASSESSMENT_COMPLETE]: AssessmentCompleteEvent;
  [EVENT_TYPES.DESIGN_PROGRESS]: DesignProgressEvent;
  [EVENT_TYPES.SUBSCRIPTION_ERROR]: SubscriptionError;
}

/**
 * Type helper to get event data type from event type string
 */
export type EventData<T extends EventType> = EventDataMap[T];
