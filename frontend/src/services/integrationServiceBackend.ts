import { generateClient } from 'aws-amplify/api';

const client = generateClient();

export interface Integration {
  integrationId: string;
  name: string;
  integrationType: string;
  orgId: string;
  status: string;
  config: any;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  /**
   * AgentCore Identity callback URL — populated on createIntegration for
   * OAuth2 MCP_SERVER integrations. The user must register this URL with
   * their OAuth provider as a redirect URI.
   */
  agentCoreCallbackUrl?: string;
  /**
   * 3LO authorization endpoint with state — populated by connectIntegration
   * when the integration's grant type requires user redirect.
   */
  authorizationUrl?: string;
  /** AgentCore credential provider ARN (CRP) for the integration. */
  credentialProviderArn?: string;
  /**
   * Lifecycle target status; currently exposed by the schema for OAuth2 flows
   * (e.g., `CREATE_PENDING_AUTH` when the user must complete 3LO).
   */
  targetStatus?: string;
}

const listIntegrationsQuery = `
  query ListIntegrations($orgId: String!, $status: IntegrationStatus) {
    listIntegrations(orgId: $orgId, status: $status) {
      integrationId
      name
      integrationType
      orgId
      status
      config
      createdAt
      updatedAt
      errorMessage
    }
  }
`;

const createIntegrationMutation = `
  mutation CreateIntegration($input: CreateIntegrationInput!) {
    createIntegration(input: $input) {
      integrationId
      name
      integrationType
      orgId
      status
      config
      createdAt
      updatedAt
      agentCoreCallbackUrl
      credentialProviderArn
      targetStatus
    }
  }
`;

const updateIntegrationMutation = `
  mutation UpdateIntegration($input: UpdateIntegrationInput!) {
    updateIntegration(input: $input) {
      integrationId
      name
      status
      config
      updatedAt
    }
  }
`;

const connectIntegrationMutation = `
  mutation ConnectIntegration($integrationId: ID!) {
    connectIntegration(integrationId: $integrationId) {
      integrationId
      status
      updatedAt
      authorizationUrl
      targetStatus
    }
  }
`;

const disconnectIntegrationMutation = `
  mutation DisconnectIntegration($integrationId: ID!) {
    disconnectIntegration(integrationId: $integrationId) {
      integrationId
      status
      updatedAt
    }
  }
`;

const deleteIntegrationMutation = `
  mutation DeleteIntegration($integrationId: ID!) {
    deleteIntegration(integrationId: $integrationId) {
      success
      message
    }
  }
`;

const testIntegrationMutation = `
  mutation TestIntegration($integrationId: ID!) {
    testIntegration(integrationId: $integrationId) {
      success
      message
      details
    }
  }
`;

export const integrationServiceBackend = {
  async listIntegrations(orgId: string = 'default', status?: string): Promise<Integration[]> {
    const variables: Record<string, string> = { orgId };
    if (status) {
      variables.status = status;
    }
    const response: any = await client.graphql({
      query: listIntegrationsQuery,
      variables
    });
    return response.data.listIntegrations || [];
  },

  async createIntegration(input: any): Promise<Integration> {
    try {
      // Convert config and credentials to JSON strings if they're objects
      const processedInput = {
        ...input,
        config: typeof input.config === 'string' ? input.config : JSON.stringify(input.config),
        credentials: typeof input.credentials === 'string' ? input.credentials : JSON.stringify(input.credentials)
      };
      
      console.log('Creating integration with input:', JSON.stringify(processedInput, null, 2));
      const response: any = await client.graphql({
        query: createIntegrationMutation,
        variables: { input: processedInput }
      });
      console.log('Create integration response:', JSON.stringify(response, null, 2));
      return response.data.createIntegration;
    } catch (error: any) {
      console.error('Create integration error:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      throw new Error(error.errors?.[0]?.message || error.message || 'Failed to create integration');
    }
  },

  async updateIntegration(input: any): Promise<Integration> {
    const response: any = await client.graphql({
      query: updateIntegrationMutation,
      variables: { input }
    });
    return response.data.updateIntegration;
  },

  async connectIntegration(integrationId: string): Promise<Integration> {
    const response: any = await client.graphql({
      query: connectIntegrationMutation,
      variables: { integrationId }
    });
    return response.data.connectIntegration;
  },

  async disconnectIntegration(integrationId: string): Promise<Integration> {
    const response: any = await client.graphql({
      query: disconnectIntegrationMutation,
      variables: { integrationId }
    });
    return response.data.disconnectIntegration;
  },

  async deleteIntegration(integrationId: string): Promise<{ success: boolean; message: string }> {
    const response: any = await client.graphql({
      query: deleteIntegrationMutation,
      variables: { integrationId }
    });
    return response.data.deleteIntegration;
  },

  async testIntegration(integrationId: string): Promise<{ success: boolean; message: string; details?: any }> {
    console.log('testIntegration called with:', integrationId);
    try {
      const response: any = await client.graphql({
        query: testIntegrationMutation,
        variables: { integrationId }
      });
      console.log('testIntegration response:', response);
      return response.data.testIntegration;
    } catch (error: any) {
      console.error('testIntegration error:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      throw error;
    }
  }
};
