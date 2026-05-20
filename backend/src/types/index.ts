export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  currentModule: Module;
  progress: ProjectProgress;
  createdAt: string;
  updatedAt: string;
  owner: string;
  description?: string;
  requirements?: string;
  agents?: AgentStatus[];
}

export interface Module {
  id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  agentId: string;
}

export interface ProjectProgress {
  overall: number;
  assessment: number;
  design: number;
  planning: number;
  implementation: number;
  currentPhase: string;
  estimatedCompletion?: string;
}

export interface AgentStatus {
  agentId: string;
  projectId: string;
  status: AgentStatusEnum;
  currentTask?: string;
  progress?: number;
  lastUpdate: string;
  metadata?: any;
  errorMessage?: string;
}

export interface ConversationMessage {
  id: string;
  projectId: string;
  agentId: string;
  message: string;
  messageType: MessageType;
  timestamp: string;
  metadata?: any;
  correlationId?: string;
}

export interface DocumentUploadResult {
  success: boolean;
  documentId?: string;
  url?: string;
  message: string;
}

export interface ProjectConnection {
  items: Project[];
  nextToken?: string;
}

export interface ProjectFilter {
  status?: ProjectStatus;
  owner?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  requirements?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  requirements?: string;
  status?: ProjectStatus;
}

export interface AgentStatusInput {
  status: AgentStatusEnum;
  currentTask?: string;
  progress?: number;
  metadata?: any;
  errorMessage?: string;
}

export interface ProjectProgressInput {
  overall?: number;
  assessment?: number;
  design?: number;
  planning?: number;
  implementation?: number;
  currentPhase?: string;
  estimatedCompletion?: string;
}

export interface ConversationMessageInput {
  agentId: string;
  message: string;
  messageType: MessageType;
  metadata?: any;
  correlationId?: string;
}

export interface S3Object {
  bucket: string;
  key: string;
  region: string;
}

export enum ProjectStatus {
  CREATED = 'CREATED',
  IN_PROGRESS = 'IN_PROGRESS',
  ASSESSMENT_COMPLETE = 'ASSESSMENT_COMPLETE',
  DESIGN_COMPLETE = 'DESIGN_COMPLETE',
  PLANNING_COMPLETE = 'PLANNING_COMPLETE',
  IMPLEMENTATION_READY = 'IMPLEMENTATION_READY',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export enum ModuleStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export enum AgentStatusEnum {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  WAITING_FOR_INPUT = 'WAITING_FOR_INPUT',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export enum MessageType {
  USER_INPUT = 'USER_INPUT',
  AGENT_RESPONSE = 'AGENT_RESPONSE',
  SYSTEM_NOTIFICATION = 'SYSTEM_NOTIFICATION',
  PROGRESS_UPDATE = 'PROGRESS_UPDATE'
}

// Event types for EventBridge integration
export interface AgentEvent {
  eventType: string;
  projectId: string;
  agentId?: string;
  payload: any;
  timestamp: string;
  correlationId?: string;
}

// Authorization context
export interface AuthContext {
  userId: string;
  username?: string;
  groups?: string[];
  roles?: string[];
}

// Service layer integration types
export interface ServiceLayerRequest {
  agentId: string;
  projectId: string;
  action: string;
  payload: any;
  correlationId: string;
}

export interface ServiceLayerResponse {
  success: boolean;
  data?: any;
  error?: string;
  correlationId: string;
}