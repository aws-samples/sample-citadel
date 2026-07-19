/**
 * App Access Control — Role-based access control for Agent Apps.
 *
 * Functions: autoAssignOwner, grantAppAccess, revokeAppAccess,
 *            listAppAccessEntries, checkAppAccess
 *
 * Role hierarchy: owner > editor > viewer
 * Admin Cognito group bypasses all role checks.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10
 */
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

export interface AccessControlDeps {
  docClient: DynamoDBDocumentClient;
  appsTable: string;
}

export type AppRole = 'owner' | 'editor' | 'viewer';

export interface AccessEntry {
  userId: string;
  role: AppRole;
  grantedBy: string;
  grantedAt: string;
}

export interface CallerContext {
  userId: string;
  groups?: string[];
}

const VALID_ROLES: ReadonlySet<string> = new Set(['owner', 'editor', 'viewer']);

/**
 * Role hierarchy levels — higher number = more privilege.
 */
const ROLE_LEVEL: Record<string, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

/**
 * Operations categorized by minimum required role.
 */
const OPERATION_ROLE_MAP: Record<string, AppRole> = {
  // viewer-level operations
  getApp: 'viewer',
  listApps: 'viewer',
  getAppMetrics: 'viewer',
  listAppApiKeys: 'viewer',
  listAppAccessEntries: 'viewer',
  // editor-level operations
  updateApp: 'editor',
  addAppComponent: 'editor',
  removeAppComponent: 'editor',
  updateAgentBinding: 'editor',
  setAppConfigSchema: 'editor',
  setAppConfigValues: 'editor',
  createAppApiKey: 'editor',
  revokeAppApiKey: 'editor',
  rotateAppApiKey: 'editor',
  setAppAuthConfig: 'editor',
  // owner-level operations
  publishApp: 'owner',
  unpublishApp: 'owner',
  grantAppAccess: 'owner',
  revokeAppAccess: 'owner',
};

/**
 * Returns the minimum role required for a given operation.
 */
export function getRequiredRole(operation: string): AppRole | undefined {
  return OPERATION_ROLE_MAP[operation];
}

/**
 * Checks whether a given role meets or exceeds the required role level.
 */
export function hasMinimumRole(userRole: AppRole, requiredRole: AppRole): boolean {
  return (ROLE_LEVEL[userRole] ?? 0) >= (ROLE_LEVEL[requiredRole] ?? 0);
}

/**
 * Checks if the caller is in the admin Cognito group.
 */
export function isAdmin(caller: CallerContext): boolean {
  return caller.groups?.includes('admin') === true;
}

/**
 * Queries all ACCESS# items for an app via GroupIndex.
 */
/** ACCESS# component row slice this module reads. */
interface AccessEntryRecord {
  userId: string;
  role: string;
  grantedBy: string;
  grantedAt: string;
  [key: string]: unknown;
}

async function queryAccessEntries(
  appId: string,
  deps: AccessControlDeps,
): Promise<AccessEntryRecord[]> {
  const result = await deps.docClient.send(new QueryCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid AND begins_with(sortId, :sk)',
    ExpressionAttributeValues: {
      ':gid': `APP#${appId}`,
      ':sk': 'ACCESS#',
    },
  }));
  return (result.Items || []) as AccessEntryRecord[];
}

/**
 * Auto-assigns owner role to the creating user when an app is created.
 *
 * Creates an ACCESS#{userId} component item with role=owner,
 * grantedBy=system, and current timestamp.
 *
 * Requirements: 9.2
 */
export async function autoAssignOwner(
  appId: string,
  userId: string,
  deps: AccessControlDeps,
): Promise<AccessEntry> {
  const now = new Date().toISOString();

  const item = {
    appId: `${appId}#ACCESS#${userId}`,
    groupId: `APP#${appId}`,
    sortId: `ACCESS#${userId}`,
    userId,
    role: 'owner',
    grantedBy: 'system',
    grantedAt: now,
  };

  await deps.docClient.send(new PutCommand({
    TableName: deps.appsTable,
    Item: item,
  }));

  return {
    userId,
    role: 'owner',
    grantedBy: 'system',
    grantedAt: now,
  };
}

/**
 * Grants access to an app for a user with a specified role.
 *
 * Stores an ACCESS#{userId} component item with the role, grantedBy, and timestamp.
 * Only callable by users with owner role or admin group.
 *
 * Requirements: 9.3, 9.9
 */
export async function grantAppAccess(
  appId: string,
  targetUserId: string,
  role: string,
  grantedBy: string,
  deps: AccessControlDeps,
): Promise<AccessEntry> {
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid role: must be owner, editor, or viewer`);
  }

  const now = new Date().toISOString();

  const item = {
    appId: `${appId}#ACCESS#${targetUserId}`,
    groupId: `APP#${appId}`,
    sortId: `ACCESS#${targetUserId}`,
    userId: targetUserId,
    role,
    grantedBy,
    grantedAt: now,
  };

  await deps.docClient.send(new PutCommand({
    TableName: deps.appsTable,
    Item: item,
  }));

  return {
    userId: targetUserId,
    role: role as AppRole,
    grantedBy,
    grantedAt: now,
  };
}

/**
 * Revokes access for a user on an app.
 *
 * Deletes the ACCESS#{userId} component item.
 * Rejects if the target user is the last remaining owner (last owner protection).
 *
 * Requirements: 9.3, 9.10
 */
export async function revokeAppAccess(
  appId: string,
  targetUserId: string,
  deps: AccessControlDeps,
): Promise<void> {
  // Query all access entries to check last owner protection
  const entries = await queryAccessEntries(appId, deps);
  const targetEntry = entries.find(e => e.userId === targetUserId);

  if (!targetEntry) {
    throw new Error(`User access entry not found: ${targetUserId}`);
  }

  // Last owner protection: reject if this is the only owner
  if (targetEntry.role === 'owner') {
    const ownerCount = entries.filter(e => e.role === 'owner').length;
    if (ownerCount <= 1) {
      throw new Error("Cannot revoke the last owner's access");
    }
  }

  await deps.docClient.send(new DeleteCommand({
    TableName: deps.appsTable,
    Key: { appId: `${appId}#ACCESS#${targetUserId}` },
  }));
}

/**
 * Lists all access entries for an app.
 *
 * Requirements: 9.4
 */
export async function listAppAccessEntries(
  appId: string,
  deps: AccessControlDeps,
): Promise<AccessEntry[]> {
  const items = await queryAccessEntries(appId, deps);
  return items.map(item => ({
    userId: item.userId,
    role: item.role as AppRole,
    grantedBy: item.grantedBy,
    grantedAt: item.grantedAt,
  }));
}

/**
 * Checks whether a caller has sufficient access for an operation on an app.
 *
 * Returns true if the caller has the required role or is in the admin group.
 * Throws an error with a descriptive message if access is denied.
 *
 * Requirements: 9.1, 9.6, 9.7, 9.8, 9.9
 */
export async function checkAppAccess(
  appId: string,
  caller: CallerContext,
  requiredRole: AppRole,
  deps: AccessControlDeps,
): Promise<boolean> {
  // Admin group bypasses all role checks
  if (isAdmin(caller)) {
    return true;
  }

  const entries = await queryAccessEntries(appId, deps);
  const callerEntry = entries.find(e => e.userId === caller.userId);

  if (!callerEntry) {
    throw new Error(`Access denied: requires ${requiredRole} role`);
  }

  const callerRole = callerEntry.role as AppRole;
  if (!hasMinimumRole(callerRole, requiredRole)) {
    throw new Error(`Access denied: requires ${requiredRole} role`);
  }

  return true;
}

/**
 * Checks access for a named operation using the operation-to-role mapping.
 *
 * Requirements: 9.6
 */
export async function checkOperationAccess(
  appId: string,
  caller: CallerContext,
  operation: string,
  deps: AccessControlDeps,
): Promise<boolean> {
  const requiredRole = getRequiredRole(operation);
  if (!requiredRole) {
    throw new Error(`Unknown operation: ${operation}`);
  }
  return checkAppAccess(appId, caller, requiredRole, deps);
}
