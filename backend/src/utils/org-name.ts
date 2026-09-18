import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

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
 *    `ConditionalCheckFailedException`, translated by organization-
 *    resolver.ts into the existing "already exists" error.
 *  - `itemType: "name_tombstone"` — the SAME row, flipped by
 *    `deleteOrganization` instead of being deleted. A tombstoned name can
 *    never be reserved again.
 *
 * Moved here (from organization-resolver.ts) so it can be shared with the
 * write-boundary validation in user-management-resolver.ts (Wave-3B design
 * item 1) without duplicating the `NAME#` prefix in two files.
 */
export function orgNameReservationKey(name: string): string {
  return `NAME#${name}`;
}

export interface NameReservationItem {
  orgId: string;
  itemType: "name_reservation" | "name_tombstone";
  name: string;
  reservedOrgId?: string;
  createdAt: string;
  tombstonedAt?: string;
}

/**
 * Write-boundary organisation-name validation (Wave-3B design item 1,
 * finding: adminCreateUser/assignUserRole accepted any string as
 * `custom:organization` with no existence check, letting a typo or
 * already-deleted org name be written into a live Cognito attribute).
 *
 * Does a POINT GetItem on the `NAME#<name>` reservation row — never a Scan
 * — and rejects two distinct cases with distinct messages:
 *   - no row at all: the name was never a real organisation.
 *   - `itemType === "name_tombstone"`: the name belonged to a deleted
 *     organisation and can never be reused (decision 228b3cc8 piece 3).
 *
 * EXACT match, NO trim/normalize. `createOrganization` stores names
 * verbatim (organization-resolver.ts), so trimming here would let a
 * stray-whitespace value validate against a canonical name it does not
 * byte-match, diverging from the "claim === canonical name" invariant
 * (see auth-event.ts's canonical tenancy rule / decision 228b3cc8).
 */
export async function assertOrgNameExists(
  doc: DynamoDBDocumentClient,
  tableName: string,
  name: string,
): Promise<void> {
  const result = await doc.send(
    new GetCommand({
      TableName: tableName,
      Key: { orgId: orgNameReservationKey(name) },
    }),
  );

  const item = result.Item as NameReservationItem | undefined;

  if (!item) {
    throw new Error(
      `Organization "${name}" does not exist. Choose an organization from the list.`,
    );
  }

  if (item.itemType === "name_tombstone") {
    throw new Error(`Organization "${name}" was deleted and cannot be reused.`);
  }
}
