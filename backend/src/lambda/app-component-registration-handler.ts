import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

interface FabricationEventDetail {
  agentId?: string;
  toolId?: string;
  appId?: string;
  orchestrationId?: string;
}

export async function handler(
  event: EventBridgeEvent<string, FabricationEventDetail>
): Promise<void> {
  console.log('Fabrication registration event:', JSON.stringify(event, null, 2));

  const APPS_TABLE = process.env.APPS_TABLE || '';
  const { detail } = event;
  const { appId } = detail;

  if (!appId) {
    console.log('No appId in event, skipping app registration');
    return;
  }

  const componentId = detail.agentId || detail.toolId;
  if (!componentId) {
    console.log('No agentId or toolId in event, skipping');
    return;
  }

  const prefix = detail.agentId ? 'AGENT' : 'TOOL';
  const idField = detail.agentId ? 'agentId' : 'toolId';
  const sortId = `${prefix}#${componentId}`;

  try {
    await docClient.send(new PutCommand({
      TableName: APPS_TABLE,
      Item: {
        appId: `${appId}#${sortId}`,
        groupId: `APP#${appId}`,
        sortId,
        [idField]: componentId,
        status: 'DESIGN',
        addedAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(groupId)',
    }));

    console.log(`Registered ${prefix}#${componentId} under app ${appId}`);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log(`Component ${prefix}#${componentId} already registered under app ${appId}, skipping`);
      return;
    }
    throw error;
  }
}
