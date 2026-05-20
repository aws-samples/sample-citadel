import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const ORGANIZATIONS_TABLE = process.env.ORGANIZATIONS_TABLE || '';

interface CreateOrganizationInput {
  name: string;
  description?: string;
}

interface Organization {
  orgId: string;
  name: string;
  description?: string;
  createdAt: string;
}

interface UserManagementResponse {
  success: boolean;
  message?: string;
}

export const handler = async (event: any): Promise<any> => {
  console.log('Organization resolver event:', JSON.stringify(event, null, 2));

  const { fieldName, arguments: args } = event;

  try {
    switch (fieldName) {
      case 'createOrganization':
        return await createOrganization(args.input);
      case 'deleteOrganization':
        return await deleteOrganization(args.orgId);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: any) {
    console.error(`Error in ${fieldName}:`, error);
    throw error;
  }
};

async function createOrganization(input: CreateOrganizationInput): Promise<Organization> {
  console.log('Creating organization:', input);

  // Check if organization with same name already exists
  const existingOrgs = await docClient.send(
    new ScanCommand({
      TableName: ORGANIZATIONS_TABLE,
      FilterExpression: '#name = :name',
      ExpressionAttributeNames: {
        '#name': 'name',
      },
      ExpressionAttributeValues: {
        ':name': input.name,
      },
    })
  );

  if (existingOrgs.Items && existingOrgs.Items.length > 0) {
    throw new Error(`Organization with name "${input.name}" already exists`);
  }

  const orgId = uuidv4();
  const now = new Date().toISOString();

  const organization: Organization = {
    orgId,
    name: input.name,
    description: input.description,
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: ORGANIZATIONS_TABLE,
      Item: organization,
    })
  );

  console.log('Organization created:', organization);
  return organization;
}

async function deleteOrganization(orgId: string): Promise<UserManagementResponse> {
  console.log('Deleting organization:', orgId);

  // Check if organization exists
  const existingOrgs = await docClient.send(
    new ScanCommand({
      TableName: ORGANIZATIONS_TABLE,
      FilterExpression: 'orgId = :orgId',
      ExpressionAttributeValues: {
        ':orgId': orgId,
      },
    })
  );

  if (!existingOrgs.Items || existingOrgs.Items.length === 0) {
    throw new Error(`Organization with ID "${orgId}" not found`);
  }

  // TODO: Check if any users are assigned to this organization
  // For now, we'll allow deletion

  await docClient.send(
    new DeleteCommand({
      TableName: ORGANIZATIONS_TABLE,
      Key: { orgId },
    })
  );

  console.log('Organization deleted:', orgId);
  return {
    success: true,
    message: `Organization deleted successfully`,
  };
}
