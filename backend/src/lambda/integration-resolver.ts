import { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, DeleteParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { getConnectorSpec, validateCredentials, validateConfiguration } from '../utils/connector-registry';
import { testConnection } from '../utils/connection-tester';
import { 
  validateTransition, 
  getStatusAfterSuccessfulTest, 
  getStatusAfterFailedTest,
  canTest,
  canConnect,
  canDisconnect,
  type IntegrationStatus 
} from '../utils/lifecycle-validator';
import { storeCredentials } from '../utils/credential-manager';
import { createTarget, deleteTarget } from '../utils/gateway-target-manager';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsManager = new SecretsManagerClient({});
const ssm = new SSMClient({});
const eventBridge = new EventBridgeClient({});

const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE!;
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const ACCOUNT_ID = process.env.ACCOUNT_ID || '';
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'citadel-agents-test';

interface AppSyncEventIdentity {
  username?: string;
  sub?: string;
}

interface AppSyncEvent extends Omit<AppSyncResolverEvent<any>, 'identity'> {
  identity?: AppSyncEventIdentity;
}

/**
 * Sanitize event arguments before logging to prevent credential leakage
 * Redacts all sensitive credential fields including IAM role ARNs
 */
function sanitizeEventForLogging(event: AppSyncEvent): any {
  const sensitiveFields = [
    'apitoken',
    'password',
    'clientsecret',
    'token',
    'secret',
    'apikey',
    'executionrolearn', // IAM role ARN for AgentCore types
    'rolearn'
  ];
  
  const sanitizeObject = (obj: any): any => {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item));
    }
    
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveFields.some(field => lowerKey.includes(field));
      
      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  };
  
  return sanitizeObject(event);
}

/**
 * Sanitize Integration object for API response
 * Removes all sensitive credential fields from config
 * Only returns ARNs and masked indicators for credentials
 * Redacts IAM role ARNs and other AgentCore-specific sensitive data
 */
function sanitizeIntegrationForResponse(integration: any): any {
  const sensitiveConfigFields = [
    'apiToken',
    'password',
    'clientSecret',
    'token',
    'secret',
    'apiKey',
    'executionRoleArn', // IAM role ARN for AgentCore types
    'roleArn'
  ];
  
  // Create a copy to avoid mutating the original
  const sanitized = { ...integration };
  
  // Sanitize config object - remove sensitive fields
  if (sanitized.config && typeof sanitized.config === 'object') {
    const sanitizedConfig: any = {};
    
    for (const [key, value] of Object.entries(sanitized.config)) {
      const isSensitive = sensitiveConfigFields.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      );
      
      if (isSensitive) {
        // Replace with masked indicator
        sanitizedConfig[key] = '********';
      } else {
        // Keep non-sensitive config fields (baseUrl, subdomain, etc.)
        sanitizedConfig[key] = value;
      }
    }
    
    sanitized.config = sanitizedConfig;
  }
  
  // Ensure secretArn is present but don't expose the actual secret value
  // The secretArn itself is safe to return as it's just a reference
  
  // Remove any other potentially sensitive fields that shouldn't be in response
  delete sanitized.PK;
  delete sanitized.SK;
  
  return sanitized;
}

export async function handler(event: AppSyncEvent) {
  // Sanitize event for logging - remove sensitive data
  const sanitizedEvent = sanitizeEventForLogging(event);
  console.log('Integration resolver event:', JSON.stringify(sanitizedEvent, null, 2));
  
  const { fieldName } = event.info;
  
  try {
    switch (fieldName) {
      case 'createIntegration':
        return await createIntegration(event.arguments.input, event.identity?.username || 'system');
      case 'updateIntegration':
        return await updateIntegration(event.arguments.input);
      case 'deleteIntegration':
        return await deleteIntegration(event.arguments.integrationId);
      case 'testIntegration':
        return await testIntegration(event.arguments.integrationId);
      case 'connectIntegration':
        return await connectIntegration(event.arguments.integrationId);
      case 'disconnectIntegration':
        return await disconnectIntegration(event.arguments.integrationId);
      case 'listIntegrations':
        return await listIntegrations(event.arguments.orgId, event.arguments.integrationType, event.arguments.status);
      case 'getIntegration':
        const integration = await getIntegration(event.arguments.integrationId);
        return sanitizeIntegrationForResponse(integration);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: any) {
    console.error('Integration resolver error:', error);
    throw error;
  }
}

async function createIntegration(input: any, createdBy: string) {
  const integrationId = uuidv4();
  const timestamp = new Date().toISOString();
  
  // Get connector spec from registry
  const spec = getConnectorSpec(input.integrationType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${input.integrationType}`);
  }
  
  // Validate credentials
  const credValidation = validateCredentials(input.integrationType, input.credentials);
  if (!credValidation.valid) {
    throw new Error(`Invalid credentials: ${credValidation.errors.join(', ')}`);
  }
  
  // Validate configuration
  const configValidation = validateConfiguration(input.integrationType, input.config);
  if (!configValidation.valid) {
    throw new Error(`Invalid configuration: ${configValidation.errors.join(', ')}`);
  }
  
  // Check if this is an AgentCore integration type
  const isAgentCoreType = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'].includes(input.integrationType);
  
  let gatewayTargetId: string | undefined;
  let credentialProviderArn: string | undefined;
  
  try {
    // 1. Store credentials using credential manager
    const { secretArn, ssmParameterPrefix } = await storeCredentials(
      input.integrationType,
      integrationId,
      input.orgId,
      input.credentials,
      input.config
    );
    
    // Also store email in config for display purposes (it's not sensitive)
    if (input.credentials.email) {
      input.config.email = input.credentials.email;
    }
    
    // 2. Create gateway target for AgentCore types
    if (isAgentCoreType) {
      try {
        gatewayTargetId = await createTarget(
          integrationId,
          input.integrationType,
          input.config,
          input.credentials
        );
        
        console.log('Gateway target created:', { 
          integrationId, 
          integrationType: input.integrationType, 
          gatewayTargetId 
        });
      } catch (error: any) {
        console.error('Gateway target creation failed:', {
          integrationId,
          integrationType: input.integrationType,
          error: error.message
        });
        
        // Clean up credentials if gateway target creation fails
        try {
          await secretsManager.send(new DeleteSecretCommand({
            SecretId: secretArn,
            ForceDeleteWithoutRecovery: true
          }));
        } catch (cleanupError) {
          console.warn('Failed to clean up secret after gateway target failure:', cleanupError);
        }
        
        throw new Error(`Failed to create AgentCore Gateway target: ${error.message}`);
      }
    }
    
    // 3. Store integration metadata in DynamoDB
    const integration: any = {
      PK: `ORG#${input.orgId}`,
      SK: `INTEGRATION#${input.integrationType}#${integrationId}`,
      integrationId,
      integrationType: input.integrationType,
      name: input.name,
      status: 'CONFIGURED' as IntegrationStatus,
      orgId: input.orgId,
      createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      config: input.config,
      secretArn,
      ssmParameterPrefix,
      metadata: {
        version: '1.0',
        protocol: isAgentCoreType ? 'MCP' : 'REST',
        provider: spec.provider,
        authMethod: spec.authentication.method
      }
    };
    
    // Add gateway target ID for AgentCore types
    if (gatewayTargetId) {
      integration.gatewayTargetId = gatewayTargetId;
    }
    
    if (credentialProviderArn) {
      integration.credentialProviderArn = credentialProviderArn;
    }
    
    await dynamodb.send(new PutCommand({
      TableName: INTEGRATIONS_TABLE,
      Item: integration
    }));
    
    console.log('Integration created:', { 
      integrationId, 
      integrationType: input.integrationType, 
      orgId: input.orgId,
      gatewayTargetId: gatewayTargetId || 'N/A'
    });
    
    // Return sanitized integration without sensitive credentials
    return sanitizeIntegrationForResponse(integration);
  } catch (error: any) {
    console.error('Integration creation failed:', {
      integrationId,
      integrationType: input.integrationType,
      error: error.message
    });
    throw error;
  }
}

async function updateIntegration(input: any) {
  const integration = await getIntegration(input.integrationId);
  
  // Get connector spec for proper handling
  const spec = getConnectorSpec(integration.integrationType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${integration.integrationType}`);
  }
  
  // Update credentials if provided
  if (input.credentials) {
    // Build secret value based on connector spec
    const secretValue: Record<string, any> = {};
    
    for (const field of spec.authentication.fields) {
      if (input.credentials[field]) {
        secretValue[field] = input.credentials[field];
      }
    }
    
    // Add configuration fields that should be in secret
    for (const configField of spec.configuration.required) {
      const configVal = input.config?.[configField] || integration.config[configField];
      if (configVal) {
        secretValue[configField] = configVal;
      }
    }
    
    // Retrieve existing secret to merge with new values
    const existing = await secretsManager.send(new GetSecretValueCommand({
      SecretId: integration.secretArn
    }));
    
    const existingData = existing.SecretString ? JSON.parse(existing.SecretString) : {};
    const mergedData = { ...existingData, ...secretValue };
    
    await secretsManager.send(new CreateSecretCommand({
      Name: integration.secretArn.split(':').pop()!,
      SecretString: JSON.stringify(mergedData)
    }));
  }
  
  // Update config if provided
  if (input.config) {
    integration.config = { ...integration.config, ...input.config };
    
    // Also store email in config for display purposes if it was updated in credentials
    if (input.credentials?.email) {
      integration.config.email = input.credentials.email;
    }
    
    // Update SSM parameters based on connector spec
    for (const paramName of spec.configuration.ssmParameters) {
      const camelCaseKey = paramName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
      const value = input.config[paramName] || input.config[camelCaseKey];
      
      if (value !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `${integration.ssmParameterPrefix}/${paramName}`,
          Value: typeof value === 'string' ? value : JSON.stringify(value),
          Type: 'String',
          Overwrite: true
        }));
      }
    }
  } else if (input.credentials?.email) {
    // If only credentials were updated (no config), still update email in config
    integration.config = { ...integration.config, email: input.credentials.email };
  }
  
  // Update name and status
  if (input.name) integration.name = input.name;
  
  // Validate status transition if status is being updated
  if (input.status) {
    validateTransition(integration.status as IntegrationStatus, input.status as IntegrationStatus);
    integration.status = input.status;
  }
  
  // If credentials were updated, transition to CONFIGURED
  if (input.credentials && !input.status) {
    validateTransition(integration.status as IntegrationStatus, 'CONFIGURED');
    integration.status = 'CONFIGURED';
  }
  
  // D-02: Optimistic locking — increment version with conditional write
  const currentVersion = integration.version || 0;
  integration.version = currentVersion + 1;
  integration.updatedAt = new Date().toISOString();
  
  try {
    await dynamodb.send(new PutCommand({
      TableName: INTEGRATIONS_TABLE,
      Item: integration,
      ConditionExpression: currentVersion === 0
        ? 'attribute_not_exists(version) OR version = :currentVersion'
        : 'version = :currentVersion',
      ExpressionAttributeValues: {
        ':currentVersion': currentVersion,
      },
    }));
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error(`Conflict: integration ${input.integrationId} was modified concurrently. Please retry.`);
    }
    throw error;
  }
  
  console.log('Integration updated:', { integrationId: input.integrationId, status: integration.status });
  return sanitizeIntegrationForResponse(integration);
}

async function testIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);
  
  // Validate that integration can be tested
  if (!canTest(integration.status as IntegrationStatus)) {
    throw new Error(
      `Cannot test integration in status ${integration.status}. ` +
      `Integration must be in CONFIGURED, TESTED, CONNECTED, DISCONNECTED, or CONNECTION_FAILED status.`
    );
  }
  
  // Retrieve credentials from Secrets Manager
  const secret = await secretsManager.send(new GetSecretValueCommand({
    SecretId: integration.secretArn
  }));
  
  const credentials = JSON.parse(secret.SecretString!);
  
  // For AgentCore types, retrieve config from SSM
  let config = integration.config || {};
  const isAgentCoreType = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'].includes(integration.integrationType);
  
  if (isAgentCoreType && integration.ssmParameterPrefix) {
    const spec = getConnectorSpec(integration.integrationType);
    if (spec && spec.configuration.ssmParameters) {
      for (const paramName of spec.configuration.ssmParameters) {
        try {
          const param = await ssm.send(new GetParameterCommand({
            Name: `${integration.ssmParameterPrefix}/${paramName}`
          }));
          
          // Convert parameter name to camelCase config key
          const configKey = paramName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
          config[configKey] = param.Parameter?.Value;
        } catch (error: any) {
          console.warn(`Failed to retrieve SSM parameter ${paramName}:`, error.message);
        }
      }
    }
  }
  
  // Test connection using the connection tester
  try {
    const testResult = await testConnection(integration.integrationType, credentials, config);
    
    // Update lastTestAt and status based on test result
    integration.lastTestAt = new Date().toISOString();
    
    if (testResult.success) {
      integration.errorMessage = undefined;
      const newStatus = getStatusAfterSuccessfulTest(integration.status as IntegrationStatus);
      validateTransition(integration.status as IntegrationStatus, newStatus);
      integration.status = newStatus;
    } else {
      integration.errorMessage = testResult.message;
      // Status remains unchanged after failed test
      const newStatus = getStatusAfterFailedTest(integration.status as IntegrationStatus);
      integration.status = newStatus;
    }
    
    await dynamodb.send(new PutCommand({
      TableName: INTEGRATIONS_TABLE,
      Item: integration
    }));
    
    console.log('Integration test completed:', { 
      integrationId, 
      integrationType: integration.integrationType,
      success: testResult.success,
      status: integration.status
    });
    
    return testResult;
  } catch (error: any) {
    console.error('Test integration error:', { 
      integrationId,
      integrationType: integration.integrationType,
      error: error.message 
    });
    return {
      success: false,
      message: `Connection error: ${error.message}`,
      details: { error: error.toString() }
    };
  }
}

async function connectIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);
  
  // Validate that integration can be connected
  if (!canConnect(integration.status as IntegrationStatus)) {
    throw new Error(
      `Cannot connect integration in status ${integration.status}. ` +
      `Integration must be in TESTED, CONFIGURED, DISCONNECTED, or CONNECTION_FAILED status.`
    );
  }
  
  try {
    // Validate transition to CONNECTING
    validateTransition(integration.status as IntegrationStatus, 'CONNECTING');
    
    // Publish event to EventBridge for async gateway registration
    await eventBridge.send(new PutEventsCommand({
      Entries: [{
        Source: 'citadel.integrations',
        DetailType: 'integration.connect.requested',
        Detail: JSON.stringify({
          integrationId: integration.integrationId,
          integrationType: integration.integrationType,
          orgId: integration.orgId,
          secretArn: integration.secretArn,
          ssmParameterPrefix: integration.ssmParameterPrefix,
        }),
        EventBusName: EVENT_BUS_NAME,
      }],
    }));
    
    integration.status = 'CONNECTING';
    integration.updatedAt = new Date().toISOString();
    
    await dynamodb.send(new PutCommand({
      TableName: INTEGRATIONS_TABLE,
      Item: integration
    }));
    
    console.log('Integration connect event published:', { integrationId, status: integration.status });
    return sanitizeIntegrationForResponse(integration);
  } catch (error: any) {
    console.error('Failed to publish connect event:', error);
    
    // Validate transition to CONNECTION_FAILED
    validateTransition(integration.status as IntegrationStatus, 'CONNECTION_FAILED');
    integration.status = 'CONNECTION_FAILED';
    integration.errorMessage = `Failed to initiate connection: ${error.message}`;
    integration.updatedAt = new Date().toISOString();
    
    await dynamodb.send(new PutCommand({
      TableName: INTEGRATIONS_TABLE,
      Item: integration
    }));
    
    throw error;
  }
}

async function disconnectIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);
  
  // Validate that integration can be disconnected
  if (!canDisconnect(integration.status as IntegrationStatus)) {
    throw new Error(
      `Cannot disconnect integration in status ${integration.status}. ` +
      `Integration must be in CONNECTED status.`
    );
  }
  
  try {
    // Validate transition to DISCONNECTED
    validateTransition(integration.status as IntegrationStatus, 'DISCONNECTED');
    
    // Publish event to EventBridge for async gateway unregistration
    if (integration.agentCoreRegistered) {
      await eventBridge.send(new PutEventsCommand({
        Entries: [{
          Source: 'citadel.integrations',
          DetailType: 'integration.disconnect.requested',
          Detail: JSON.stringify({
            integrationId: integration.integrationId,
            integrationType: integration.integrationType,
          }),
          EventBusName: EVENT_BUS_NAME,
        }],
      }));
    }
    
    integration.status = 'DISCONNECTED';
    integration.agentCoreRegistered = false;
    integration.updatedAt = new Date().toISOString();
    
    await dynamodb.send(new PutCommand({
      TableName: INTEGRATIONS_TABLE,
      Item: integration
    }));
    
    console.log('Integration disconnect event published:', { integrationId, status: integration.status });
    return sanitizeIntegrationForResponse(integration);
  } catch (error: any) {
    console.error('Failed to publish disconnect event:', error);
    throw error;
  }
}

async function listIntegrations(orgId: string, integrationType?: string, status?: string) {
  const params: any = {
    TableName: INTEGRATIONS_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `ORG#${orgId}`
    }
  };
  
  if (integrationType) {
    params.KeyConditionExpression += ' AND begins_with(SK, :sk)';
    params.ExpressionAttributeValues[':sk'] = `INTEGRATION#${integrationType}#`;
  } else {
    params.KeyConditionExpression += ' AND begins_with(SK, :sk)';
    params.ExpressionAttributeValues[':sk'] = 'INTEGRATION#';
  }
  
  // Add status filter if provided
  if (status) {
    params.FilterExpression = '#status = :status';
    params.ExpressionAttributeNames = { '#status': 'status' };
    params.ExpressionAttributeValues[':status'] = status;
  }
  
  const response = await dynamodb.send(new QueryCommand(params));
  console.log('Listed integrations:', { orgId, count: response.Items?.length || 0, integrationType, status });
  
  // Sanitize all integrations in the list
  const sanitizedItems = (response.Items || []).map(item => sanitizeIntegrationForResponse(item));
  return sanitizedItems;
}

async function getIntegration(integrationId: string) {
  // Query by GSI on integrationId
  const response = await dynamodb.send(new QueryCommand({
    TableName: INTEGRATIONS_TABLE,
    IndexName: 'IntegrationIdIndex',
    KeyConditionExpression: 'integrationId = :id',
    ExpressionAttributeValues: {
      ':id': integrationId
    }
  }));
  
  if (!response.Items || response.Items.length === 0) {
    throw new Error(`Integration not found: ${integrationId}`);
  }
  
  // Return unsanitized for internal use
  // Sanitization happens at the resolver level when returning to client
  return response.Items[0];
}

async function deleteIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);
  
  // Check if this is an AgentCore integration type
  const isAgentCoreType = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'].includes(integration.integrationType);
  
  try {
    // 1. Delete gateway target for AgentCore types
    if (isAgentCoreType && integration.gatewayTargetId) {
      try {
        await deleteTarget(integration.gatewayTargetId);
        console.log('Gateway target deleted:', { 
          integrationId, 
          gatewayTargetId: integration.gatewayTargetId 
        });
      } catch (error: any) {
        console.error('Failed to delete gateway target:', {
          integrationId,
          gatewayTargetId: integration.gatewayTargetId,
          error: error.message
        });
        // Continue with deletion even if gateway target cleanup fails
        // Log for manual cleanup if needed
      }
    }
    
    // 2. Delete from Secrets Manager
    try {
      await secretsManager.send(new DeleteSecretCommand({
        SecretId: integration.secretArn,
        ForceDeleteWithoutRecovery: true
      }));
    } catch (error) {
      console.warn('Failed to delete secret:', error);
    }
    
    // 3. Delete SSM parameters
    try {
      const spec = getConnectorSpec(integration.integrationType);
      if (spec && spec.configuration.ssmParameters) {
        for (const paramName of spec.configuration.ssmParameters) {
          try {
            await ssm.send(new DeleteParameterCommand({ 
              Name: `${integration.ssmParameterPrefix}/${paramName}` 
            }));
          } catch (error) {
            // Parameter might not exist
            console.warn(`Failed to delete SSM parameter ${paramName}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to delete SSM parameters:', error);
    }
    
    // 4. Delete from DynamoDB
    await dynamodb.send(new DeleteCommand({
      TableName: INTEGRATIONS_TABLE,
      Key: {
        PK: integration.PK,
        SK: integration.SK
      }
    }));
    
    console.log('Integration deleted:', { integrationId, integrationType: integration.integrationType });
    return {
      success: true,
      message: 'Integration deleted successfully'
    };
  } catch (error: any) {
    console.error('Integration deletion failed:', {
      integrationId,
      integrationType: integration.integrationType,
      error: error.message
    });
    throw error;
  }
}

async function registerConfluenceWithAgentCore(integration: any) {
  const secret = await secretsManager.send(new GetSecretValueCommand({
    SecretId: integration.secretArn
  }));
  const credentials = JSON.parse(secret.SecretString!);
  
  // Create SSM parameters for AgentCore Gateway
  const schemaUri = `s3://citadel-schemas-${ACCOUNT_ID}-${REGION}/confluence-openapi.json`;
  const credentialProviderName = `confluence-${integration.integrationId}-${ENVIRONMENT}`;
  
  // Store gateway parameters
  await ssm.send(new PutParameterCommand({
    Name: `/citadel/gateway/confluence-schema-uri-${integration.integrationId}`,
    Value: schemaUri,
    Type: 'String',
    Overwrite: true
  }));
  
  // Store credential reference for AgentCore
  await ssm.send(new PutParameterCommand({
    Name: `/citadel/gateway/confluence-credential-${integration.integrationId}`,
    Value: JSON.stringify({
      baseUrl: credentials.baseUrl,
      email: credentials.email,
      secretArn: integration.secretArn
    }),
    Type: 'SecureString',
    Overwrite: true
  }));
  
  console.log('Registered Confluence with AgentCore:', { 
    integrationId: integration.integrationId,
    schemaUri,
    credentialProviderName
  });
}

async function unregisterFromAgentCore(integration: any) {
  // Delete AgentCore SSM parameters
  try {
    await ssm.send(new DeleteParameterCommand({
      Name: `/citadel/gateway/confluence-schema-uri-${integration.integrationId}`
    }));
  } catch (error) {
    console.warn('Failed to delete schema URI parameter:', error);
  }
  
  try {
    await ssm.send(new DeleteParameterCommand({
      Name: `/citadel/gateway/confluence-credential-${integration.integrationId}`
    }));
  } catch (error) {
    console.warn('Failed to delete credential parameter:', error);
  }
  
  console.log('Unregistered from AgentCore:', { integrationId: integration.integrationId });
}
