/**
 * Workflow API Service
 * Handles all workflow and blueprint GraphQL operations via AppSync
 */

import serverService from './server';

// --- GraphQL Queries ---

const GET_WORKFLOW = `
  query GetWorkflow($workflowId: ID!) {
    getWorkflow(workflowId: $workflowId) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      versionHistory
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

const LIST_WORKFLOWS = `
  query ListWorkflows($orgId: String!, $status: WorkflowStatus) {
    listWorkflows(orgId: $orgId, status: $status) {
      items {
        workflowId
        orgId
        name
        description
        status
        isBlueprint
        definition
        configuration
        version
        appId
        createdBy
        createdAt
        updatedAt
        metadata
        timeout
      }
      nextToken
    }
  }
`;

const LIST_BLUEPRINTS = `
  query ListBlueprints($category: String) {
    listBlueprints(category: $category) {
      items {
        workflowId
        orgId
        name
        description
        status
        isBlueprint
        definition
        configuration
        version
        appId
        createdBy
        createdAt
        updatedAt
        metadata
        timeout
      }
      nextToken
    }
  }
`;

const EXPORT_WORKFLOW = `
  query ExportWorkflow($workflowId: ID!) {
    exportWorkflow(workflowId: $workflowId)
  }
`;

const GET_WORKFLOW_VERSION = `
  query GetWorkflowVersion($workflowId: ID!, $version: Int!) {
    getWorkflowVersion(workflowId: $workflowId, version: $version) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      versionHistory
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

const LIST_APP_WORKFLOWS = `
  query ListAppWorkflows($appId: ID!) {
    listAppWorkflows(appId: $appId) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

// --- GraphQL Mutations ---

export const CREATE_WORKFLOW = `
  mutation CreateWorkflow($input: CreateWorkflowInput!) {
    createWorkflow(input: $input) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

export const UPDATE_WORKFLOW = `
  mutation UpdateWorkflow($input: UpdateWorkflowInput!) {
    updateWorkflow(input: $input) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      versionHistory
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

const DELETE_WORKFLOW = `
  mutation DeleteWorkflow($workflowId: ID!) {
    deleteWorkflow(workflowId: $workflowId) {
      success
      message
    }
  }
`;

export const PUBLISH_WORKFLOW = `
  mutation PublishWorkflow($workflowId: ID!) {
    publishWorkflow(workflowId: $workflowId) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

const UPDATE_WORKFLOW_CONFIGURATION = `
  mutation UpdateWorkflowConfiguration($workflowId: ID!, $configuration: AWSJSON!, $version: Int!) {
    updateWorkflowConfiguration(workflowId: $workflowId, configuration: $configuration, version: $version) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

const IMPORT_BLUEPRINT = `
  mutation ImportBlueprint($blueprintId: ID!, $appId: ID!, $name: String, $agentMapping: AWSJSON) {
    importBlueprint(blueprintId: $blueprintId, appId: $appId, name: $name, agentMapping: $agentMapping) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

const IMPORT_WORKFLOW = `
  mutation ImportWorkflow($input: ImportWorkflowInput!) {
    importWorkflow(input: $input) {
      workflowId
      orgId
      name
      description
      status
      isBlueprint
      definition
      configuration
      version
      appId
      createdBy
      createdAt
      updatedAt
      metadata
      timeout
    }
  }
`;

/**
 * Workflow API Service Class
 * Handles all workflow and blueprint GraphQL operations
 */
class WorkflowApiService {
  async getWorkflow(workflowId: string) {
    const response = await serverService.query<{ getWorkflow: any }>(
      GET_WORKFLOW,
      { workflowId }
    );
    return response.getWorkflow;
  }

  async listWorkflows(orgId: string, status?: string) {
    const response = await serverService.query<{ listWorkflows: { items: any[]; nextToken: string | null } }>(
      LIST_WORKFLOWS,
      { orgId, status }
    );
    return response.listWorkflows;
  }

  async listBlueprints(category?: string) {
    const response = await serverService.query<{ listBlueprints: { items: any[]; nextToken: string | null } }>(
      LIST_BLUEPRINTS,
      { category }
    );
    return response.listBlueprints;
  }

  async createWorkflow(input: { name: string; orgId: string; definition: string; description?: string; configuration?: string; isBlueprint?: boolean; metadata?: string }) {
    const response = await serverService.mutate<{ createWorkflow: any }>(
      CREATE_WORKFLOW,
      { input }
    );
    return response.createWorkflow;
  }

  async updateWorkflow(input: { workflowId: string; version: number; name?: string; description?: string; definition?: string; configuration?: string; metadata?: string }) {
    const response = await serverService.mutate<{ updateWorkflow: any }>(
      UPDATE_WORKFLOW,
      { input }
    );
    return response.updateWorkflow;
  }

  async deleteWorkflow(workflowId: string) {
    const response = await serverService.mutate<{ deleteWorkflow: { success: boolean; message?: string } }>(
      DELETE_WORKFLOW,
      { workflowId }
    );
    return response.deleteWorkflow;
  }

  async publishWorkflow(workflowId: string) {
    const response = await serverService.mutate<{ publishWorkflow: any }>(
      PUBLISH_WORKFLOW,
      { workflowId }
    );
    return response.publishWorkflow;
  }

  async updateWorkflowConfiguration(workflowId: string, configuration: string, version: number) {
    const response = await serverService.mutate<{ updateWorkflowConfiguration: any }>(
      UPDATE_WORKFLOW_CONFIGURATION,
      { workflowId, configuration, version }
    );
    return response.updateWorkflowConfiguration;
  }

  async importBlueprint(
    blueprintId: string,
    appId: string,
    name?: string,
    agentMapping?: Record<string, string>
  ) {
    // agentMapping is an AWSJSON scalar on the wire: send it as a JSON string
    // (matches the convention used for `configuration` and agent `config`).
    // The `agentMapping` key is only included when provided so callers that
    // omit it produce identical variables to the pre-remap contract.
    const variables: { blueprintId: string; appId: string; name?: string; agentMapping?: string } = {
      blueprintId,
      appId,
      name,
    };
    if (agentMapping) {
      variables.agentMapping = JSON.stringify(agentMapping);
    }
    const response = await serverService.mutate<{ importBlueprint: any }>(
      IMPORT_BLUEPRINT,
      variables
    );
    return response.importBlueprint;
  }

  async importWorkflow(input: { orgId: string; workflowJson: string; name?: string }) {
    const response = await serverService.mutate<{ importWorkflow: any }>(
      IMPORT_WORKFLOW,
      { input }
    );
    return response.importWorkflow;
  }

  async exportWorkflow(workflowId: string) {
    const response = await serverService.query<{ exportWorkflow: string }>(
      EXPORT_WORKFLOW,
      { workflowId }
    );
    return response.exportWorkflow;
  }

  async getWorkflowVersion(workflowId: string, version: number) {
    const response = await serverService.query<{ getWorkflowVersion: any }>(
      GET_WORKFLOW_VERSION,
      { workflowId, version }
    );
    return response.getWorkflowVersion;
  }

  async listAppWorkflows(appId: string) {
    const response = await serverService.query<{ listAppWorkflows: any[] }>(
      LIST_APP_WORKFLOWS,
      { appId }
    );
    return response.listAppWorkflows;
  }
}

export const workflowApiService = new WorkflowApiService();
