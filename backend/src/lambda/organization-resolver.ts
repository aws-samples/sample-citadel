import { deriveRoles } from "../utils/auth-event";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { v4 as uuidv4 } from "uuid";
import type { AuthContext } from "../types";

const client = new DynamoDBClient({});
// removeUndefinedValues: defensive guard so no undefined attribute can break
// PutCommand marshalling (Issue #14). The `input.description || ''` default in
// createOrganization handles the known case; this covers any future field.
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const cognitoClient = new CognitoIdentityProviderClient({});

const ORGANIZATIONS_TABLE = process.env.ORGANIZATIONS_TABLE || "";
const USER_POOL_ID = process.env.USER_POOL_ID || "";

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

/**
 * The key of the name-reservation/tombstone row for a given organisation
 * NAME, stored in the SAME `OrganisationTable` (partition key `orgId` only
 * — no separate table or GSI needed). This is the atomic uniqueness +
 * anti-reuse mechanism for decision 228b3cc8 (pieces 2 and 3):
 *
 *  - `itemType: "name_reservation"` — written by `createOrganization` with
 *    `ConditionExpression: attribute_not_exists(orgId)`, the SAME
 *    write-once idiom used throughout this codebase (eval-comparison-
 *    resolver.ts, eval-run-resolver.ts, execspec-resolver.ts, etc.) for
 *    atomic create-if-absent. Because DynamoDB conditional puts are
 *    evaluated atomically server-side, two concurrent `createOrganization`
 *    calls for the same name can no longer both succeed — the loser gets a
 *    `ConditionalCheckFailedException`, translated below into the existing
 *    "already exists" error. This replaces the prior Scan-then-Put race.
 *  - `itemType: "name_tombstone"` — the SAME row, flipped by
 *    `deleteOrganization` instead of being deleted. A tombstoned name can
 *    never be reserved again, closing the reuse gap the prior code's own
 *    comment warned about (a zero-user deleted name could be recreated and
 *    would inherit any surviving name-stamped rows in Projects/Workflows/
 *    RegistryAgentRecord/etc. — those dependents are still a known,
 *    separately-tracked gap; see the NOTE in deleteOrganization). Retaining
 *    a tombstone (rather than refusing deletion while ANY name-stamped ROW
 *    survives across every dependent table) is the safer AND simpler
 *    choice here: enumerating "any row anywhere stamped with this name" would
 *    require scanning tables this resolver has no handle on and no
 *    consistency guarantee over, whereas the reservation row this resolver
 *    already owns gives a single, race-free source of truth for whether a
 *    name may be issued again — at the cost of names never becoming
 *    available again once used, which matches the ratified "names are
 *    immutable and canonical" model.
 */
function nameReservationKey(name: string): string {
  return `NAME#${name}`;
}

interface NameReservationItem {
  orgId: string;
  itemType: "name_reservation" | "name_tombstone";
  name: string;
  reservedOrgId?: string;
  createdAt: string;
  tombstonedAt?: string;
}

/** AppSync event slice this resolver reads. */
interface OrganizationResolverEvent {
  info: { fieldName: string };
  arguments: { input: CreateOrganizationInput; orgId: string };
  identity?: {
    sub?: string;
    username?: string;
    ["cognito:groups"]?: string[];
    claims?: Record<string, string>;
    ["custom:role"]?: string;
  };
}

// Admin gate — mirrors eval-sampling-config-resolver.ts / promotion-policy-resolver.ts
// exactly: same shape, same error string, same fail-closed doctrine. Any
// failure to resolve a role (missing identity, missing claim, resolver
// exception) results in `roles` being empty, so requireAdmin always refuses
// rather than defaulting open.
function requireAdmin(authContext: AuthContext, action: string): void {
  if (!authContext.roles?.includes("admin")) {
    throw new Error(`UnauthorizedError: admin role required to ${action}`);
  }
}

function authContextFromEvent(event: OrganizationResolverEvent): AuthContext {
  const identity = event?.identity || {};
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: deriveRoles(event),
  };
}

export const handler = async (
  event: OrganizationResolverEvent,
): Promise<unknown> => {
  console.log("Organization resolver event:", JSON.stringify(event, null, 2));

  // AppSync delivers the operation name under event.info.fieldName (not
  // event.fieldName). Reading the wrong path left fieldName undefined, so every
  // dispatch fell through to the default case → 'Unknown field: undefined'
  // (Issue #14). Match project-resolver.ts + docs/RESOLVER_GUIDE.md.
  const { info, arguments: args } = event;
  const fieldName = info.fieldName;

  try {
    switch (fieldName) {
      case "createOrganization": {
        // Resolve authContext INSIDE the try/case so that any exception
        // thrown while deriving it (malformed identity, etc.) is caught by
        // the existing catch-and-rethrow below and surfaces as a refusal —
        // never as an unhandled crash that could be mistaken for "allow".
        // Placed BEFORE any Cognito or DynamoDB call, mirroring
        // deleteOrganization's gate (finding c79cd4f6).
        const authContext = authContextFromEvent(event);
        requireAdmin(authContext, "create an organization");
        return await createOrganization(args.input);
      }
      case "deleteOrganization": {
        // Resolve authContext INSIDE the try/case so that any exception thrown
        // while deriving it (malformed identity, etc.) is caught by the
        // existing catch-and-rethrow below and surfaces as a refusal — never
        // as an unhandled crash that could be mistaken for "allow".
        const authContext = authContextFromEvent(event);
        requireAdmin(authContext, "delete an organization");
        return await deleteOrganization(args.orgId);
      }
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: unknown) {
    console.error(`Error in ${fieldName}:`, error);
    throw error;
  }
};

async function createOrganization(
  input: CreateOrganizationInput,
): Promise<Organization> {
  console.log("Creating organization:", input);

  const reservationKey = nameReservationKey(input.name);
  const now = new Date().toISOString();

  // Reject a tombstoned name up front with a clear message, before
  // attempting the reservation write. This is a plain read (not itself
  // race-free against a concurrent tombstone), but the atomic reservation
  // Put below is the actual uniqueness guarantee — this check only exists
  // to give a clear, specific error instead of a generic "already exists"
  // when the cause is reuse-of-a-deleted-name rather than a live duplicate.
  const existingReservation = await docClient.send(
    new GetCommand({
      TableName: ORGANIZATIONS_TABLE,
      Key: { orgId: reservationKey },
    }),
  );
  const existingItem = existingReservation.Item as
    NameReservationItem | undefined;
  if (existingItem?.itemType === "name_tombstone") {
    throw new Error(
      `Organization name "${input.name}" was previously used and deleted; it cannot be reused. Choose a different name.`,
    );
  }

  // DEFENCE IN DEPTH (finding 003a9234, mechanism 3) — BACKSTOP, not the
  // primary guarantee. The conditional put below (ConditionExpression:
  // attribute_not_exists(orgId) on the NAME# reservation row) remains the
  // ATOMIC AUTHORITY for uniqueness — it is race-free under concurrent
  // creates and is what actually prevents two callers from both winning.
  // This row-level Scan exists ONLY because the reservation side table can
  // drift from the organisation rows it is meant to describe: a seeder bug,
  // a manually-inserted org row, a pre-existing org from before the
  // reservation mechanism shipped, or a future migration could all leave an
  // organisation with NO matching NAME# row. In that drifted state the
  // conditional put alone would see attribute_not_exists(orgId) succeed and
  // silently let a duplicate through even though a live org already holds
  // the name. This Scan is NOT atomic (another create can race between this
  // read and the Put below) — that race is still closed by the conditional
  // Put's ConditionExpression, so this check is a correctness backstop
  // against drift, not a concurrency control.
  const existingOrgWithName = await docClient.send(
    new ScanCommand({
      TableName: ORGANIZATIONS_TABLE,
      FilterExpression: "#name = :name AND attribute_not_exists(itemType)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": input.name },
    }),
  );
  if (existingOrgWithName.Items && existingOrgWithName.Items.length > 0) {
    throw new Error(`Organization with name "${input.name}" already exists`);
  }

  // Atomic name reservation: a conditional put keyed on `NAME#<name>` with
  // ConditionExpression: attribute_not_exists(orgId). This is the SAME
  // write-once idiom this codebase already uses (eval-comparison-resolver.ts,
  // eval-run-resolver.ts, execspec-resolver.ts, etc.) — DynamoDB evaluates the
  // condition atomically server-side, so two concurrent creates for the same
  // name can no longer both succeed. This replaces the prior
  // Scan-then-Put (finding: non-atomic, race-prone).
  try {
    await docClient.send(
      new PutCommand({
        TableName: ORGANIZATIONS_TABLE,
        Item: {
          orgId: reservationKey,
          itemType: "name_reservation",
          name: input.name,
          createdAt: now,
        } satisfies NameReservationItem,
        ConditionExpression: "attribute_not_exists(orgId)",
      }),
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      throw new Error(`Organization with name "${input.name}" already exists`);
    }
    throw error;
  }

  const orgId = uuidv4();

  const organization: Organization = {
    orgId,
    name: input.name,
    // Default to '' (matches project-resolver.ts). Writing `undefined` breaks
    // DynamoDB marshalling in the real client → Lambda:Unhandled (Issue #14).
    description: input.description || "",
    createdAt: now,
  };

  // Stamp the reservation row with the orgId it reserved for, so
  // deleteOrganization can find/tombstone it without a Scan.
  await docClient.send(
    new UpdateCommand({
      TableName: ORGANIZATIONS_TABLE,
      Key: { orgId: reservationKey },
      UpdateExpression: "SET reservedOrgId = :reservedOrgId",
      ExpressionAttributeValues: { ":reservedOrgId": orgId },
    }),
  );

  await docClient.send(
    new PutCommand({
      TableName: ORGANIZATIONS_TABLE,
      Item: organization,
    }),
  );

  console.log("Organization created:", organization);
  return organization;
}

async function deleteOrganization(
  orgId: string,
): Promise<UserManagementResponse> {
  console.log("Deleting organization:", orgId);

  // 1. Existence check (preserved from prior behaviour, runs FIRST so a
  //    missing-org request short-circuits before any Cognito call).
  const existingOrgs = await docClient.send(
    new ScanCommand({
      TableName: ORGANIZATIONS_TABLE,
      FilterExpression: "orgId = :orgId",
      ExpressionAttributeValues: {
        ":orgId": orgId,
      },
    }),
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
      "Cannot delete organization: organization record has no name; orphan-user verification cannot run.",
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
      "Cannot delete organization: USER_POOL_ID is not configured; orphan-user verification cannot run.",
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
      }),
    );

    for (const user of usersResponse.Users ?? []) {
      const assignedToOrg = (user.Attributes ?? []).some(
        (attr) => attr.Name === "custom:organization" && attr.Value === orgName,
      );
      if (assignedToOrg) {
        throw new Error(
          "Cannot delete organization: 1+ user(s) still assigned. Reassign or remove these users before deleting the organization.",
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
    }),
  );

  // 4. Tombstone the freed name so it can never be reserved again (decision
  //    228b3cc8, piece 3). The name-reservation row created by
  //    createOrganization is NOT deleted — it is flipped to
  //    `itemType: "name_tombstone"` and retained permanently. This closes
  //    the reuse gap the delete's own former comment warned about: a
  //    zero-user deleted name could otherwise be recreated and would
  //    inherit any surviving name-stamped rows in other tables (Projects,
  //    Workflows, RegistryAgentRecord, ...) that this resolver does not own
  //    and cannot clean up. Best-effort: if the org row was deleted but the
  //    reservation cannot be found/tombstoned (e.g. it predates this
  //    change), log and continue rather than leaving the org half-deleted.
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: ORGANIZATIONS_TABLE,
        Key: { orgId: nameReservationKey(orgName) },
        UpdateExpression:
          "SET itemType = :tombstone, tombstonedAt = :tombstonedAt",
        ExpressionAttributeValues: {
          ":tombstone": "name_tombstone",
          ":tombstonedAt": new Date().toISOString(),
        },
        // The reservation row must already exist (created atomically by
        // createOrganization) — if it doesn't, this is a pre-existing org
        // created before this mechanism shipped. Don't silently create a
        // reservation row here (that would race with a concurrent create
        // using the same name that has no reservation to check against);
        // just log and move on. The org itself is already deleted above.
        ConditionExpression: "attribute_exists(orgId)",
      }),
    );
  } catch (error: unknown) {
    console.error(
      `Could not tombstone name reservation for "${orgName}" (orgId ${orgId}); ` +
        "the org row is deleted but the name may remain reusable if no " +
        "reservation row pre-existed:",
      error,
    );
  }

  console.log("Organization deleted:", orgId);
  return {
    success: true,
    message: `Organization deleted successfully`,
  };
}
