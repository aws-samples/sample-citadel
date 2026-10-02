/**
 * Project-owner → organisation resolution backed by the UserOrgMembership
 * DynamoDB table (decision 00d40a31, option A).
 *
 * WHY THIS MODULE EXISTS. `Project.owner` is the durable pointer back to
 * the org a project belongs to when the project row itself is org-less
 * (project-resolver.ts writes `organization: userOrganization || undefined`).
 * The former helper (an AdminGetUser attribute lookup in utils/auth-event.ts,
 * now deleted) resolved that pointer by reading the owner's stored Cognito
 * `custom:organization` user-pool ATTRIBUTE via AdminGetUser. That
 * attribute is a display/back-compat mirror written by `assignUserRole`;
 * the authoritative user↔org link is the UserOrgMembership table, which is
 * also what pre-token-generation.ts reads to mint the claim. Reading the
 * mirror from a second code path kept a non-authoritative signal alive in
 * an org-scoping decision — this module replaces it with the table read.
 *
 * OWNER-FIELD FINDING (verified 2026-10-02). `Project.owner` is written as
 * `owner: userId` in project-resolver.ts (`createProject`, ~line 343) where
 * `userId = getUserId(identity)` (utils/appsync.ts:13-20), which returns
 * `identity.sub` for a Cognito user-pool identity. So for every project
 * created through the AppSync Cognito path, `owner` IS the Cognito `sub` —
 * the same key the membership table is partitioned on — and a single
 * GetItem by `{ sub: owner }` is the whole lookup. The Cognito AdminGetUser
 * call below is retained ONLY as a username→sub identity mapping for rows
 * whose `owner` is not UUID-shaped (seeded/legacy/IAM-created rows); it
 * reads the `sub` attribute and nothing else. It must never read
 * `custom:organization` — the tripwire (test/cognito-claim-trust-tripwire)
 * pins that the removed helper's identifier is absent from backend/src.
 *
 * Never throws: env unset, DynamoDB/Cognito failure, absent/malformed row →
 * `console.warn` + null. Callers decide what null means (intake falls back
 * to the org-less literal; release-resolver fails closed).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognitoClient = new CognitoIdentityProviderClient({});

/** Cognito `sub` values are v4 UUIDs. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deriveOrgName(
  row: Record<string, unknown> | undefined,
): string | null {
  const orgName = row?.orgName;
  return typeof orgName === "string" && orgName.length > 0 ? orgName : null;
}

async function readMembershipOrg(
  tableName: string,
  sub: string,
): Promise<string | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { sub },
      // Mirror pre-token-generation.ts: the row may have been written
      // moments ago by assignUserRole.
      ConsistentRead: true,
    }),
  );
  return deriveOrgName(result?.Item as Record<string, unknown> | undefined);
}

/**
 * Identity mapping ONLY: username → Cognito `sub`. Returns null when
 * USER_POOL_ID is unset, the user is not found, or no `sub` attribute is
 * returned. Deliberately ignores every other attribute.
 */
async function resolveSubFromUsername(
  username: string,
): Promise<string | null> {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) return null;
  const response = await cognitoClient.send(
    new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
  );
  const sub = response.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  return sub && sub !== username ? sub : null;
}

/**
 * Resolves the organisation NAME (canonical tenancy key, decision 228b3cc8)
 * of a project owner from the UserOrgMembership table. See module header.
 */
export async function lookupOwnerOrganization(
  owner: string,
): Promise<string | null> {
  if (!owner) return null;

  const tableName = process.env.USER_ORG_MEMBERSHIP_TABLE;
  if (!tableName) {
    console.warn(
      "lookupOwnerOrganization: USER_ORG_MEMBERSHIP_TABLE not configured; cannot resolve owner org",
      { owner },
    );
    return null;
  }

  try {
    const direct = await readMembershipOrg(tableName, owner);
    if (direct) return direct;

    // Legacy/non-sub owner: map username → sub, then retry the table read.
    if (!UUID_SHAPE.test(owner)) {
      const sub = await resolveSubFromUsername(owner);
      if (sub) {
        return await readMembershipOrg(tableName, sub);
      }
    }
    return null;
  } catch (err) {
    console.warn("lookupOwnerOrganization: membership lookup failed", {
      owner,
      err: String(err),
    });
    return null;
  }
}
