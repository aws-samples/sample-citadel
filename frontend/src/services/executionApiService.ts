/**
 * Execution API Service
 * Handles all workflow execution GraphQL operations via AppSync
 */

import serverService from './server';

// --- GraphQL Queries ---

const APPROVAL_REQUEST_FIELDS = `
  approvalRequests {
    requestType
    reason
    requestedBy
    requestedAt
    expiresAt
    decidedBy
    decidedAt
    decision
  }
`;

const GET_EXECUTION = `
  query GetExecution($executionId: ID!) {
    getExecution(executionId: $executionId) {
      executionId
      workflowId
      appId
      orgId
      status
      workflowVersion
      currentNode
      nodeResults
      input
      output
      startedAt
      completedAt
      triggeredBy
      error
      ${APPROVAL_REQUEST_FIELDS}
    }
  }
`;

const LIST_EXECUTIONS = `
  query ListExecutions($workflowId: ID!) {
    listExecutions(workflowId: $workflowId) {
      items {
        executionId
        workflowId
        appId
        orgId
        status
        workflowVersion
        currentNode
        nodeResults
        input
        output
        startedAt
        completedAt
        triggeredBy
        error
        ${APPROVAL_REQUEST_FIELDS}
      }
      nextToken
    }
  }
`;

const LIST_AWAITING_APPROVALS = `
  query ListAwaitingApprovals($limit: Int, $nextToken: String) {
    listAwaitingApprovals(limit: $limit, nextToken: $nextToken) {
      items {
        executionId
        workflowId
        appId
        orgId
        status
        workflowVersion
        currentNode
        nodeResults
        input
        output
        startedAt
        completedAt
        triggeredBy
        error
        ${APPROVAL_REQUEST_FIELDS}
      }
      nextToken
    }
  }
`;

// --- GraphQL Mutations ---

export const START_EXECUTION = `
  mutation StartExecution($workflowId: ID!, $input: AWSJSON) {
    startExecution(workflowId: $workflowId, input: $input) {
      executionId
      workflowId
      appId
      orgId
      status
      workflowVersion
      currentNode
      nodeResults
      input
      output
      startedAt
      completedAt
      triggeredBy
      error
      ${APPROVAL_REQUEST_FIELDS}
    }
  }
`;

export const CANCEL_EXECUTION = `
  mutation CancelExecution($executionId: ID!) {
    cancelExecution(executionId: $executionId) {
      executionId
      workflowId
      appId
      orgId
      status
      workflowVersion
      currentNode
      nodeResults
      input
      output
      startedAt
      completedAt
      triggeredBy
      error
      ${APPROVAL_REQUEST_FIELDS}
    }
  }
`;

export const PAUSE_EXECUTION = `
  mutation PauseExecution($executionId: ID!, $nodeId: ID, $reason: String!) {
    pauseExecution(executionId: $executionId, nodeId: $nodeId, reason: $reason) {
      executionId
      workflowId
      appId
      orgId
      status
      workflowVersion
      currentNode
      nodeResults
      input
      output
      startedAt
      completedAt
      triggeredBy
      error
      ${APPROVAL_REQUEST_FIELDS}
    }
  }
`;

export const APPROVE_EXECUTION = `
  mutation ApproveExecution($executionId: ID!, $nodeId: ID!) {
    approveExecution(executionId: $executionId, nodeId: $nodeId) {
      executionId
      workflowId
      appId
      orgId
      status
      workflowVersion
      currentNode
      nodeResults
      input
      output
      startedAt
      completedAt
      triggeredBy
      error
      ${APPROVAL_REQUEST_FIELDS}
    }
  }
`;

export const DENY_EXECUTION = `
  mutation DenyExecution($executionId: ID!, $nodeId: ID!, $reason: String!) {
    denyExecution(executionId: $executionId, nodeId: $nodeId, reason: $reason) {
      executionId
      workflowId
      appId
      orgId
      status
      workflowVersion
      currentNode
      nodeResults
      input
      output
      startedAt
      completedAt
      triggeredBy
      error
      ${APPROVAL_REQUEST_FIELDS}
    }
  }
`;

/**
 * Execution API Service Class
 * Handles all workflow execution GraphQL operations
 */
class ExecutionApiService {
  async getExecution(executionId: string) {
    const response = await serverService.query<{ getExecution: any }>(
      GET_EXECUTION,
      { executionId }
    );
    return response.getExecution;
  }

  async listExecutions(workflowId: string) {
    const response = await serverService.query<{ listExecutions: { items: any[]; nextToken: string | null } }>(
      LIST_EXECUTIONS,
      { workflowId }
    );
    return response.listExecutions;
  }

  async startExecution(workflowId: string, input?: string) {
    const variables: { workflowId: string; input?: string } = { workflowId };
    if (input !== undefined) {
      variables.input = input;
    }
    const response = await serverService.mutate<{ startExecution: any }>(
      START_EXECUTION,
      variables
    );
    return response.startExecution;
  }

  async cancelExecution(executionId: string) {
    const response = await serverService.mutate<{ cancelExecution: any }>(
      CANCEL_EXECUTION,
      { executionId }
    );
    return response.cancelExecution;
  }

  async pauseExecution(executionId: string, reason: string, nodeId?: string) {
    const variables: { executionId: string; reason: string; nodeId?: string } = { executionId, reason };
    if (nodeId !== undefined) {
      variables.nodeId = nodeId;
    }
    const response = await serverService.mutate<{ pauseExecution: any }>(
      PAUSE_EXECUTION,
      variables
    );
    return response.pauseExecution;
  }

  async approveExecution(executionId: string, nodeId: string) {
    const response = await serverService.mutate<{ approveExecution: any }>(
      APPROVE_EXECUTION,
      { executionId, nodeId }
    );
    return response.approveExecution;
  }

  async denyExecution(executionId: string, nodeId: string, reason: string) {
    const response = await serverService.mutate<{ denyExecution: any }>(
      DENY_EXECUTION,
      { executionId, nodeId, reason }
    );
    return response.denyExecution;
  }

  async listAwaitingApprovals(limit?: number, nextToken?: string) {
    const variables: { limit?: number; nextToken?: string } = {};
    if (limit !== undefined) variables.limit = limit;
    if (nextToken !== undefined) variables.nextToken = nextToken;
    const response = await serverService.query<{ listAwaitingApprovals: { items: any[]; nextToken: string | null } }>(
      LIST_AWAITING_APPROVALS,
      variables
    );
    return response.listAwaitingApprovals;
  }
}

export const executionApiService = new ExecutionApiService();
