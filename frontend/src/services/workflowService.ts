/**
 * Workflow Service
 * 
 * Service layer for workflow operations including serialization,
 * deserialization, validation, and graph analysis.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowEdgeDefinition,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from '../types';
import { isWorkflowDefinition } from '../types';
import { agentConfigService, type AgentConfig } from './agentConfigService';

/**
 * Custom error class for workflow operations
 */
export class WorkflowError extends Error {
  constructor(
    public type: 'user_input' | 'data' | 'validation',
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/**
 * Serializes a workflow from ReactFlow nodes and edges to a JSON structure
 * 
 * @param nodes - Array of WorkflowNode instances from ReactFlow
 * @param edges - Array of WorkflowEdge instances from ReactFlow
 * @param metadata - Optional metadata for the workflow
 * @returns WorkflowDefinition object ready for JSON serialization
 */
export function serializeWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  metadata?: Partial<WorkflowDefinition>
): WorkflowDefinition {
  try {
    const now = new Date().toISOString();
    
    const workflowDefinition: WorkflowDefinition = {
      version: metadata?.version || '1.0.0',
      id: metadata?.id || uuidv4(),
      name: metadata?.name || 'Untitled Workflow',
      description: metadata?.description,
      createdAt: metadata?.createdAt || now,
      updatedAt: now,
      nodes: nodes.map((node): WorkflowNodeDefinition => ({
        id: node.id,
        agentId: node.data.agentId,
        position: {
          x: node.position.x,
          y: node.position.y,
        },
        configuration: node.data.configuration || {},
      })),
      edges: edges.map((edge): WorkflowEdgeDefinition => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || 'output',
        targetHandle: edge.targetHandle || 'input',
      })),
      metadata: metadata?.metadata,
    };

    return workflowDefinition;
  } catch (error) {
    throw new WorkflowError(
      'data',
      'SERIALIZATION_ERROR',
      'Failed to serialize workflow',
      { error, nodes, edges }
    );
  }
}

/**
 * Deserializes a workflow from JSON to ReactFlow nodes and edges
 * 
 * @param workflowJson - JSON string or WorkflowDefinition object
 * @param agentConfigs - Optional map of agent configs (if not provided, will fetch from service)
 * @returns Object containing nodes and edges arrays for ReactFlow
 * @throws WorkflowError if JSON is invalid or references missing agents
 */
export async function deserializeWorkflow(
  workflowJson: string | WorkflowDefinition,
  agentConfigs?: Map<string, AgentConfig>
): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }> {
  try {
    // Parse JSON if string
    let workflow: WorkflowDefinition;
    if (typeof workflowJson === 'string') {
      try {
        workflow = JSON.parse(workflowJson);
      } catch (parseError) {
        throw new WorkflowError(
          'user_input',
          'INVALID_JSON',
          'Invalid JSON format',
          { parseError }
        );
      }
    } else {
      workflow = workflowJson;
    }

    // Validate workflow structure
    if (!isWorkflowDefinition(workflow)) {
      throw new WorkflowError(
        'validation',
        'INVALID_WORKFLOW_STRUCTURE',
        'Workflow structure is invalid or missing required fields',
        { workflow }
      );
    }

    // Fetch agent configs if not provided
    let agentConfigMap = agentConfigs;
    if (!agentConfigMap) {
      const configs = await agentConfigService.listAgentConfigs();
      agentConfigMap = new Map(configs.map(config => [config.agentId, config]));
    }

    // Validate that all referenced agents exist
    const missingAgents: string[] = [];
    for (const node of workflow.nodes) {
      if (!agentConfigMap.has(node.agentId)) {
        missingAgents.push(node.agentId);
      }
    }

    if (missingAgents.length > 0) {
      throw new WorkflowError(
        'validation',
        'MISSING_AGENTS',
        `Workflow references agents that do not exist: ${missingAgents.join(', ')}`,
        { missingAgents }
      );
    }

    // Convert to ReactFlow nodes
    const nodes: WorkflowNode[] = workflow.nodes.map((nodeDef): WorkflowNode => {
      const agentConfig = agentConfigMap!.get(nodeDef.agentId)!;
      
      return {
        id: nodeDef.id,
        type: 'agentNode',
        position: nodeDef.position,
        data: {
          agentId: nodeDef.agentId,
          agentConfig: agentConfig,
          label: agentConfig.config?.name || nodeDef.agentId,
          icon: agentConfig.config?.icon,
          configuration: nodeDef.configuration,
          inputCount: 1,
          outputCount: 1,
        },
      };
    });

    // Convert to ReactFlow edges
    const edges: WorkflowEdge[] = workflow.edges.map((edgeDef): WorkflowEdge => ({
      id: edgeDef.id,
      source: edgeDef.source,
      target: edgeDef.target,
      sourceHandle: edgeDef.sourceHandle,
      targetHandle: edgeDef.targetHandle,
      type: 'smoothstep',
    }));

    return { nodes, edges };
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw new WorkflowError(
      'data',
      'DESERIALIZATION_ERROR',
      'Failed to deserialize workflow',
      { error, workflowJson }
    );
  }
}

/**
 * Validates a workflow for structural correctness and completeness
 * 
 * @param nodes - Array of WorkflowNode instances
 * @param edges - Array of WorkflowEdge instances
 * @returns ValidationResult with errors and warnings
 */
export function validateWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Empty workflow is valid
  if (nodes.length === 0) {
    return { isValid: true, errors, warnings };
  }

  // Check for circular dependencies
  if (hasCycle(nodes, edges)) {
    errors.push({
      type: 'circular_dependency',
      message: 'Workflow contains circular dependencies',
    });
  }

  // Check for disconnected nodes (only if workflow has more than one node)
  if (nodes.length > 1) {
    for (const node of nodes) {
      const hasInputs = edges.some(edge => edge.target === node.id);
      const hasOutputs = edges.some(edge => edge.source === node.id);
      
      if (!hasInputs && !hasOutputs) {
        errors.push({
          type: 'disconnected_node',
          nodeId: node.id,
          message: `Node "${node.data.label}" is not connected to any other nodes`,
        });
      }
    }
  }

  // Check for invalid edge references
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({
        type: 'invalid_connection',
        edgeId: edge.id,
        message: `Edge references non-existent source node: ${edge.source}`,
      });
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({
        type: 'invalid_connection',
        edgeId: edge.id,
        message: `Edge references non-existent target node: ${edge.target}`,
      });
    }
  }

  // Check for missing required configurations
  for (const node of nodes) {
    const requiredConfig = node.data.agentConfig?.config?.schema?.required || [];
    const providedConfig = Object.keys(node.data.configuration || {});
    
    const missingConfig = requiredConfig.filter(
      (key: string) => !providedConfig.includes(key)
    );
    
    if (missingConfig.length > 0) {
      errors.push({
        type: 'missing_config',
        nodeId: node.id,
        message: `Node "${node.data.label}" is missing required configuration: ${missingConfig.join(', ')}`,
      });
    }
  }

  // Add warnings for nodes with unused outputs
  for (const node of nodes) {
    const hasOutputs = edges.some(edge => edge.source === node.id);
    if (!hasOutputs && nodes.length > 1) {
      warnings.push({
        type: 'unused_output',
        nodeId: node.id,
        message: `Node "${node.data.label}" has no outgoing connections`,
      });
    }
  }

  // Add warnings for nodes with multiple inputs
  for (const node of nodes) {
    const inputCount = edges.filter(edge => edge.target === node.id).length;
    if (inputCount > 1) {
      warnings.push({
        type: 'multiple_inputs',
        nodeId: node.id,
        message: `Node "${node.data.label}" has ${inputCount} incoming connections`,
      });
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detects if the workflow graph contains any cycles
 * Uses depth-first search with recursion stack tracking
 * 
 * @param nodes - Array of WorkflowNode instances
 * @param edges - Array of WorkflowEdge instances
 * @returns true if cycle detected, false otherwise
 */
export function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  // Build adjacency list
  const adjacencyList = new Map<string, string[]>();
  for (const node of nodes) {
    adjacencyList.set(node.id, []);
  }
  for (const edge of edges) {
    const neighbors = adjacencyList.get(edge.source);
    if (neighbors) {
      neighbors.push(edge.target);
    }
  }

  // Track visited nodes and recursion stack
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  /**
   * DFS helper function to detect cycles
   */
  function dfs(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const neighbors = adjacencyList.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          return true;
        }
      } else if (recursionStack.has(neighbor)) {
        // Found a back edge - cycle detected
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  // Check each node as potential starting point
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if adding a connection would create a cycle
 * 
 * @param sourceId - Source node ID
 * @param targetId - Target node ID
 * @param nodes - Current workflow nodes
 * @param edges - Current workflow edges
 * @returns true if connection would create a cycle
 */
export function wouldCreateCycle(
  sourceId: string,
  targetId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): boolean {
  // Create a temporary edge
  const tempEdge: WorkflowEdge = {
    id: 'temp',
    source: sourceId,
    target: targetId,
    sourceHandle: 'output',
    targetHandle: 'input',
  };

  // Check if adding this edge would create a cycle
  return hasCycle(nodes, [...edges, tempEdge]);
}

/**
 * Finds all nodes that are reachable from a given node
 * 
 * @param nodeId - Starting node ID
 * @param edges - Workflow edges
 * @returns Set of reachable node IDs
 */
export function findReachableNodes(
  nodeId: string,
  edges: WorkflowEdge[]
): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    // Add all neighbors to queue
    for (const edge of edges) {
      if (edge.source === current && !reachable.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return reachable;
}

/**
 * Finds all nodes that can reach a given node
 * 
 * @param nodeId - Target node ID
 * @param edges - Workflow edges
 * @returns Set of node IDs that can reach the target
 */
export function findPredecessorNodes(
  nodeId: string,
  edges: WorkflowEdge[]
): Set<string> {
  const predecessors = new Set<string>();
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (predecessors.has(current)) {
      continue;
    }
    predecessors.add(current);

    // Add all predecessors to queue
    for (const edge of edges) {
      if (edge.target === current && !predecessors.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }

  return predecessors;
}

/**
 * Performs topological sort on the workflow graph
 * Returns nodes in execution order (if no cycles exist)
 * 
 * @param nodes - Workflow nodes
 * @param edges - Workflow edges
 * @returns Array of node IDs in topological order, or null if cycle exists
 */
export function topologicalSort(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): string[] | null {
  // Check for cycles first
  if (hasCycle(nodes, edges)) {
    return null;
  }

  // Calculate in-degree for each node
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }

  // Build adjacency list
  const adjacencyList = new Map<string, string[]>();
  for (const node of nodes) {
    adjacencyList.set(node.id, []);
  }
  for (const edge of edges) {
    adjacencyList.get(edge.source)!.push(edge.target);
  }

  // Queue of nodes with in-degree 0
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    // Reduce in-degree of neighbors
    const neighbors = adjacencyList.get(current) || [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // If result doesn't contain all nodes, there's a cycle
  if (result.length !== nodes.length) {
    return null;
  }

  return result;
}

/**
 * Workflow service object with all workflow operations
 */
export const workflowService = {
  serializeWorkflow,
  deserializeWorkflow,
  validateWorkflow,
  hasCycle,
  wouldCreateCycle,
  findReachableNodes,
  findPredecessorNodes,
  topologicalSort,
};
