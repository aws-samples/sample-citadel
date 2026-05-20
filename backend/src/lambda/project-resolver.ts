import { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';
import { getUserId } from '../utils/appsync';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});
const cognitoClient = new CognitoIdentityProviderClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const USER_POOL_ID = process.env.USER_POOL_ID!;

interface Project {
  id: string;
  name: string;
  status: string;
  currentModule: {
    id: string;
    name: string;
    description: string;
    status: string;
    agentId: string;
  };
  progress: {
    overall: number;
    assessment: number;
    design: number;
    planning: number;
    implementation: number;
    currentPhase: string;
    estimatedCompletion?: string;
  };
  createdAt: string;
  updatedAt: string;
  owner: string;
  description?: string;
  requirements?: string;
}

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log('Project resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case 'getProject':
        return await getProject(args.id, userId);
      case 'listProjects':
        return await listProjects(args.filter, userId);
      case 'createProject':
        return await createProject(args.input, userId);
      case 'updateProject':
        return await updateProject(args.id, args.input, userId);
      case 'uploadDocument':
        return await uploadDocument(args.projectId, args.file, userId);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Project resolver error:', error);
    throw error;
  }
};

async function getProject(id: string, userId: string): Promise<Project | null> {
  const command = new GetCommand({
    TableName: PROJECTS_TABLE,
    Key: { id },
  });

  const result = await docClient.send(command);
  
  if (!result.Item) {
    return null;
  }

  const project = result.Item as any;
  
  // Check if user has access to this project
  // Allow access if: user is owner OR user is in same organization
  const userOrganization = await getUserOrganization(userId);
  
  const hasAccess = 
    project.owner === userId || 
    (userOrganization && project.organization === userOrganization);

  if (!hasAccess) {
    throw new Error('Access denied');
  }

  return project as Project;
}

async function getUserOrganization(userId: string): Promise<string | null> {
  try {
    const command = new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    });

    const response = await cognitoClient.send(command);
    const orgAttribute = response.UserAttributes?.find(attr => attr.Name === 'custom:organization');
    return orgAttribute?.Value || null;
  } catch (error) {
    console.error('Error getting user organization:', error);
    return null;
  }
}

async function listProjects(filter: any, userId: string): Promise<{ items: Project[]; nextToken?: string }> {
  // Get user's organization
  const userOrganization = await getUserOrganization(userId);

  if (!userOrganization) {
    // If user has no organization, fall back to owner-based filtering
    const command = new ScanCommand({
      TableName: PROJECTS_TABLE,
      FilterExpression: '#owner = :userId',
      ExpressionAttributeNames: {
        '#owner': 'owner',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    });
    
    const result = await docClient.send(command);
    return {
      items: (result.Items || []) as Project[],
      nextToken: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : undefined,
    };
  }

  // Query by organization using GSI
  const command = new QueryCommand({
    TableName: PROJECTS_TABLE,
    IndexName: 'OrganizationIndex',
    KeyConditionExpression: 'organization = :org',
    ExpressionAttributeValues: {
      ':org': userOrganization,
    },
    ScanIndexForward: false, // Sort by createdAt descending (newest first)
  });

  const result = await docClient.send(command);
  
  let items = result.Items as Project[] || [];

  // Apply additional filters
  if (filter) {
    if (filter.status) {
      items = items.filter(item => item.status === filter.status);
    }
    if (filter.createdAfter) {
      items = items.filter(item => item.createdAt >= filter.createdAfter);
    }
    if (filter.createdBefore) {
      items = items.filter(item => item.createdAt <= filter.createdBefore);
    }
  }

  return { items };
}

async function createProject(input: any, userId: string): Promise<Project> {
  const now = new Date().toISOString();
  const projectId = uuidv4();

  // Get user's organization
  const userOrganization = await getUserOrganization(userId);

  const project: Project = {
    id: projectId,
    name: input.name,
    description: input.description || '',
    requirements: input.requirements || '',
    status: 'CREATED',
    currentModule: {
      id: 'assessment',
      name: 'Document Assessment',
      description: 'Initial document review and analysis',
      status: 'PENDING',
      agentId: 'agent1',
    },
    progress: {
      overall: 0,
      assessment: 0,
      design: 0,
      planning: 0,
      implementation: 0,
      currentPhase: 'CREATED',
    },
    createdAt: now,
    updatedAt: now,
    owner: userId,
    organization: userOrganization || undefined,
  } as any;

  const command = new PutCommand({
    TableName: PROJECTS_TABLE,
    Item: project,
  });

  await docClient.send(command);

  // Emit project created event
  await emitEvent('project.created', {
    projectId,
    userId,
    project,
  });

  return project;
}

async function updateProject(id: string, input: any, userId: string): Promise<Project> {
  // First check if project exists and user has access
  const existingProject = await getProject(id, userId);
  if (!existingProject) {
    throw new Error('Project not found or access denied');
  }

  const now = new Date().toISOString();
  const updateExpression: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  if (input.name) {
    updateExpression.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = input.name;
  }

  if (input.description !== undefined) {
    updateExpression.push('#description = :description');
    expressionAttributeNames['#description'] = 'description';
    expressionAttributeValues[':description'] = input.description;
  }

  if (input.requirements !== undefined) {
    updateExpression.push('#requirements = :requirements');
    expressionAttributeNames['#requirements'] = 'requirements';
    expressionAttributeValues[':requirements'] = input.requirements;
  }

  if (input.status) {
    updateExpression.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = input.status;
  }

  updateExpression.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = now;

  // D-02: Optimistic locking — increment version with conditional write
  const currentVersion = (existingProject as any).version || 0;
  updateExpression.push('#version = :nextVersion');
  expressionAttributeNames['#version'] = 'version';
  expressionAttributeValues[':nextVersion'] = currentVersion + 1;
  expressionAttributeValues[':currentVersion'] = currentVersion;

  const conditionExpression = currentVersion === 0
    ? '(attribute_not_exists(version) OR version = :currentVersion)'
    : 'version = :currentVersion';

  try {
    const command = new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { id },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const result = await docClient.send(command);

    // Emit project updated event
    await emitEvent('project.updated', {
      projectId: id,
      userId,
      changes: input,
    });

    return result.Attributes as Project;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error(`Conflict: project ${id} was modified concurrently. Please retry.`);
    }
    throw error;
  }
}

async function uploadDocument(projectId: string, file: any, userId: string): Promise<any> {
  // Check if user has access to this project
  const project = await getProject(projectId, userId);
  if (!project) {
    throw new Error('Project not found or access denied');
  }

  // In a real implementation, you would handle S3 upload here
  // For now, we'll just return a success response
  const documentId = uuidv4();

  // Emit document uploaded event
  await emitEvent('document.uploaded', {
    projectId,
    documentId,
    userId,
    file,
  });

  return {
    success: true,
    documentId,
    url: `https://s3.amazonaws.com/${file.bucket}/${file.key}`,
    message: 'Document uploaded successfully',
  };
}

async function emitEvent(eventType: string, detail: any): Promise<void> {
  const command = new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.backend',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: EVENT_BUS_NAME,
      },
    ],
  });

  await eventBridgeClient.send(command);
}