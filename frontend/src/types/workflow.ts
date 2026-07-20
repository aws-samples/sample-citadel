/**
 * Workflow Builder Type Definitions
 * 
 * Core data models and types for the Agent Workflow Builder feature.
 * These types define the structure for workflow nodes, edges, definitions,
 * validation results, and related data structures.
 */

import type { Node, Edge } from 'reactflow';
import type { AgentConfig } from '../services/agentConfigService';

/**
 * Data structure for an agent node on the workflow canvas
 */
export interface AgentNodeData {
  agentId: string;
  agentConfig: AgentConfig;
  label: string;
  icon?: string;
  configuration?: Record<string, any>;
  inputCount: number;
  outputCount: number;
  validationErrors?: ValidationError[];
  /** Tool bindings resolved from ToolConfig entries for this agent's tools */
  toolBindings?: ToolBindingSummary[];
}

/** Summary of a tool's resource bindings for display on the canvas node */
export interface ToolBindingSummary {
  toolId: string;
  toolName: string;
  resourceName: string;
  resourceType: 'datastore' | 'integration';
  direction: 'input' | 'output' | 'bidirectional';
}

/**
 * Represents an agent instance on the workflow canvas
 * Compatible with ReactFlow's Node type with workflow-specific data
 */
export type WorkflowNode = Node<AgentNodeData, 'agentNode'>;

/**
 * Represents a connection between two agent nodes
 * Compatible with ReactFlow's Edge type with workflow-specific properties
 */
export type WorkflowEdge = Edge<{
  sourceHandle: string;
  targetHandle: string;
}>;

/**
 * Condition applied to a workflow edge for conditional branching
 */
export interface EdgeCondition {
  field: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan' | 'exists';
  value: any;
}

/**
 * Retry policy for a workflow node
 */
export interface RetryPolicy {
  maxRetries: number;
  backoffBase: number;
  backoffMax: number;
  retryableErrors: string[];
}

/**
 * Workflow-level configuration for integrations, credentials, and parameters
 */
export interface WorkflowConfiguration {
  integrations?: Record<string, any>;
  credentials?: Record<string, string>;
  agentProperties?: Record<string, any>;
  parameters?: Record<string, string>;
}

/**
 * Result of a single node execution within a workflow run
 */
export interface NodeResult {
  nodeId: string;
  agentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  output?: any;
  error?: string;
  retryCount: number;
}

/**
 * Simplified node definition for serialization
 */
export interface WorkflowNodeDefinition {
  id: string;
  agentId: string;
  /**
   * Human-readable step/agent display name. Optional: intake-generated
   * envelopes carry it so the canvas never falls back to showing a raw
   * registry recordId; legacy/seeded definitions may omit it.
   */
  name?: string;
  position: { x: number; y: number };
  configuration: Record<string, any>;
  retryPolicy?: RetryPolicy;
}

/**
 * Simplified edge definition for serialization
 */
export interface WorkflowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  condition?: EdgeCondition;
}

/**
 * Complete workflow definition for persistence
 * This is the structure that gets serialized to JSON
 */
export interface WorkflowDefinition {
  version: string;
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
  metadata?: {
    author?: string;
    tags?: string[];
    [key: string]: any;
  };
}

/**
 * Validation error types
 */
export type ValidationErrorType = 
  | 'disconnected_node' 
  | 'invalid_connection' 
  | 'missing_config' 
  | 'circular_dependency';

/**
 * Validation warning types
 */
export type ValidationWarningType = 
  | 'unused_output' 
  | 'multiple_inputs' 
  | 'performance';

/**
 * Individual validation error
 */
export interface ValidationError {
  type: ValidationErrorType;
  nodeId?: string;
  edgeId?: string;
  message: string;
}

/**
 * Individual validation warning
 */
export interface ValidationWarning {
  type: ValidationWarningType;
  nodeId?: string;
  message: string;
}

/**
 * Result of workflow validation
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Type guard to check if a value is a WorkflowNode
 */
export function isWorkflowNode(node: any): node is WorkflowNode {
  return (
    node !== null &&
    typeof node === 'object' &&
    typeof node.id === 'string' &&
    node.type === 'agentNode' &&
    typeof node.position === 'object' &&
    typeof node.position.x === 'number' &&
    typeof node.position.y === 'number' &&
    typeof node.data === 'object' &&
    typeof node.data.agentId === 'string' &&
    typeof node.data.label === 'string' &&
    typeof node.data.inputCount === 'number' &&
    typeof node.data.outputCount === 'number'
  );
}

/**
 * Type guard to check if a value is a WorkflowEdge
 */
export function isWorkflowEdge(edge: any): edge is WorkflowEdge {
  return (
    edge !== null &&
    typeof edge === 'object' &&
    typeof edge.id === 'string' &&
    typeof edge.source === 'string' &&
    typeof edge.target === 'string' &&
    typeof edge.sourceHandle === 'string' &&
    typeof edge.targetHandle === 'string'
  );
}

/**
 * Type guard to check if a value is a WorkflowNodeDefinition
 */
export function isWorkflowNodeDefinition(node: any): node is WorkflowNodeDefinition {
  return (
    node !== null &&
    typeof node === 'object' &&
    typeof node.id === 'string' &&
    typeof node.agentId === 'string' &&
    (node.name === undefined || typeof node.name === 'string') &&
    typeof node.position === 'object' &&
    typeof node.position.x === 'number' &&
    typeof node.position.y === 'number' &&
    typeof node.configuration === 'object'
  );
}

/**
 * Type guard to check if a value is a WorkflowEdgeDefinition
 */
export function isWorkflowEdgeDefinition(edge: any): edge is WorkflowEdgeDefinition {
  return (
    edge !== null &&
    typeof edge === 'object' &&
    typeof edge.id === 'string' &&
    typeof edge.source === 'string' &&
    typeof edge.target === 'string' &&
    typeof edge.sourceHandle === 'string' &&
    typeof edge.targetHandle === 'string'
  );
}

/**
 * Type guard to check if a value is a WorkflowDefinition
 *
 * KEEP IN SYNC: backend/src/lambda/__tests__/fixtures/workflow-envelope-guard.ts
 * mirrors this guard (and isWorkflowNodeDefinition / isWorkflowEdgeDefinition
 * above) field-for-field to assert every seeded blueprint envelope stays
 * loadable on the canvas. If this guard changes shape, update the backend
 * contract test mirror in the same review.
 */
export function isWorkflowDefinition(workflow: any): workflow is WorkflowDefinition {
  if (
    workflow === null ||
    typeof workflow !== 'object' ||
    typeof workflow.version !== 'string' ||
    typeof workflow.id !== 'string' ||
    typeof workflow.name !== 'string' ||
    typeof workflow.createdAt !== 'string' ||
    typeof workflow.updatedAt !== 'string' ||
    !Array.isArray(workflow.nodes) ||
    !Array.isArray(workflow.edges)
  ) {
    return false;
  }

  // Validate all nodes
  if (!workflow.nodes.every(isWorkflowNodeDefinition)) {
    return false;
  }

  // Validate all edges
  if (!workflow.edges.every(isWorkflowEdgeDefinition)) {
    return false;
  }

  return true;
}

/**
 * Type guard to check if a value is a ValidationError
 */
export function isValidationError(error: any): error is ValidationError {
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof error.type === 'string' &&
    typeof error.message === 'string' &&
    (error.nodeId === undefined || typeof error.nodeId === 'string') &&
    (error.edgeId === undefined || typeof error.edgeId === 'string')
  );
}

/**
 * Type guard to check if a value is a ValidationWarning
 */
export function isValidationWarning(warning: any): warning is ValidationWarning {
  return (
    warning !== null &&
    typeof warning === 'object' &&
    typeof warning.type === 'string' &&
    typeof warning.message === 'string' &&
    (warning.nodeId === undefined || typeof warning.nodeId === 'string')
  );
}

/**
 * Type guard to check if a value is a ValidationResult
 */
export function isValidationResult(result: any): result is ValidationResult {
  return (
    result !== null &&
    typeof result === 'object' &&
    typeof result.isValid === 'boolean' &&
    Array.isArray(result.errors) &&
    Array.isArray(result.warnings) &&
    result.errors.every(isValidationError) &&
    result.warnings.every(isValidationWarning)
  );
}
