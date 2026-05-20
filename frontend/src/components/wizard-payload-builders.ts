import { CreateToolRequest } from '../services/fabricatorService';

interface DataStoreToolPayloadParams {
  toolName: string;
  toolDescription: string;
  dataStoreId: string;
  dataStoreType: string;
  operations: string[];
}

interface IntegrationToolPayloadParams {
  toolName: string;
  toolDescription: string;
  integrationId: string;
  integrationType: string;
  operations: string[];
}

export function buildDataStoreToolPayload(params: DataStoreToolPayloadParams): CreateToolRequest {
  return {
    toolName: params.toolName,
    toolDescription: `${params.toolDescription}\nData Store Type: ${params.dataStoreType}\nOperations: ${params.operations.join(', ')}`,
    dataStoreBindings: [{
      dataStoreId: params.dataStoreId,
      dataStoreType: params.dataStoreType,
      operations: params.operations,
    }],
  };
}

export function buildIntegrationToolPayload(params: IntegrationToolPayloadParams): CreateToolRequest {
  return {
    toolName: params.toolName,
    toolDescription: `${params.toolDescription}\nIntegration Type: ${params.integrationType}\nOperations: ${params.operations.join(', ')}`,
    integrationBindings: [{
      integrationId: params.integrationId,
      integrationType: params.integrationType,
      operations: params.operations,
    }],
  };
}
