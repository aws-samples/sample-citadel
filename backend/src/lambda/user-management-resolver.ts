import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  ListGroupsCommand,
  ChangePasswordCommand,
  AdminSetUserPasswordCommand,
  AdminCreateUserCommand,
  MessageActionType,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import * as crypto from 'crypto';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const cognitoClient = new CognitoIdentityProviderClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USER_POOL_ID = process.env.USER_POOL_ID!;
const ORGANISATION_TABLE = process.env.ORGANISATION_TABLE!;

// Cache for user groups to reduce Cognito API calls
// Cache persists across warm Lambda invocations
const groupCache = new Map<string, { groups: string[], timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface AssignUserRoleInput {
  userId: string;
  role: string;
  organization?: string;
}

interface ChangePasswordInput {
  newPassword: string;
}

interface AdminCreateUserInput {
  email: string;
  givenName: string;
  familyName: string;
}

interface User {
  userId: string;
  email: string;
  name: string;
  givenName: string;
  familyName: string;
  role?: string;
  organization?: string;
  status: string;
  createdAt: string;
  enabled: boolean;
}

/**
 * Check if a user is an admin with caching to reduce Cognito API calls
 */
async function isUserAdmin(username: string): Promise<boolean> {
  // Check cache first
  const cached = groupCache.get(username);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`Cache hit for user ${username}`);
    return cached.groups.includes('admin');
  }

  // Cache miss - fetch from Cognito
  console.log(`Cache miss for user ${username}, fetching from Cognito`);
  const groupsResponse = await cognitoClient.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    })
  );

  const groups = groupsResponse.Groups?.map(g => g.GroupName!) || [];
  
  // Update cache
  groupCache.set(username, { groups, timestamp: Date.now() });

  return groups.includes('admin');
}

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    switch (fieldName) {
      case 'listUsers':
        return await listUsers();
      case 'getUser':
        return await getUser(event.arguments.userId);
      case 'getCurrentUserProfile':
        return await getCurrentUserProfile(event);
      case 'listAvailableRoles':
        return await listAvailableRoles();
      case 'listOrganizations':
        return await listOrganizations();
      case 'adminCreateUser':
        return await adminCreateUser(event, event.arguments.input);
      case 'assignUserRole':
        return await assignUserRole(event.arguments.input, event);
      case 'removeUserRole':
        return await removeUserRole(event.arguments.userId, event.arguments.role, event);
      case 'changePassword':
        return await changePassword(event, event.arguments.input);
      case 'adminResetUserPassword':
        return await adminResetUserPassword(event, event.arguments.userId);
      case 'adminResendInvitation':
        return await adminResendInvitation(event, event.arguments.userId);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

async function listUsers(): Promise<User[]> {
  const response = await cognitoClient.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
    })
  );

  const users: User[] = [];

  for (const user of response.Users || []) {
    const attributes = user.Attributes || [];
    const email = attributes.find((attr) => attr.Name === 'email')?.Value || '';
    const givenName = attributes.find((attr) => attr.Name === 'given_name')?.Value || '';
    const familyName = attributes.find((attr) => attr.Name === 'family_name')?.Value || '';
    const organization = attributes.find((attr) => attr.Name === 'custom:organization')?.Value;

    // Get user's groups (roles)
    const groupsResponse = await cognitoClient.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: user.Username!,
      })
    );

    // Cognito does NOT guarantee the order in which Groups are returned for a
      // multi-group user. Selecting `Groups[0]` was flaky — if an admin happened
      // to also be in a non-admin group and Cognito returned that group first,
      // the OrganizationContext on the frontend would fall through to the
      // non-admin branch (and show "No Org" if the user had no
      // custom:organization attribute set). Prefer 'admin' if present so the
      // most-privileged role always wins; otherwise take the first returned
      // group, matching the prior behaviour for single-group users.
      const groupNames = (groupsResponse.Groups || [])
        .map((g) => g.GroupName)
        .filter((n): n is string => !!n);
      const role =
        groupNames.find((n) => n === 'admin') ?? groupNames[0];

    users.push({
      userId: user.Username!,
      email,
      name: `${givenName} ${familyName}`.trim(),
      givenName,
      familyName,
      role,
      organization,
      status: user.UserStatus || 'UNKNOWN',
      createdAt: user.UserCreateDate?.toISOString() || new Date().toISOString(),
      enabled: user.Enabled || false,
    });
  }

  return users;
}

async function getUser(userId: string): Promise<User> {
  const response = await cognitoClient.send(
    new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    })
  );

  const attributes = response.UserAttributes || [];
  const email = attributes.find((attr) => attr.Name === 'email')?.Value || '';
  const givenName = attributes.find((attr) => attr.Name === 'given_name')?.Value || '';
  const familyName = attributes.find((attr) => attr.Name === 'family_name')?.Value || '';
  const organization = attributes.find((attr) => attr.Name === 'custom:organization')?.Value;

  // Get user's groups (roles)
  const groupsResponse = await cognitoClient.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    })
  );

  // Cognito does NOT guarantee the order in which Groups are returned for a
    // multi-group user. Selecting `Groups[0]` was flaky — if an admin happened
    // to also be in a non-admin group and Cognito returned that group first,
    // the OrganizationContext on the frontend would fall through to the
    // non-admin branch (and show "No Org" if the user had no
    // custom:organization attribute set). Prefer 'admin' if present so the
    // most-privileged role always wins; otherwise take the first returned
    // group, matching the prior behaviour for single-group users.
    const groupNames = (groupsResponse.Groups || [])
      .map((g) => g.GroupName)
      .filter((n): n is string => !!n);
    const role =
      groupNames.find((n) => n === 'admin') ?? groupNames[0];

  return {
    userId: response.Username!,
    email,
    name: `${givenName} ${familyName}`.trim(),
    givenName,
    familyName,
    role,
    organization,
    status: response.UserStatus || 'UNKNOWN',
    createdAt: response.UserCreateDate?.toISOString() || new Date().toISOString(),
    enabled: response.Enabled || false,
  };
}

async function getCurrentUserProfile(event: any): Promise<User> {
  // Extract username from the Cognito identity
  const username = event.identity?.username || event.identity?.claims?.username;
  
  if (!username) {
    throw new Error('Unable to determine current user from request context');
  }

  return await getUser(username);
}

async function assignUserRole(input: AssignUserRoleInput, event: any) {
  const { userId, role, organization } = input;

  // Verify the caller is an admin
  const callerUsername = event.identity?.username || event.identity?.claims?.username;
  
  if (!callerUsername) {
    throw new Error('Unable to determine caller identity');
  }

  // Check if caller is admin (with caching)
  const callerIsAdmin = await isUserAdmin(callerUsername);
  
  if (!callerIsAdmin) {
    throw new Error('Only administrators can assign user roles');
  }

  console.log(`Assigning role ${role} and organization ${organization} to user ${userId}`);

  // Get current groups to remove user from old role
  const groupsResponse = await cognitoClient.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    })
  );

  // Remove user from all existing groups
  for (const group of groupsResponse.Groups || []) {
    await cognitoClient.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
        GroupName: group.GroupName!,
      })
    );
  }

  // Add user to new role group
  await cognitoClient.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
      GroupName: role,
    })
  );

  // Update organization custom attribute if provided
  if (organization) {
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
        UserAttributes: [
          {
            Name: 'custom:organization',
            Value: organization,
          },
        ],
      })
    );
  }

  console.log(`Successfully assigned role ${role} and organization ${organization} to user ${userId}`);

  return {
    success: true,
    message: `User ${userId} assigned to role ${role}${organization ? ` and organization ${organization}` : ''}`,
  };
}

async function removeUserRole(userId: string, role: string, event: any) {
  // Verify the caller is an admin
  const callerUsername = event.identity?.username || event.identity?.claims?.username;
  
  if (!callerUsername) {
    throw new Error('Unable to determine caller identity');
  }

  // Check if caller is admin (with caching)
  const callerIsAdmin = await isUserAdmin(callerUsername);
  
  if (!callerIsAdmin) {
    throw new Error('Only administrators can remove user roles');
  }

  await cognitoClient.send(
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
      GroupName: role,
    })
  );

  return {
    success: true,
    message: `User ${userId} removed from role ${role}`,
  };
}

async function listAvailableRoles(): Promise<string[]> {
  const response = await cognitoClient.send(
    new ListGroupsCommand({
      UserPoolId: USER_POOL_ID,
    })
  );

  return (response.Groups || [])
    .map(group => group.GroupName)
    .filter((name): name is string => !!name)
    .sort();
}

async function listOrganizations() {
  const response = await dynamoClient.send(
    new ScanCommand({
      TableName: ORGANISATION_TABLE,
    })
  );

  return (response.Items || []).map(item => {
    console.log('Raw item from DynamoDB:', JSON.stringify(item));
    
    // Ensure createdAt is in proper ISO 8601 format for AppSync
    let createdAt = item.createdAt;
    console.log('Original createdAt:', createdAt, 'Type:', typeof createdAt);
    
    if (createdAt && typeof createdAt === 'string') {
      // Remove microseconds if present
      const parts = createdAt.split('.');
      if (parts.length > 1) {
        // Has microseconds, take only the date/time part
        createdAt = parts[0];
        console.log('After removing microseconds:', createdAt);
      }
      // Ensure it ends with 'Z' (but don't add if already present)
      if (!createdAt.endsWith('Z')) {
        createdAt = createdAt + 'Z';
        console.log('Added Z:', createdAt);
      } else {
        console.log('Already has Z, not adding');
      }
    }
    
    console.log('Final createdAt:', createdAt);
    
    return {
      orgId: item.orgId,
      name: item.name || item.orgId,
      description: item.description,
      createdAt: createdAt,
    };
  });
}

async function changePassword(event: any, input: ChangePasswordInput) {
  const { newPassword } = input;
  
  // Get username from the Cognito identity
  const username = event.identity?.username || event.identity?.claims?.username;
  
  if (!username) {
    throw new Error('Unable to determine current user from request context');
  }

  try {
    // Use AdminSetUserPassword to change the user's password
    // Since the user is already authenticated, we know they have valid credentials
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: newPassword,
        Permanent: true, // This is a permanent password, not temporary
      })
    );

    return {
      success: true,
      message: 'Password changed successfully',
    };
  } catch (error: any) {
    console.error('Error changing password:', error);
    return {
      success: false,
      message: error.message || 'Failed to change password',
    };
  }
}

async function adminResetUserPassword(event: any, userId: string) {
  // Verify the caller is an admin
  const callerUsername = event.identity?.username || event.identity?.claims?.username;
  
  if (!callerUsername) {
    throw new Error('Unable to determine caller identity');
  }

  // Check if caller is admin (with caching)
  const callerIsAdmin = await isUserAdmin(callerUsername);
  
  if (!callerIsAdmin) {
    throw new Error('Only administrators can reset user passwords');
  }

  try {
    // Generate a temporary password (user will be forced to change it on next login)
    const tempPassword = generateTemporaryPassword();
    
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
        Password: tempPassword,
        Permanent: false, // User must change password on next login
      })
    );

    return {
      success: true,
      message: `Password reset successfully. Temporary password: ${tempPassword}`,
    };
  } catch (error: any) {
    console.error('Error resetting password:', error);
    return {
      success: false,
      message: error.message || 'Failed to reset password',
    };
  }
}

async function adminCreateUser(event: any, input: AdminCreateUserInput) {
  // Verify the caller is an admin
  const callerUsername = event.identity?.username || event.identity?.claims?.username;
  
  if (!callerUsername) {
    throw new Error('Unable to determine caller identity');
  }

  // Check if caller is admin (with caching)
  const callerIsAdmin = await isUserAdmin(callerUsername);
  
  if (!callerIsAdmin) {
    throw new Error('Only administrators can create users');
  }

  const { email, givenName, familyName } = input;

  try {
    // Create user with email as username
    // Cognito will send an email with temporary password automatically
    const response = await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' }, // Set to true so email is verified
          { Name: 'given_name', Value: givenName },
          { Name: 'family_name', Value: familyName },
        ],
        // Remove MessageAction to allow Cognito to send the welcome email
        DesiredDeliveryMediums: ['EMAIL'],
      })
    );

    console.log(`Successfully created user ${email}`);

    return {
      success: true,
      message: `User ${email} created successfully. An invitation email with temporary password has been sent to their email address.`,
    };
  } catch (error: any) {
    console.error('Error creating user:', error);
    
    if (error.name === 'UsernameExistsException') {
      return {
        success: false,
        message: 'A user with this email already exists',
      };
    }
    
    return {
      success: false,
      message: error.message || 'Failed to create user',
    };
  }
}

async function adminResendInvitation(event: any, userId: string) {
  // Verify the caller is an admin
  const callerUsername = event.identity?.username || event.identity?.claims?.username;
  
  if (!callerUsername) {
    throw new Error('Unable to determine caller identity');
  }

  // Check if caller is admin (with caching)
  const callerIsAdmin = await isUserAdmin(callerUsername);
  
  if (!callerIsAdmin) {
    throw new Error('Only administrators can resend invitations');
  }

  try {
    // Generate a temporary password and set it
    const tempPassword = generateTemporaryPassword();
    
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
        Password: tempPassword,
        Permanent: false, // User must change password on first login
      })
    );

    return {
      success: true,
      message: `Invitation resent. Temporary password: ${tempPassword}`,
    };
  } catch (error: any) {
    console.error('Error resending invitation:', error);
    return {
      success: false,
      message: error.message || 'Failed to resend invitation',
    };
  }
}

function generateTemporaryPassword(): string {
  const length = 12;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  // Ensure password meets Cognito requirements
  password += 'A'; // uppercase
  password += 'a'; // lowercase
  password += '1'; // digit
  password += '!'; // symbol
  
  for (let i = password.length; i < length; i++) {
    password += charset.charAt(randomBytes[i] % charset.length);
  }
  
  // Shuffle the password using crypto-secure randomness
  const arr = password.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}
