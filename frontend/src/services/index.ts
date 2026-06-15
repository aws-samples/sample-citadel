/**
 * Services barrel export
 */

export { default as serverService, ServerService } from './server';
export type { AmplifyConfig, SignUpParams, SignInParams } from './server';

export { projectService } from './projectService';
export type { Project, ProjectProgress, CreateProjectInput, UpdateProjectInput } from './projectService';

export { workflowService, WorkflowError } from './workflowService';
export type {
  serializeWorkflow,
  deserializeWorkflow,
  validateWorkflow,
  hasCycle,
  wouldCreateCycle,
  findReachableNodes,
  findPredecessorNodes,
  topologicalSort,
} from './workflowService';

export { fabricatorQueueService } from './fabricatorQueueService';
export type { FabricationQueueItem } from './fabricatorQueueService';

export { chatterService } from './chatterService';
export type { ChatterMessage } from './chatterService';

export { eventBus, EventBus } from './eventBus';
export type { EventType, EventCallback, EventBusInterface } from './eventBus';

export { subscriptionManager, SubscriptionManager } from './subscriptionManager';
export type { BackendSubscription, SubscriptionManagerInterface } from './subscriptionManager';

export { EVENT_TYPES } from './eventTypes';
export type {
  EventType as EventTypeString,
  EventData,
  EventDataMap,
  ChatterEvent,
  FabricationEvent,
  ConversationEvent,
  ProjectProgressEvent,
  AssessmentCompleteEvent,
  DesignProgressEvent,
  SubscriptionError,
} from './eventTypes';

export { subscriptionLogger, SubscriptionLogger } from './subscriptionLogger';
export type { LogLevel, SubscriptionMetrics, ErrorTracker } from './subscriptionLogger';

export { subscriptionDebug, initializeSubscriptionDebug } from './subscriptionDebug';
export type { SubscriptionDebugInterface } from './subscriptionDebug';

export { integrationService } from './integrationService';
export type { Integration } from './integrationService';

export { datastoreService } from './datastoreService';
export { DATA_STORE_TYPE_META } from './datastoreService';
export { DataStoreType, DataStoreCategory, DataStoreStatus, DataStoreProvisionMode } from './datastoreService';
export type {
  DataStore,
  DataStoreStats,
  DataStoreTestResult,
  DeleteDataStoreResult,
  CreateDataStoreInput,
  UpdateDataStoreInput,
  TypeMeta,
} from './datastoreService';
