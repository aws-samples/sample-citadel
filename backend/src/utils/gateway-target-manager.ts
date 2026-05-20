/**
 * Gateway Target Manager
 * 
 * Manages AgentCore Gateway targets for Lambda, Smithy, and MCP Server integrations.
 */

import { 
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  GetGatewayTargetCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getConnectorSpec } from './connector-registry';

export interface GatewayTargetConfig {
  gatewayId: string;
  targetType: 'lambda' | 'smithyModel' | 'mcpServer';
  targetPayload: any;
  credentials?: any;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

/**
 * Validate tool schema structure
 */
export function validateToolSchema(schema: any): void {
  if (!schema.name || typeof schema.name !== 'string') {
    throw new Error('Tool schema must include "name" field');
  }
  
  if (!schema.description || typeof schema.description !== 'string') {
    throw new Error('Tool schema must include "description" field');
  }
  
  if (!schema.inputSchema || typeof schema.inputSchema !== 'object') {
    throw new Error('Tool schema must include "inputSchema" field');
  }
  
  // Validate inputSchema is valid JSON Schema
  if (schema.inputSchema.type !== 'object') {
    throw new Error('Tool schema inputSchema must be of type "object"');
  }
}

/**
 * Create AgentCore Gateway target
 */
export async function createTarget(
  integrationId: string,
  connectorType: string,
  config: any,
  credentials: any
): Promise<string> {
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${connectorType}`);
  }
  
  // Get gateway configuration from environment
  const gatewayId = process.env.AGENTCORE_GATEWAY_ID;
  if (!gatewayId) {
    throw new Error('AgentCore Gateway not configured. Please set AGENTCORE_GATEWAY_ID environment variable');
  }
  
  // Build target payload based on connector type
  let targetPayload: any;
  let targetCredentials: any;
  
  switch (connectorType) {
    case 'AWS_LAMBDA':
      targetPayload = await buildLambdaTargetPayload(config);
      targetCredentials = buildIAMRoleCredentials();
      break;
      
    case 'AWS_SMITHY':
      targetPayload = buildSmithyTargetPayload(config);
      targetCredentials = buildIAMRoleCredentials();
      break;
      
    case 'MCP_SERVER':
      const mcpResult = await buildMCPServerTargetPayload(integrationId, config, credentials);
      targetPayload = mcpResult.payload;
      targetCredentials = mcpResult.credentials;
      break;
      
    default:
      throw new Error(`Unsupported connector type: ${connectorType}`);
  }
  
  // Call AgentCore Gateway API
  const agentCoreClient = new BedrockAgentCoreControlClient({
    region: config.region || process.env.AWS_REGION
  });
  
  const response = await agentCoreClient.send(new CreateGatewayTargetCommand({
    gatewayIdentifier: gatewayId,
    name: `integration-${integrationId}`,
    targetConfiguration: targetPayload,
    credentialProviderConfigurations: targetCredentials
  }));
  
  console.log('Gateway target created:', { 
    integrationId, 
    connectorType, 
    targetId: response.targetId 
  });
  
  return response.targetId!;
}

/**
 * Delete AgentCore Gateway target
 */
export async function deleteTarget(targetId: string): Promise<void> {
  const gatewayId = process.env.AGENTCORE_GATEWAY_ID;
  if (!gatewayId) {
    throw new Error('AgentCore Gateway not configured. Please set AGENTCORE_GATEWAY_ID environment variable');
  }
  
  const agentCoreClient = new BedrockAgentCoreControlClient({
    region: process.env.AWS_REGION
  });
  
  await agentCoreClient.send(new DeleteGatewayTargetCommand({
    gatewayIdentifier: gatewayId,
    targetId
  }));
  
  console.log('Gateway target deleted:', { targetId });
}

/**
 * Get AgentCore Gateway target
 */
export async function getTarget(targetId: string): Promise<any> {
  const gatewayId = process.env.AGENTCORE_GATEWAY_ID;
  if (!gatewayId) {
    throw new Error('AgentCore Gateway not configured. Please set AGENTCORE_GATEWAY_ID environment variable');
  }
  
  const agentCoreClient = new BedrockAgentCoreControlClient({
    region: process.env.AWS_REGION
  });
  
  const response = await agentCoreClient.send(new GetGatewayTargetCommand({
    gatewayIdentifier: gatewayId,
    targetId
  }));
  
  return response;
}

/**
 * Build Lambda target payload
 */
async function buildLambdaTargetPayload(config: any): Promise<any> {
  // Parse and validate tool schema
  const toolSchema = JSON.parse(config.toolSchema);
  validateToolSchema(toolSchema);
  
  return {
    mcp: {
      lambda: {
        lambdaArn: config.lambdaArn,
        toolSchema: {
          inlinePayload: [toolSchema]
        }
      }
    }
  };
}

/**
 * Build Smithy target payload
 */
function buildSmithyTargetPayload(config: any): any {
  return {
    mcp: {
      smithyModel: {
        // AgentCore Gateway has pre-configured Smithy models
        // We just need to specify the service type
        serviceType: config.serviceType
      }
    }
  };
}

/**
 * Build MCP Server target payload and credentials
 */
async function buildMCPServerTargetPayload(
  integrationId: string,
  config: any,
  credentials: any
): Promise<{ payload: any; credentials: any }> {
  const payload = {
    mcp: {
      mcpServer: {
        serverUrl: config.serverUrl
      }
    }
  };
  
  // Build credentials based on auth method
  let targetCredentials: any;
  
  if (credentials.authMethod === 'API_KEY') {
    targetCredentials = [{
      credentialProviderType: 'API_KEY',
      credentialProvider: {
        apiKeyCredentialProvider: {
          providerArn: await createCredentialProvider(
            integrationId,
            'API_KEY',
            credentials.apiKey
          ),
          credentialLocation: 'HEADER',
          credentialParameterName: 'Authorization',
          credentialPrefix: 'Bearer'
        }
      }
    }];
  } else if (credentials.authMethod === 'OAUTH2') {
    targetCredentials = [{
      credentialProviderType: 'OAUTH',
      credentialProvider: {
        oauthCredentialProvider: {
          providerArn: await createCredentialProvider(
            integrationId,
            'OAUTH2',
            {
              clientId: credentials.clientId,
              clientSecret: credentials.clientSecret
            }
          ),
          scopes: []
        }
      }
    }];
  } else {
    // CUSTOM auth method - no credential provider needed
    targetCredentials = [];
  }
  
  return { payload, credentials: targetCredentials };
}

/**
 * Build IAM role credentials for Lambda and Smithy
 */
function buildIAMRoleCredentials(): any {
  return [{
    credentialProviderType: 'GATEWAY_IAM_ROLE'
  }];
}

/**
 * Create credential provider in AgentCore Identity
 * This stores the credentials securely and returns an ARN
 */
async function createCredentialProvider(
  integrationId: string,
  type: 'API_KEY' | 'OAUTH2',
  credentials: any
): Promise<string> {
  // For now, return a placeholder ARN
  // In a real implementation, this would call AgentCore Identity API
  // to create a credential provider and return the ARN
  
  // TODO: Implement actual credential provider creation
  // const identityClient = new BedrockAgentCoreIdentityClient({
  //   region: process.env.AWS_REGION
  // });
  
  if (type === 'API_KEY') {
    // Placeholder ARN format
    return `arn:aws:bedrock:${process.env.AWS_REGION}:${process.env.ACCOUNT_ID}:credential-provider/integration-${integrationId}-api-key`;
  } else {
    // Placeholder ARN format
    return `arn:aws:bedrock:${process.env.AWS_REGION}:${process.env.ACCOUNT_ID}:credential-provider/integration-${integrationId}-oauth`;
  }
}
