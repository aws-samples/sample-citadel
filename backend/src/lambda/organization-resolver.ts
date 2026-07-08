import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';

const client = new DynamoDBClient({});
// removeUndefinedValues: defensive guard so no undefined attribute can break
// PutCommand marshalling (Issue #14). The `input.description || ''` default in
// createOrganization handles the known case; this covers any future field.
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
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

  // AppSync delivers the operation name under event.info.fieldName (not
  // event.fieldName). Reading the wrong path left fieldName undefined, so every
  // dispatch fell through to the default case → 'Unknown field: undefined'
  // (Issue #14). Match project-resolver.ts + docs/RESOLVER_GUIDE.md.
  const { info, arguments: args } = event;
  const fieldName = info.fieldName;

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
    // Default to '' (matches project-resolver.ts). Writing `undefined` breaks
    // DynamoDB marshalling in the real client → Lambda:Unhandled (Issue #14).
    description: input.description || '',
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

  //    The Cognito `custom:organization` attribute stores the org NAME, not
  //    the orgId — it is written verbatim from the (name-valued) org picker in
  //    assignUserRole, read back verbatim by listUsers, and used name-first for
  //    org scoping everywhere else (see extractOrgFromEvent + project/workflow
  //    resolvers). The orphan-user check below must therefore compare against
  //    the org NAME; comparing against the orgId (a generated UUID) would never
  //    match and would silently bypass the guard (Issue #19).
  const orgName = (existingOrgs.Items[0] as { name?: string }).name;
  if (!orgName) {
    // Fail closed: without the name we cannot correlate users to this org.
    throw new Error(
      'Cannot delete organization: organization record has no name; orphan-user verification cannot run.'
    );
  }

  // 2. Orphan-user verification.
  //
  //    The user↔org link lives in the Cognito `custom:organization`
  //    user-pool attribute (there is no DynamoDB users table). Deleting
  //    an org while users still point to it leaves dangling JWT claims
  //    and risks cross-tenant access if the org name is ever reused.
  //
  //    Mirror the `createOrganization` "pre-check + throw" idiom used
  //    above — enumerate users and fail closed if any still point at this
  //    org (client-side match; see the ListUsers note below for why).
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

  //    Cognito ListUsers server-side `Filter` supports STANDARD attributes
  //    ONLY (username, email, phone_number, name, given_name, family_name,
  //    preferred_username, sub, cognito:user_status, status). Filtering on a
  //    CUSTOM attribute (custom:organization) raises InvalidParameterException
  //    — surfaced to the client as "Input fails to satisfy the constraints"
  //    and logged as Lambda:Unhandled (Issue #14, 2nd bug). We therefore PAGE
  //    through the pool (max 60 users per page) and match custom:organization
  //    (the org NAME, per the note above) CLIENT-SIDE, failing closed on the
  //    FIRST match. Bounded by design: we check-and-early-exit per page and
  //    never buffer an unbounded user array.
  let paginationToken: string | undefined;
  do {
    const usersResponse = await cognitoClient.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Limit: 60,
        PaginationToken: paginationToken,
      })
    );

    for (const user of usersResponse.Users ?? []) {
      const assignedToOrg = (user.Attributes ?? []).some(
        (attr) => attr.Name === 'custom:organization' && attr.Value === orgName
      );
      if (assignedToOrg) {
        throw new Error(
          'Cannot delete organization: 1+ user(s) still assigned. Reassign or remove these users before deleting the organization.'
        );
      }
    }

    paginationToken = usersResponse.PaginationToken;
  } while (paginationToken);

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
