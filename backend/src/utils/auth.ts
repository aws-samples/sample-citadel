import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { AuthContext } from '../types';

const cognitoClient = new CognitoIdentityProviderClient({});

export async function validateCognitoToken(accessToken: string): Promise<AuthContext | null> {
  try {
    const command = new GetUserCommand({
      AccessToken: accessToken,
    });

    const response = await cognitoClient.send(command);

    const userId = response.Username!;
    const attributes = response.UserAttributes || [];

    const groups: string[] = [];
    const roles: string[] = [];

    // Extract custom attributes
    for (const attr of attributes) {
      if (attr.Name === 'custom:role') {
        roles.push(attr.Value!);
      }
    }

    return {
      userId,
      username: userId,
      groups,
      roles,
    };
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}

export function hasPermission(authContext: AuthContext, permission: string): boolean {
  // Admin role has all permissions
  if (authContext.roles?.includes('admin')) {
    return true;
  }

  // Define role-based permissions
  const rolePermissions: Record<string, string[]> = {
    project_manager: [
      'project:create',
      'project:read',
      'project:update',
      'agent:monitor',
      'conversation:read',
      // (QT1-5): project_manager may reopen a LOCKED ADR. The
      // reopen path runs audit-before-auth (QT2A-7 + QT3-3) so denied
      // attempts by other roles still produce a durable audit row.
      'adr:reopen',
      // (QT1-5/QT2B-7): project_manager shares ownership of the
      // design phase and may submit the AgentDesignAssessment.
      'assessment:submit',
    ],
    architect: [
      'project:read',
      'project:update',
      'agent:interact',
      'conversation:read',
      'conversation:write',
      'document:upload',
      'adr:create',
      // (QT1-5): architect may reopen a LOCKED ADR.
      'adr:reopen',
      'spec:approve',
      // (QT1-5/QT2B-7): architect owns the design phase and may
      // submit the AgentDesignAssessment.
      'assessment:submit',
      // Decision #7: registry permissions.
      'registry:create',
      'registry:update',
      'registry:submit',
    ],
    developer: [
      'project:read',
      'agent:read',
      'conversation:read',
      'implementation:download',
      // Decision #7: registry read for developer role.
      'registry:read',
    ],
  };

  // Check if any of the user's roles have the required permission
  for (const role of authContext.roles || []) {
    const permissions = rolePermissions[role] || [];
    if (permissions.includes(permission) || permissions.includes('*')) {
      return true;
    }
  }

  return false;
}

export function extractUserIdFromEvent(event: any): string {
  return event.identity?.sub || event.identity?.username || 'anonymous';
}

export function createAuthContext(event: any): AuthContext {
  const identity = event.identity || {};

  return {
    userId: identity.sub || identity.username || 'anonymous',
    username: identity.username,
    groups: identity['cognito:groups'] || [],
    roles: identity['custom:role'] ? [identity['custom:role']] : [],
  };
}
