/**
 * Execution API Service
 * Handles all workflow execution GraphQL operations via AppSync
 */

import serverService from './server';

// --- GraphQL Queries ---

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
      }
      nextToken
    }
  }
`;

// --- GraphQL Mutations ---

const START_EXECUTION = `
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
    }
  }
`;

const CANCEL_EXECUTION = `
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
}

export const executionApiService = new ExecutionApiService();
