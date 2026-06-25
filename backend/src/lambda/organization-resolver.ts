import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const cognitoClient = new CognitoIdentityProviderClient({});

const ORGANIZATIONS_TABLE = process.env.ORGANIZATIONS_TABLE || '';
const USER_POOL_ID = process.env.USER_POOL_ID || '';

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
  } catch (error: unknown) {
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

  // 1. Existence check (preserved from prior behaviour, runs FIRST so a
  //    missing-org request short-circuits before any Cognito call).
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

  // 2. Orphan-user verification.
  //
  //    The user↔org link lives in the Cognito `custom:organization`
  //    user-pool attribute (there is no DynamoDB users table). Deleting
  //    an org while users still point to it leaves dangling JWT claims
  //    and risks cross-tenant access if the orgId is ever reused.
  //
  //    Mirror the `createOrganization` "pre-check + throw" idiom used
  //    above — list users with a server-side filter, hard-cap to 1, fail
  //    closed if any are returned.
  //
  //    Defensive guard: if USER_POOL_ID is unset (e.g. transitional
  //    deploy ordering or local fixture), refuse the delete rather than
  //    silently bypass the check. Failing closed is the only safe choice
  //    for a tenant-deletion path.
  if (!USER_POOL_ID) {
    throw new Error(
      'Cannot delete organization: USER_POOL_ID is not configured; orphan-user verification cannot run.'
    );
  }

  const usersResponse = await cognitoClient.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      // Cognito ListUsers filter syntax requires the attribute name to be
      // wrapped in double quotes when it contains a colon (custom:*).
      // Reference: https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-manage-user-accounts.html#cognito-user-pools-searching-for-users-using-listusers-api
      Filter: `"custom:organization" = "${orgId}"`,
      Limit: 1,
    })
  );

  if (usersResponse.Users && usersResponse.Users.length > 0) {
    throw new Error(
      'Cannot delete organization: 1+ user(s) still assigned. Reassign or remove these users before deleting the organization.'
    );
  }

  // 3. Safe to delete.
  //
  //    NOTE: other dependents (Projects.organization, Workflows.orgId,
  //    RegistryAgentRecord manifests, datastores, integrations) are
  //    flagged for follow-up — out of scope for this finding per the
  //    security-architect's design.
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
