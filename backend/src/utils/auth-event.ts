import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * Reads a claim from the AppSync identity, tolerating both shapes:
 *  - `identity['custom:organization']` (Cognito user pool auth mode)
 *  - `identity.claims['custom:organization']` (some proxy/IAM modes)
 */
function readClaim(event: any, name: string): string | undefined {
  const identity = event?.identity || {};
  return identity[name] ?? identity.claims?.[name];
}

/**
 * Extracts the caller's organization.
 *
 * Preferred path: JWT claim `custom:organization` (populated by the pre-token
 * generation trigger). Fallback path: AdminGetUserCommand against Cognito.
 * The fallback exists for the transition window after this deploys but
 * before every active token has been refreshed.
 *
 * Returns null if neither source yields an orgId (e.g. anonymous or
 * api-key auth). Callers are responsible for deciding whether null means
 * "deny" or "allow through".
 */
export async function extractOrgFromEvent(event: any): Promise<string | null> {
  const claimOrg = readClaim(event, 'custom:organization');
  if (claimOrg) return claimOrg;

  const identity = event?.identity || {};
  const userId = identity.sub || identity.username;
  if (!userId) return null;

  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) return null;

  try {
    const response = await cognitoClient.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: userId }),
    );
    const attr = response.UserAttributes?.find((a) => a.Name === 'custom:organization');
    return attr?.Value || null;
  } catch (err) {
    console.warn('extractOrgFromEvent: Cognito fallback failed', { userId, err: String(err) });
    return null;
  }
}

/**
 * True when the caller is an admin. Two paths are honoured:
 *  1. JWT claim `custom:role === 'admin'` (legacy / explicit role attribute).
 *  2. Cognito group membership `admin` via the `cognito:groups` claim.
 *
 * The groups claim arrives in different shapes depending on AppSync auth
 * mode: a JS array under standard JWT decoding, but some proxies/auth modes
 * flatten it to a comma-separated string. Both shapes are tolerated.
 */
export function isAdminFromEvent(event: any): boolean {
  // Path 1: explicit custom:role claim equals 'admin'.
  if (readClaim(event, 'custom:role') === 'admin') return true;

  // Path 2: cognito:groups membership includes 'admin'. Cognito issues this
  // claim as an array in standard JWT, but some AppSync auth modes flatten
  // it to a comma-separated string. Tolerate both.
  const groups = readClaim(event, 'cognito:groups');
  if (Array.isArray(groups)) {
    return groups.some((g) => typeof g === 'string' && g === 'admin');
  }
  if (typeof groups === 'string') {
    return groups
      .split(',')
      .map((s) => s.trim())
      .includes('admin');
  }

  return false;
}

/**
 * True when the caller holds the given (non-admin) role. Mirrors
 * {@link isAdminFromEvent}'s claim-reading so role checks stay consistent
 * across AppSync auth modes:
 *  1. JWT claim `custom:role === <role>`.
 *  2. Cognito group membership `<role>` via the `cognito:groups` claim.
 *
 * As with {@link isAdminFromEvent}, the `cognito:groups` claim is tolerated
 * both as a JS array and as a comma-separated string, and both the direct
 * (`identity[...]`) and nested (`identity.claims[...]`) shapes are honoured.
 *
 * This intentionally does NOT treat 'admin' as a super-role. Callers wanting
 * "admin OR <role>" semantics should compose
 * `isAdminFromEvent(event) || hasRoleFromEvent(event, role)`.
 */
export function hasRoleFromEvent(event: any, role: string): boolean {
  // Path 1: explicit custom:role claim equals the requested role.
  if (readClaim(event, 'custom:role') === role) return true;

  // Path 2: cognito:groups membership includes the requested role. Tolerate
  // both the array and comma-separated-string shapes (see isAdminFromEvent).
  const groups = readClaim(event, 'cognito:groups');
  if (Array.isArray(groups)) {
    return groups.some((g) => typeof g === 'string' && g === role);
  }
  if (typeof groups === 'string') {
    return groups
      .split(',')
      .map((s) => s.trim())
      .includes(role);
  }

  return false;
}
