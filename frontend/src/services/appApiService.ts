/**
 * App API Service
 * Handles all Agent App GraphQL operations via AppSync
 */

import serverService from './server';

// --- Exported Types ---

/**
 * Base API key record — used by listAppApiKeys, revokeAppApiKey, and key
 * row rendering. NEVER carries plaintext.
 */
export interface AppApiKey {
  keyId: string;
  name: string;
  prefix: string;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

/**
 * Response-only extension returned by createAppApiKey and rotateAppApiKey.
 * Carries the full plaintext API key, which is shown to the user exactly
 * once at creation or rotation time and is never persisted in retrievable
 * form. List rendering code MUST NOT depend on this type.
 */
export interface AppApiKeyWithPlaintext extends AppApiKey {
  /** Plaintext API key (32-byte base64url). Shown exactly once. */
  apiKey: string;
}

// --- GraphQL Queries ---

const GET_APP = `
  query GetApp($appId: ID!) {
    getApp(appId: $appId) {
      appId
      orgId
      name
      description
      status
      workflowIds
      routingConfig
      createdBy
      createdByName
      createdAt
      updatedAt
      version
      agentBindings {
        agentId
        name
        status
        systemPromptAddition
        toolRestrictions
        modelOverride
        addedAt
      }
      permissions {
        permissionId
        actions
        resources
        description
      }
      configSchema
      configValues
      endpointUrl
    }
  }
`;

const LIST_APPS = `
  query ListApps($orgId: String!) {
    listApps(orgId: $orgId) {
      items {
        appId
        orgId
        name
        description
        status
        workflowIds
        routingConfig
        createdBy
        createdByName
        createdAt
        updatedAt
        version
      }
      nextToken
    }
  }
`;

// --- GraphQL Mutations ---

const CREATE_APP = `
  mutation CreateApp($input: CreateAppInput!) {
    createApp(input: $input) {
      appId
      orgId
      name
      description
      status
      workflowIds
      routingConfig
      createdBy
      createdAt
      updatedAt
      version
    }
  }
`;

const UPDATE_APP = `
  mutation UpdateApp($input: UpdateAppInput!) {
    updateApp(input: $input) {
      appId
      orgId
      name
      description
      status
      workflowIds
      routingConfig
      createdBy
      createdAt
      updatedAt
      version
    }
  }
`;

const DELETE_APP = `
  mutation DeleteApp($appId: ID!) {
    deleteApp(appId: $appId) {
      success
      message
    }
  }
`;

const BIND_WORKFLOW_TO_APP = `
  mutation BindWorkflowToApp($appId: ID!, $workflowId: ID!) {
    bindWorkflowToApp(appId: $appId, workflowId: $workflowId) {
      appId
      orgId
      name
      description
      status
      workflowIds
      routingConfig
      createdBy
      createdAt
      updatedAt
      version
    }
  }
`;

const UNBIND_WORKFLOW_FROM_APP = `
  mutation UnbindWorkflowFromApp($appId: ID!, $workflowId: ID!) {
    unbindWorkflowFromApp(appId: $appId, workflowId: $workflowId) {
      appId
      orgId
      name
      description
      status
      workflowIds
      routingConfig
      createdBy
      createdAt
      updatedAt
      version
    }
  }
`;

const ADD_APP_COMPONENT = `
  mutation AddAppComponent($appId: ID!, $component: RegistryAgentComponentInput!) {
    addAppComponent(appId: $appId, component: $component) {
      appId
      name
      status
      version
    }
  }
`;

const SET_APP_CONFIG_SCHEMA = `
  mutation SetAppConfigSchema($appId: ID!, $schema: AWSJSON!, $version: Int!) {
    setAppConfigSchema(appId: $appId, schema: $schema, version: $version) {
      appId
      name
      status
      version
    }
  }
`;

const SET_APP_CONFIG_VALUES = `
  mutation SetAppConfigValues($appId: ID!, $values: AWSJSON!, $version: Int!) {
    setAppConfigValues(appId: $appId, values: $values, version: $version) {
      appId
      name
      status
      version
    }
  }
`;

const REMOVE_APP_COMPONENT = `
  mutation RemoveAppComponent($appId: ID!, $componentType: String!, $componentId: String!) {
    removeAppComponent(appId: $appId, componentType: $componentType, componentId: $componentId) {
      appId
      name
      status
      version
    }
  }
`;

const UPDATE_AGENT_BINDING = `
  mutation UpdateAgentBinding($input: UpdateRegistryAgentBindingInput!) {
    updateAgentBinding(input: $input) {
      appId
      name
      status
      version
    }
  }
`;

// --- Publishing Mutations ---

const PUBLISH_APP = `
  mutation PublishApp($appId: ID!) {
    publishApp(appId: $appId) {
      app {
        appId
        orgId
        name
        description
        status
        endpointUrl
        apiId
        authMode
        workflowIds
        createdBy
        createdAt
        updatedAt
        version
      }
      endpointUrl
      apiKey
      apiKeyId
    }
  }
`;

const UNPUBLISH_APP = `
  mutation UnpublishApp($appId: ID!) {
    unpublishApp(appId: $appId) {
      appId
      orgId
      name
      description
      status
      workflowIds
      createdBy
      createdAt
      updatedAt
      version
    }
  }
`;

// --- API Key Mutations ---

const CREATE_APP_API_KEY = `
  mutation CreateAppApiKey($appId: ID!, $name: String!, $expiresIn: Int) {
    createAppApiKey(appId: $appId, name: $name, expiresIn: $expiresIn) {
      keyId
      name
      prefix
      status
      createdAt
      expiresAt
      lastUsedAt
      apiKey
    }
  }
`;

const REVOKE_APP_API_KEY = `
  mutation RevokeAppApiKey($appId: ID!, $keyId: ID!) {
    revokeAppApiKey(appId: $appId, keyId: $keyId) {
      keyId
      name
      prefix
      status
      createdAt
      expiresAt
      lastUsedAt
    }
  }
`;

const ROTATE_APP_API_KEY = `
  mutation RotateAppApiKey($appId: ID!, $keyId: ID!) {
    rotateAppApiKey(appId: $appId, keyId: $keyId) {
      keyId
      name
      prefix
      status
      createdAt
      expiresAt
      lastUsedAt
      apiKey
    }
  }
`;

// --- API Key & Metrics Queries ---

const LIST_APP_API_KEYS = `
  query ListAppApiKeys($appId: ID!) {
    listAppApiKeys(appId: $appId) {
      keyId
      name
      prefix
      status
      createdAt
      expiresAt
      lastUsedAt
    }
  }
`;

const GET_APP_METRICS = `
  query GetAppMetrics($appId: ID!, $startTime: AWSDateTime!, $endTime: AWSDateTime!) {
    getAppMetrics(appId: $appId, startTime: $startTime, endTime: $endTime) {
      totalRequests
      successCount
      clientErrorCount
      serverErrorCount
      p50Latency
      p95Latency
      p99Latency
      timeSeries {
        timestamp
        requestCount
        errorCount
        avgLatency
      }
    }
  }
`;

const GET_DASHBOARD_METRICS = `
  query GetDashboardMetrics($orgId: String!, $startTime: AWSDateTime!, $endTime: AWSDateTime!) {
    getDashboardMetrics(orgId: $orgId, startTime: $startTime, endTime: $endTime) {
      dailyActivity {
        date
        successCount
        errorCount
      }
      totalRequests
      successRate
      avgLatency
    }
  }
`;

const GET_RECENT_ACTIVITY = `
  query GetRecentActivity($orgId: String!, $limit: Int) {
    getRecentActivity(orgId: $orgId, limit: $limit) {
      items {
        entityType
        entityId
        title
        description
        timestamp
      }
    }
  }
`;

// --- Auth Config Mutation ---

const SET_APP_AUTH_CONFIG = `
  mutation SetAppAuthConfig($appId: ID!, $authConfig: AWSJSON!) {
    setAppAuthConfig(appId: $appId, authConfig: $authConfig) {
      appId
      name
      status
      version
    }
  }
`;

// --- Access Control Mutations & Queries ---

const GRANT_APP_ACCESS = `
  mutation GrantAppAccess($appId: ID!, $userId: String!, $role: String!) {
    grantAppAccess(appId: $appId, userId: $userId, role: $role) {
      appId
      name
      status
      version
    }
  }
`;

const REVOKE_APP_ACCESS = `
  mutation RevokeAppAccess($appId: ID!, $userId: String!) {
    revokeAppAccess(appId: $appId, userId: $userId) {
      appId
      name
      status
      version
    }
  }
`;

const LIST_APP_ACCESS_ENTRIES = `
  query ListAppAccessEntries($appId: ID!) {
    listAppAccessEntries(appId: $appId) {
      userId
      role
      grantedBy
      grantedAt
    }
  }
`;

/**
 * App API Service Class
 * Handles all Agent App GraphQL operations
 */
class AppApiService {
  async getApp(appId: string) {
    const response = await serverService.query<{ getApp: any }>(
      GET_APP,
      { appId }
    );
    return response.getApp;
  }

  async listApps(orgId: string) {
    const response = await serverService.query<{ listApps: { items: any[]; nextToken: string | null } }>(
      LIST_APPS,
      { orgId }
    );
    return response.listApps;
  }

  async createApp(input: { name: string; orgId: string; description?: string }) {
    const response = await serverService.mutate<{ createApp: any }>(
      CREATE_APP,
      { input }
    );
    return response.createApp;
  }

  async updateApp(input: { appId: string; version: number; name?: string; description?: string; status?: string; routingConfig?: string }) {
    const response = await serverService.mutate<{ updateApp: any }>(
      UPDATE_APP,
      { input }
    );
    return response.updateApp;
  }

  async deleteApp(appId: string) {
    const response = await serverService.mutate<{ deleteApp: { success: boolean; message?: string } }>(
      DELETE_APP,
      { appId }
    );
    return response.deleteApp;
  }

  async bindWorkflowToApp(appId: string, workflowId: string) {
    const response = await serverService.mutate<{ bindWorkflowToApp: any }>(
      BIND_WORKFLOW_TO_APP,
      { appId, workflowId }
    );
    return response.bindWorkflowToApp;
  }

  async unbindWorkflowFromApp(appId: string, workflowId: string) {
    const response = await serverService.mutate<{ unbindWorkflowFromApp: any }>(
      UNBIND_WORKFLOW_FROM_APP,
      { appId, workflowId }
    );
    return response.unbindWorkflowFromApp;
  }

  async addAppComponent(appId: string, component: { type: string; data: string }) {
    const response = await serverService.mutate<{ addAppComponent: any }>(
      ADD_APP_COMPONENT,
      { appId, component }
    );
    return response.addAppComponent;
  }

  async setAppConfigSchema(appId: string, schema: string, version: number) {
    const response = await serverService.mutate<{ setAppConfigSchema: any }>(
      SET_APP_CONFIG_SCHEMA,
      { appId, schema, version }
    );
    return response.setAppConfigSchema;
  }

  async setAppConfigValues(appId: string, values: string, version: number) {
    const response = await serverService.mutate<{ setAppConfigValues: any }>(
      SET_APP_CONFIG_VALUES,
      { appId, values, version }
    );
    return response.setAppConfigValues;
  }

  async removeAppComponent(appId: string, componentType: string, componentId: string) {
    const response = await serverService.mutate<{ removeAppComponent: any }>(
      REMOVE_APP_COMPONENT,
      { appId, componentType, componentId }
    );
    return response.removeAppComponent;
  }

  async updateAgentBinding(input: {
    appId: string;
    agentId: string;
    systemPromptAddition?: string;
    toolRestrictions?: string[];
    modelOverride?: string;
    status?: string;
  }) {
    const response = await serverService.mutate<{ updateAgentBinding: any }>(
      UPDATE_AGENT_BINDING,
      { input }
    );
    return response.updateAgentBinding;
  }

  // --- Publishing ---

  async publishApp(appId: string) {
    const response = await serverService.mutate<{ publishApp: any }>(
      PUBLISH_APP,
      { appId }
    );
    return response.publishApp;
  }

  async unpublishApp(appId: string) {
    const response = await serverService.mutate<{ unpublishApp: any }>(
      UNPUBLISH_APP,
      { appId }
    );
    return response.unpublishApp;
  }

  // --- API Key Management ---

  async createAppApiKey(
    appId: string,
    name: string,
    expiresIn?: number
  ): Promise<AppApiKeyWithPlaintext> {
    const response = await serverService.mutate<{ createAppApiKey: AppApiKeyWithPlaintext }>(
      CREATE_APP_API_KEY,
      { appId, name, expiresIn }
    );
    return response.createAppApiKey;
  }

  async revokeAppApiKey(appId: string, keyId: string): Promise<AppApiKey> {
    const response = await serverService.mutate<{ revokeAppApiKey: AppApiKey }>(
      REVOKE_APP_API_KEY,
      { appId, keyId }
    );
    return response.revokeAppApiKey;
  }

  async rotateAppApiKey(appId: string, keyId: string): Promise<AppApiKeyWithPlaintext> {
    const response = await serverService.mutate<{ rotateAppApiKey: AppApiKeyWithPlaintext }>(
      ROTATE_APP_API_KEY,
      { appId, keyId }
    );
    return response.rotateAppApiKey;
  }

  async listAppApiKeys(appId: string): Promise<AppApiKey[]> {
    const response = await serverService.query<{ listAppApiKeys: AppApiKey[] }>(
      LIST_APP_API_KEYS,
      { appId }
    );
    return response.listAppApiKeys;
  }

  async getAppMetrics(appId: string, startTime: string, endTime: string) {
    const response = await serverService.query<{ getAppMetrics: any }>(
      GET_APP_METRICS,
      { appId, startTime, endTime }
    );
    return response.getAppMetrics;
  }

  async getDashboardMetrics(orgId: string, startTime: string, endTime: string) {
    const response = await serverService.query<{ getDashboardMetrics: any }>(
      GET_DASHBOARD_METRICS,
      { orgId, startTime, endTime }
    );
    return response.getDashboardMetrics;
  }

  async getRecentActivity(orgId: string, limit?: number) {
    const response = await serverService.query<{ getRecentActivity: any }>(
      GET_RECENT_ACTIVITY,
      { orgId, limit: limit || 10 }
    );
    return response.getRecentActivity;
  }

  // --- Auth Config ---

  async setAppAuthConfig(appId: string, authConfig: string) {
    const response = await serverService.mutate<{ setAppAuthConfig: any }>(
      SET_APP_AUTH_CONFIG,
      { appId, authConfig }
    );
    return response.setAppAuthConfig;
  }

  // --- Access Control ---

  async grantAppAccess(appId: string, userId: string, role: string) {
    const response = await serverService.mutate<{ grantAppAccess: any }>(
      GRANT_APP_ACCESS,
      { appId, userId, role }
    );
    return response.grantAppAccess;
  }

  async revokeAppAccess(appId: string, userId: string) {
    const response = await serverService.mutate<{ revokeAppAccess: any }>(
      REVOKE_APP_ACCESS,
      { appId, userId }
    );
    return response.revokeAppAccess;
  }

  async listAppAccessEntries(appId: string) {
    const response = await serverService.query<{ listAppAccessEntries: any[] }>(
      LIST_APP_ACCESS_ENTRIES,
      { appId }
    );
    return response.listAppAccessEntries;
  }
}

export const appApiService = new AppApiService();
