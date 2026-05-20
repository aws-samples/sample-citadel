import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreControlClient, CreateGatewayTargetCommand, DeleteGatewayTargetCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { IdempotencyGuard } from '../utils/idempotency';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrockAgentCore = new BedrockAgentCoreControlClient({});
const ssm = new SSMClient({});
const idempotencyGuard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const REGION = process.env.AWS_REGION || 'us-west-2';
const ACCOUNT_ID = process.env.ACCOUNT_ID || '';
const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE || '';
const GATEWAY_ID_PARAM = process.env.GATEWAY_ID_PARAM || '';

let cachedGatewayId: string | undefined;

async function getGatewayId(): Promise<string> {
  if (cachedGatewayId) return cachedGatewayId;
  const resp = await ssm.send(new GetParameterCommand({ Name: GATEWAY_ID_PARAM }));
  cachedGatewayId = resp.Parameter?.Value || '';
  return cachedGatewayId;
}

interface IntegrationEvent {
  integrationId: string;
  integrationType: string;
  orgId: string;
  secretArn?: string;
  ssmParameterPrefix?: string;
}

export async function handler(event: EventBridgeEvent<string, IntegrationEvent>) {
  console.log('Gateway registration event:', JSON.stringify(event, null, 2));
  
  const { detail, 'detail-type': detailType } = event;

  // D-03: Use integrationId as idempotency key (not event.id) to handle race conditions
  const idempotencyKey = `${detailType}:${detail.integrationId}`;
  const { executed } = await idempotencyGuard.withIdempotency(idempotencyKey, async () => {
    try {
      if (detailType === 'integration.connect.requested') {
        await handleConnect(detail);
      } else if (detailType === 'integration.disconnect.requested') {
        await handleDisconnect(detail);
      }
    } catch (error: any) {
      console.error('Gateway registration error:', error);
      throw error;
    }
  });

  if (!executed) {
    console.log('Skipping duplicate gateway registration event for integration:', detail.integrationId);
  }
}

async function handleConnect(detail: IntegrationEvent) {
  console.log('Registering integration with AgentCore:', detail.integrationId);
  
  switch (detail.integrationType) {
    case 'CONFLUENCE':
      await registerConfluence(detail);
      break;
    default:
      console.warn(`Gateway registration not implemented for ${detail.integrationType}`);
  }
}

async function registerConfluence(detail: IntegrationEvent) {
  const schemaUri = `s3://citadel-schemas-${ENVIRONMENT}-${ACCOUNT_ID}-${REGION}/confluence-openapi.json`;
  
  try {
    const response = await bedrockAgentCore.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: await getGatewayId(),
      name: `confluence-${detail.integrationId}`,
      description: `Confluence integration for ${detail.orgId}`,
      targetConfiguration: {
        mcp: {
          openApiSchema: {
            s3: {
              uri: schemaUri,
              bucketOwnerAccountId: ACCOUNT_ID
            }
          }
        }
      },
      credentialProviderConfigurations: [{
        credentialProviderType: 'API_KEY',
        credentialProvider: {
          apiKeyCredentialProvider: {
            providerArn: detail.secretArn,
            credentialLocation: 'HEADER',
            credentialParameterName: 'Authorization',
            credentialPrefix: 'Basic'
          }
        }
      }]
    }));
    
    console.log('Gateway target created:', response.targetId);
    await updateIntegrationStatus(detail.integrationId, 'CONNECTED', true, response.targetId);
  } catch (error: any) {
    // Handle ConflictException - gateway target already exists
    if (error.name === 'ConflictException') {
      console.log('Gateway target already exists, checking current status');
      
      // Query DynamoDB to get existing gateway target ID
      const integration = await getIntegration(detail.integrationId);
      if (integration?.gatewayTargetId) {
        console.log('Using existing gateway target:', integration.gatewayTargetId);
        await updateIntegrationStatus(detail.integrationId, 'CONNECTED', true, integration.gatewayTargetId);
      } else {
        console.error('Gateway target exists but ID not found in DynamoDB');
        await updateIntegrationStatus(detail.integrationId, 'CONNECTION_FAILED', false, undefined, 'Gateway target exists but ID not found');
      }
    } else {
      console.error('Failed to create gateway target:', error);
      await updateIntegrationStatus(detail.integrationId, 'CONNECTION_FAILED', false, undefined, error.message);
      throw error;
    }
  }
}

async function handleDisconnect(detail: IntegrationEvent) {
  console.log('Unregistering integration from AgentCore:', detail.integrationId);
  
  const integration = await getIntegration(detail.integrationId);
  
  if (integration?.gatewayTargetId) {
    try {
      await bedrockAgentCore.send(new DeleteGatewayTargetCommand({
        gatewayIdentifier: await getGatewayId(),
        targetId: integration.gatewayTargetId
      }));
      console.log('Gateway target deleted:', integration.gatewayTargetId);
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        console.log('Gateway target already deleted:', integration.gatewayTargetId);
      } else {
        console.warn('Failed to delete gateway target:', error);
      }
    }
  }
  
  console.log('Integration unregistered from AgentCore');
}

async function getIntegration(integrationId: string) {
  const response = await dynamodb.send(new QueryCommand({
    TableName: INTEGRATIONS_TABLE,
    IndexName: 'IntegrationIdIndex',
    KeyConditionExpression: 'integrationId = :id',
    ExpressionAttributeValues: {
      ':id': integrationId
    }
  }));
  
  return response.Items && response.Items.length > 0 ? response.Items[0] : null;
}

// D-03: Atomic status update using UpdateCommand instead of read-then-write
async function updateIntegrationStatus(integrationId: string, status: string, agentCoreRegistered: boolean, gatewayTargetId?: string, errorMessage?: string) {
  const integration = await getIntegration(integrationId);
  
  if (!integration) {
    throw new Error(`Integration not found: ${integrationId}`);
  }

  const now = new Date().toISOString();
  const updateExprParts = [
    '#status = :status',
    '#agentCoreRegistered = :agentCoreRegistered',
    '#updatedAt = :updatedAt',
  ];
  const exprNames: Record<string, string> = {
    '#status': 'status',
    '#agentCoreRegistered': 'agentCoreRegistered',
    '#updatedAt': 'updatedAt',
  };
  const exprValues: Record<string, any> = {
    ':status': status,
    ':agentCoreRegistered': agentCoreRegistered,
    ':updatedAt': now,
  };

  if (gatewayTargetId) {
    updateExprParts.push('#gatewayTargetId = :gatewayTargetId');
    exprNames['#gatewayTargetId'] = 'gatewayTargetId';
    exprValues[':gatewayTargetId'] = gatewayTargetId;
  }

  if (status === 'CONNECTED') {
    updateExprParts.push('#lastSyncAt = :lastSyncAt');
    exprNames['#lastSyncAt'] = 'lastSyncAt';
    exprValues[':lastSyncAt'] = now;
  }

  if (errorMessage) {
    updateExprParts.push('#errorMessage = :errorMessage');
    exprNames['#errorMessage'] = 'errorMessage';
    exprValues[':errorMessage'] = errorMessage;
  }

  const removeExprParts: string[] = [];
  if (status === 'CONNECTED') {
    removeExprParts.push('#errorMessage');
    exprNames['#errorMessage'] = 'errorMessage';
  }

  let updateExpression = `SET ${updateExprParts.join(', ')}`;
  if (removeExprParts.length > 0 && !errorMessage) {
    updateExpression += ` REMOVE ${removeExprParts.join(', ')}`;
  }

  await dynamodb.send(new UpdateCommand({
    TableName: INTEGRATIONS_TABLE,
    Key: { PK: integration.PK, SK: integration.SK },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
  }));
}
