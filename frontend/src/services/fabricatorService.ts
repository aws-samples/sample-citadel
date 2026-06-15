import serverService from './server';
import { IntegrationBinding, DataStoreBinding } from './toolConfigService';

export interface CreateAgentRequest {
  agentName: string;
  taskDescription: string;
  tools?: string[];
  integrations?: string[];
  dataStores?: string[];
}

export interface CreateToolRequest {
  toolName: string;
  toolDescription: string;
  integrationBindings?: IntegrationBinding[];
  dataStoreBindings?: DataStoreBinding[];
}

export interface AgentCreationResponse {
  success: boolean;
  requestId: string;
  message?: string;
}

export interface ToolCreationResponse {
  success: boolean;
  requestId: string;
  message?: string;
}

const requestAgentCreationMutation = `
  mutation RequestAgentCreation($input: CreateAgentRequestInput!) {
    requestAgentCreation(input: $input) {
      success
      requestId
      message
    }
  }
`;

const requestToolCreationMutation = `
  mutation RequestToolCreation($input: CreateToolRequestInput!) {
    requestToolCreation(input: $input) {
      success
      requestId
      message
    }
  }
`;

export const fabricatorService = {
  async requestAgentCreation(input: CreateAgentRequest): Promise<AgentCreationResponse> {
    try {
      console.log('Sending agent creation request to Fabricator:', input);
      
      const response = await serverService.mutate<{ requestAgentCreation: AgentCreationResponse }>(
        requestAgentCreationMutation,
        { input }
      );
      
      console.log('Fabricator response:', response.requestAgentCreation);
      return response.requestAgentCreation;
    } catch (error) {
      console.error('Error requesting agent creation:', error);
      throw error;
    }
  },

  async requestToolCreation(input: CreateToolRequest): Promise<ToolCreationResponse> {
    try {
      console.log('Sending tool creation request to Fabricator:', input);
      
      const response = await serverService.mutate<{ requestToolCreation: ToolCreationResponse }>(
        requestToolCreationMutation,
        { input }
      );
      
      console.log('Fabricator response:', response.requestToolCreation);
      return response.requestToolCreation;
    } catch (error) {
      console.error('Error requesting tool creation:', error);
      throw error;
    }
  },
};
