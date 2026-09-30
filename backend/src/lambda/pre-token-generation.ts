/**
 * Cognito pre-token-generation trigger.
 *
 * Mints the `custom:organization` JWT claim SERVER-SIDE from the
 * UserOrgMembership DynamoDB table and synthesises a DISPLAY/LEGACY
 * `custom:role` claim from Cognito group membership.
 *
 * `custom:organization` claim (decision 00d40a31, option A — security
 * change 2026-09-30): the stored `custom:organization` user-pool attribute
 * is a client-adjacent, display/back-compat value and is NEVER READ here.
 * The claim is derived ONLY from the membership table
 * (`USER_ORG_MEMBERSHIP_TABLE`, pk `sub`, written by `assignUserRole`):
 *   - GetItem by `event.request.userAttributes.sub` (fallback
 *     `event.userName`);
 *   - row present → `custom:organization = row.orgName`;
 *   - row absent, table unconfigured, OR any DynamoDB error → the claim is
 *     OMITTED from claimsToAddOrOverride AND listed in `claimsToSuppress`,
 *     and a warning is logged. The suppress is load-bearing: the pool
 *     client's readAttributes includes `custom:organization`, so Cognito's
 *     default mapping would otherwise copy the stored attribute into the ID
 *     token as that very claim. Fail closed: every downstream org-scoped
 *     resolver treats a missing claim as "unresolvable org" and denies (see
 *     backend/src/utils/auth-event.ts `extractOrgFromEvent`, which has NO
 *     fallback to the attribute).
 *
 * `custom:role` claim (finding 7aa877f8, then CIT-213): the stored
 * `custom:role` attribute is client-writable (absent an explicit Cognito
 * client WriteAttributes allow-list — since fixed separately — any
 * authenticated user could set it via UpdateUserAttributes), so it is a
 * forgeable input and this trigger NEVER READS IT. History:
 *   - finding 7aa877f8: group membership became authoritative for the
 *     admin value only — `admin` group forced the claim to 'admin', a
 *     stored `custom:role=admin` without the group was dropped, and
 *     non-admin stored values were still promoted verbatim.
 *   - CIT-213 (escalation 2026-09-30): a stored non-admin value (e.g.
 *     `architect`) was still a forgeable role assertion, so the attribute
 *     read was removed entirely. The claim is now derived from
 *     `groupConfiguration.groupsToOverride` ONLY:
 *       - 'admin' if the user is in the `admin` group;
 *       - otherwise the first KNOWN non-admin group in precedence order
 *         (`project_manager` > `architect` > `developer`);
 *       - otherwise the claim is omitted.
 *     Precedence: the CDK (backend-stack.ts) declares the four groups
 *     without a numeric Cognito `Precedence`, so Cognito supplies no
 *     ordering of its own; the order above is the CDK declaration order and
 *     the vocabulary is the group set pinned by
 *     single-global-admin-tier-tripwire.test.ts P1.
 *
 * The promoted `custom:role` claim is for DISPLAY/LEGACY consumers only. No
 * backend authorization path reads it — `cognito:groups` is the sole
 * authorization signal for every role (see backend/src/utils/auth-event.ts
 * `readGroups`/`deriveRoles`, pinned by
 * backend/test/cognito-claim-trust-tripwire.test.ts).
 *
 * Part of the Phase 1 org-scoping foundation.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { PreTokenGenerationTriggerEvent } from "aws-lambda";

/**
 * Non-admin groups whose membership may be surfaced as the display
 * `custom:role` claim, highest precedence first. Must stay a subset of the
 * CDK-declared Cognito group set.
 */
const NON_ADMIN_ROLE_PRECEDENCE = [
  "project_manager",
  "architect",
  "developer",
] as const;

/**
 * Pure derivation of the display `custom:role` claim from group membership.
 * Exported for direct unit testing; the handler is the only production
 * caller.
 */
export function deriveDisplayRole(
  groups: readonly string[],
): string | undefined {
  if (groups.includes("admin")) return "admin";
  return NON_ADMIN_ROLE_PRECEDENCE.find((g) => groups.includes(g));
}

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The org claim name — minted from the membership table, or SUPPRESSED. */
const ORG_CLAIM = "custom:organization";

/**
 * Pure derivation of the `custom:organization` claim from a membership
 * row. Returns the row's `orgName` when it is a non-empty string, otherwise
 * undefined (claim omitted). Exported for direct unit testing.
 */
export function deriveOrgClaim(
  row: Record<string, unknown> | null | undefined,
): string | undefined {
  const orgName = row?.orgName;
  return typeof orgName === "string" && orgName.length > 0
    ? orgName
    : undefined;
}

/**
 * Resolves the caller's organisation from the membership table by Cognito
 * `sub`. Never throws: any failure (no key, table unconfigured, DynamoDB
 * error, row absent/malformed) logs a warning and returns undefined so the
 * claim is omitted — the fail-closed path.
 */
export async function resolveOrgClaim(
  sub: string | undefined,
): Promise<string | undefined> {
  if (!sub) {
    console.warn(
      "pre-token-generation: no sub/userName on event; omitting custom:organization claim",
    );
    return undefined;
  }
  const tableName = process.env.USER_ORG_MEMBERSHIP_TABLE;
  if (!tableName) {
    console.warn(
      "pre-token-generation: USER_ORG_MEMBERSHIP_TABLE not configured; omitting custom:organization claim",
      { sub },
    );
    return undefined;
  }
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { sub },
        // The row may have been written milliseconds ago by assignUserRole
        // (followed by a global sign-out and immediate re-login).
        ConsistentRead: true,
      }),
    );
    const org = deriveOrgClaim(result?.Item);
    if (!org) {
      console.warn(
        "pre-token-generation: no membership row for user; omitting custom:organization claim",
        { sub },
      );
    }
    return org;
  } catch (err) {
    console.warn(
      "pre-token-generation: membership lookup failed; omitting custom:organization claim",
      { sub, err: String(err) },
    );
    return undefined;
  }
}

export const handler = async (
  event: PreTokenGenerationTriggerEvent,
): Promise<PreTokenGenerationTriggerEvent> => {
  const userAttributes = event.request.userAttributes || {};
  const claimsToAddOrOverride: Record<string, string> = {};

  // The membership table is the ONLY input to the org claim. The stored
  // `custom:organization` attribute is deliberately not consulted (see
  // header) — not even as a fallback on lookup failure.
  const org = await resolveOrgClaim(userAttributes.sub || event.userName);
  if (org) claimsToAddOrOverride[ORG_CLAIM] = org;

  // Group membership is the ONLY input to the role claim. The stored
  // `custom:role` attribute is deliberately not consulted (see header).
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const role = deriveDisplayRole(groups);
  if (role) claimsToAddOrOverride["custom:role"] = role;

  event.response = event.response || {};
  const existing = event.response.claimsOverrideDetails || {};

  // Omission alone is NOT fail-closed. Cognito's default ID-token mapping
  // copies every client-READABLE user-pool attribute into the token, and
  // the pool client's readAttributes includes `custom:organization`
  // (backend-stack.ts). Without an explicit suppress, a user with no
  // membership row (pre-backfill, swept by deleteOrganization, or a
  // hand-edited attribute) would still receive `custom:organization=<stored
  // attribute>` in the ID token — which AppSync accepts and
  // extractOrgFromEvent reads. So whenever no org was resolved, actively
  // suppress the claim; merge with any suppress list already present.
  const claimsToSuppress = org
    ? existing.claimsToSuppress
    : mergeSuppress(existing.claimsToSuppress, ORG_CLAIM);

  event.response.claimsOverrideDetails = {
    ...existing,
    claimsToAddOrOverride,
    ...(claimsToSuppress ? { claimsToSuppress } : {}),
  };

  return event;
};

/** Appends `claim` to `list` unless already present (order preserved). */
function mergeSuppress(
  list: readonly string[] | undefined,
  claim: string,
): string[] {
  const base = list ?? [];
  return base.includes(claim) ? [...base] : [...base, claim];
}
