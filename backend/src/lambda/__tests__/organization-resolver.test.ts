/**
 * Tests for organization-resolver Lambda.
 *
 * Regression coverage for Issue #14 — "Team Management Add/Delete Organization
 * fails with 'Unknown field: undefined' (Lambda:Unhandled)":
 *   - Bug (a): the handler must dispatch on `event.info.fieldName` (the real
 *     AppSync $context shape), NOT `event.fieldName`. `makeEvent` below builds
 *     the REAL AppSync event so the dispatch path is exercised exactly as
 *     production sees it. (The previous helper produced a fake `{ fieldName }`
 *     object that agreed with the buggy resolver and masked the defect.)
 *   - Bug (b): `createOrganization` must never place `description: undefined`
 *     into the DynamoDB item — it must default to '' (matching
 *     project-resolver.ts `input.description || ''`) so PutCommand marshalling
 *     in the real (unmocked) client cannot throw.
 *
 * Decision 228b3cc8, pieces 2 and 3 — name uniqueness and reuse prevention:
 *   - `createOrganization` no longer does a Scan-then-Put for uniqueness
 *     (non-atomic, race-prone). It now does an atomic conditional Put of a
 *     `NAME#<name>` reservation row (`ConditionExpression:
 *     attribute_not_exists(orgId)`) in the SAME OrganisationTable, mirroring
 *     the write-once idiom used across this codebase.
 *   - `deleteOrganization` no longer leaves the name free for reuse: the
 *     reservation row is flipped to a permanent tombstone instead of being
 *     removed, and `createOrganization` rejects a tombstoned name with a
 *     clear message.
 */
// Env vars must be set BEFORE the resolver module loads — the resolver
// captures process.env values into top-level constants at import time.
process.env.ORGANIZATIONS_TABLE = "test-orgs";
process.env.USER_POOL_ID = "us-east-1_testpool";

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
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("org-uuid-123") }));

import { handler } from "../organization-resolver";

/** Builds a ConditionalCheckFailedException the same way AWS SDK v3 does. */
function conditionalCheckFailed(): Error {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

describe("organization-resolver", () => {
  beforeEach(() => {
    dynamoMock.reset();
    cognitoMock.reset();
    // Default: no existing reservation/tombstone row for any name, unless a
    // test overrides this with a more specific `.on(GetCommand, {...})` stub.
    dynamoMock.on(GetCommand).resolves({ Item: undefined });
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(UpdateCommand).resolves({});
  });

  // REAL AppSync $context shape: the field name lives under `info.fieldName`,
  // with `arguments` and `identity` alongside — matching project-resolver.test.ts
  // and docs/RESOLVER_GUIDE.md.
  const makeEvent = (
    fieldName: string,
    args: Record<string, unknown>,
    identity?: Record<string, unknown>,
  ) => ({
    info: { fieldName },
    arguments: args,
    identity: identity ?? { sub: "user-1" },
  });

  const adminIdentity = {
    sub: "admin-1",
    "custom:role": "admin",
    "cognito:groups": ["admin"],
  };
  const nonAdminIdentity = { sub: "user-1", "custom:role": "project_manager" };

  describe("createOrganization — admin authorization gate (finding c79cd4f6)", () => {
    // RED: a non-admin caller must be refused BEFORE any AWS call — zero
    // Cognito and zero DynamoDB calls on the refusal path.
    test("refuses a non-admin caller before any Cognito or DynamoDB call", async () => {
      await expect(
        handler(
          makeEvent(
            "createOrganization",
            { input: { name: "New Org" } },
            nonAdminIdentity,
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
    });

    // RED: identity that resolves to no role at all (missing custom:role
    // claim entirely) must also be refused — fail closed, never fail open.
    test("refuses when identity has no resolvable role", async () => {
      await expect(
        handler(
          makeEvent(
            "createOrganization",
            { input: { name: "New Org" } },
            { sub: "user-2" },
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    // RED: identity-resolution failure (no identity object at all, e.g. an
    // IAM/unauthenticated-role invocation path) must refuse, not crash open.
    test("refuses when the event has no identity at all", async () => {
      const event = {
        info: { fieldName: "createOrganization" },
        arguments: { input: { name: "New Org" } },
      };
      await expect(handler(event)).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    // RED: a malformed claim (custom:role present but empty string) must
    // resolve to no role and be refused — fail closed on garbage input.
    test("refuses when custom:role claim is malformed (empty string)", async () => {
      await expect(
        handler(
          makeEvent(
            "createOrganization",
            { input: { name: "New Org" } },
            { sub: "user-3", "custom:role": "" },
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    // GREEN: an admin caller still succeeds through the full existing flow.
    test("allows an admin caller through to the existing create flow", async () => {
      const result = await handler(
        makeEvent(
          "createOrganization",
          { input: { name: "New Org" } },
          adminIdentity,
        ),
      );

      expect(result.orgId).toBe("org-uuid-123");
      // Two PutCommands: the name reservation row, then the org row itself.
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(2);
    });
  });

  describe("createOrganization", () => {
    test("creates organization when name is unique and preserves the description", async () => {
      const result = await handler(
        makeEvent(
          "createOrganization",
          { input: { name: "New Org", description: "A test org" } },
          adminIdentity,
        ),
      );

      expect(result.orgId).toBe("org-uuid-123");
      expect(result.name).toBe("New Org");
      expect(result.description).toBe("A test org");
      expect(result.createdAt).toBeDefined();

      const putCalls = dynamoMock.commandCalls(PutCommand);
      // Reservation row put first, org row put second.
      expect(putCalls).toHaveLength(2);
      const reservationItem = putCalls[0].args[0].input.Item as Record<
        string,
        unknown
      >;
      expect(reservationItem.orgId).toBe("NAME#New Org");
      expect(reservationItem.itemType).toBe("name_reservation");
      const orgItem = putCalls[1].args[0].input.Item as Record<string, unknown>;
      expect(orgItem.description).toBe("A test org");
    });

    test("creates organization with a blank description and writes NO undefined attribute", async () => {
      // `description` omitted from input -> resolver must default it to ''.
      const result = await handler(
        makeEvent(
          "createOrganization",
          { input: { name: "No Desc Org" } },
          adminIdentity,
        ),
      );

      expect(result.orgId).toBe("org-uuid-123");
      expect(result.name).toBe("No Desc Org");
      // Defaulted to '' (matches project-resolver.ts `input.description || ''`).
      expect(result.description).toBe("");

      // The org-row PutCommand Item must contain NO attribute whose value is
      // undefined. An undefined value throws during DynamoDB marshalling in
      // the real (unmocked) client and produced the Lambda:Unhandled error
      // in Issue #14.
      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(2);
      const item = putCalls[1].args[0].input.Item as Record<string, unknown>;
      expect(item.description).toBe("");
      const undefinedAttrs = Object.entries(item)
        .filter(([, v]) => v === undefined)
        .map(([k]) => k);
      expect(undefinedAttrs).toEqual([]);
    });

    // RATIFIED decision 228b3cc8, piece 2: uniqueness is now an ATOMIC
    // conditional put, not a Scan-then-Put. A duplicate name must be
    // rejected via the ConditionalCheckFailedException path, and NO org row
    // must ever be written when the reservation Put fails.
    test("throws when organization name already exists (conditional put rejected)", async () => {
      // Reservation put (the FIRST PutCommand in createOrganization) is
      // rejected with a ConditionalCheckFailedException, simulating a name
      // that is already reserved (live or otherwise).
      dynamoMock.on(PutCommand).rejectsOnce(conditionalCheckFailed());

      await expect(
        handler(
          makeEvent(
            "createOrganization",
            { input: { name: "Duplicate" } },
            adminIdentity,
          ),
        ),
      ).rejects.toThrow("already exists");

      // The reservation Put was attempted (and rejected) but the org row
      // Put must NEVER have been reached.
      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
    });

    // RACE: two concurrent creates for the same name — the conditional put
    // ensures at most one can win. This test simulates the loser's path by
    // asserting the reservation Put carries the correct
    // ConditionExpression, which is what DynamoDB evaluates atomically
    // server-side to prevent the race (this test cannot exercise real
    // concurrency against a mock, so it pins the CONTRACT: the put must be
    // conditional, not a preceding read-then-write).
    test("reservation put uses attribute_not_exists(orgId) as its ConditionExpression (atomic guard, not Scan-then-Put)", async () => {
      await handler(
        makeEvent(
          "createOrganization",
          { input: { name: "Race Org" } },
          adminIdentity,
        ),
      );

      const putCalls = dynamoMock.commandCalls(PutCommand);
      const reservationCall = putCalls.find(
        (c) =>
          (c.args[0].input.Item as Record<string, unknown>).orgId ===
          "NAME#Race Org",
      );
      expect(reservationCall).toBeDefined();
      expect(reservationCall!.args[0].input.ConditionExpression).toBe(
        "attribute_not_exists(orgId)",
      );
      // No Scan is used anywhere in the create path anymore.
      expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(0);
    });

    // RATIFIED decision 228b3cc8, piece 3: a tombstoned name (previously
    // used and deleted) must be rejected with a clear, distinguishable
    // message — and must never reach the reservation Put.
    test("rejects a tombstoned name with a clear message and does not attempt the reservation put", async () => {
      dynamoMock
        .on(GetCommand, {
          TableName: "test-orgs",
          Key: { orgId: "NAME#Retired Org" },
        })
        .resolves({
          Item: {
            orgId: "NAME#Retired Org",
            itemType: "name_tombstone",
            name: "Retired Org",
            createdAt: "2024-01-01T00:00:00Z",
            tombstonedAt: "2024-02-01T00:00:00Z",
          },
        });

      await expect(
        handler(
          makeEvent(
            "createOrganization",
            { input: { name: "Retired Org" } },
            adminIdentity,
          ),
        ),
      ).rejects.toThrow(/previously used and deleted/);

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    // A LIVE reservation (not yet tombstoned) for the same name must NOT be
    // short-circuited by the tombstone-check message — it must still reach
    // the conditional put path and surface as "already exists" via the
    // ConditionalCheckFailedException route (not the tombstone message).
    test("a live (non-tombstoned) reservation is NOT rejected by the tombstone check; falls through to the conditional put", async () => {
      dynamoMock
        .on(GetCommand, {
          TableName: "test-orgs",
          Key: { orgId: "NAME#Live Org" },
        })
        .resolves({
          Item: {
            orgId: "NAME#Live Org",
            itemType: "name_reservation",
            name: "Live Org",
            reservedOrgId: "some-other-org-id",
            createdAt: "2024-01-01T00:00:00Z",
          },
        });
      // Reservation put (the FIRST PutCommand) is rejected — the name is
      // already actively reserved.
      dynamoMock.on(PutCommand).rejectsOnce(conditionalCheckFailed());

      await expect(
        handler(
          makeEvent(
            "createOrganization",
            { input: { name: "Live Org" } },
            adminIdentity,
          ),
        ),
      ).rejects.toThrow("already exists");
    });
  });

  describe("deleteOrganization — admin authorization gate (finding b4870abe)", () => {
    // RED: a non-admin caller must be refused BEFORE any AWS call — zero
    // Cognito and zero DynamoDB calls on the refusal path.
    test("refuses a non-admin caller before any Cognito or DynamoDB call", async () => {
      await expect(
        handler(
          makeEvent("deleteOrganization", { orgId: "org-1" }, nonAdminIdentity),
        ),
      ).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
    });

    // RED: identity that resolves to no role at all (missing custom:role
    // claim entirely) must also be refused — fail closed, never fail open.
    test("refuses when identity has no resolvable role", async () => {
      await expect(
        handler(
          makeEvent(
            "deleteOrganization",
            { orgId: "org-1" },
            { sub: "user-2" },
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    // RED: identity-resolution failure (no identity object at all, e.g. an
    // IAM/unauthenticated-role invocation path) must refuse, not crash open.
    test("refuses when the event has no identity at all", async () => {
      const event = {
        info: { fieldName: "deleteOrganization" },
        arguments: { orgId: "org-1" },
      };
      await expect(handler(event)).rejects.toThrow(/UnauthorizedError/);

      expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    // GREEN: an admin caller still succeeds through the full existing flow.
    test("allows an admin caller through to the existing delete flow", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
      );

      expect(result.success).toBe(true);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });
  });

  describe("deleteOrganization", () => {
    // Orphan-user guard rationale (Issue #14, 2nd bug): the user↔org link lives
    // ONLY in the Cognito `custom:organization` user-pool attribute. Cognito
    // ListUsers supports server-side `Filter` on STANDARD attributes only — a
    // `custom:*` Filter raises InvalidParameterException ("Input fails to
    // satisfy the constraints") in the real service (aws-sdk-client-mock does
    // NOT enforce that constraint, which is exactly what masked the bug). The
    // resolver must therefore PAGINATE ListUsers and match attributes
    // client-side, failing closed on the first match.

    // (b): a delete SUCCEEDS when users exist in the pool but NONE carry
    // custom:organization === the org NAME — the resolver must discriminate on
    // the attribute value, not merely on "any users returned". The org's
    // orgId (a UUID) differs from its name, so a user still carrying the orgId
    // as its attribute value must NOT block the delete (Issue #19).
    test("deletes organization when no user matches the org name, then calls DeleteCommand", async () => {
      // Existence check returns the org row (name differs from orgId).
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      // Users exist but NONE carry custom:organization === 'Operations'.
      // 'other-1' still holds the orgId UUID — proving the guard keys off name.
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          {
            Username: "other-1",
            Attributes: [{ Name: "custom:organization", Value: "org-1" }],
          },
          {
            Username: "diff-org",
            Attributes: [
              { Name: "custom:organization", Value: "different-org" },
            ],
          },
          { Username: "no-attr", Attributes: [] },
        ],
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
      );

      expect(result.success).toBe(true);
      // DeleteCommand ran exactly once.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    // (c): the ListUsers input must NOT contain a `custom:` attribute Filter —
    // that server-side filter is precisely what Cognito rejects.
    test("does NOT send a custom: attribute Filter to ListUsers", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      dynamoMock.on(DeleteCommand).resolves({});

      await handler(
        makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
      );

      const listUsersCalls = cognitoMock.commandCalls(ListUsersCommand);
      expect(listUsersCalls.length).toBeGreaterThanOrEqual(1);
      const listInput = listUsersCalls[0].args[0].input;
      expect(listInput.UserPoolId).toBe("us-east-1_testpool");
      const filterStr =
        listInput.Filter === undefined ? "" : String(listInput.Filter);
      expect(filterStr.includes("custom:")).toBe(false);
    });

    // (a): delete is BLOCKED (fail-closed) when a returned user's
    // custom:organization attribute equals the target org NAME.
    test("throws when a user custom:organization matches the org name, DeleteCommand NOT called", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          {
            Username: "still-here-user",
            Attributes: [{ Name: "custom:organization", Value: "Operations" }],
          },
        ],
      });

      await expect(
        handler(
          makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
        ),
      ).rejects.toThrow(/user\(s\) still assigned/);

      // DeleteCommand must NOT have run.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    // (a'): regression for Issue #19 — the guard must key off the org NAME,
    // not the orgId. A user whose custom:organization holds the orgId UUID
    // (which is NEVER what the attribute actually stores) must NOT block the
    // delete; the pre-fix code compared against orgId and would wrongly block
    // here while wrongly allowing the real name-valued case above.
    test("does NOT block on the orgId UUID (custom:organization stores the name, not the id)", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          {
            Username: "carries-uuid",
            Attributes: [{ Name: "custom:organization", Value: "org-1" }],
          },
        ],
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
      );

      expect(result.success).toBe(true);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    // (d): pagination — a match on the SECOND page must still block the delete.
    // Page 1 returns a non-matching user + PaginationToken; page 2 returns the
    // match. The resolver must follow the token and catch it.
    test("paginates ListUsers and blocks the delete on a second-page match", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock
        .on(ListUsersCommand)
        .resolvesOnce({
          Users: [
            {
              Username: "other",
              Attributes: [
                { Name: "custom:organization", Value: "different-org" },
              ],
            },
          ],
          PaginationToken: "page-2-token",
        })
        .resolvesOnce({
          Users: [
            {
              Username: "matching-user",
              Attributes: [
                { Name: "custom:organization", Value: "Operations" },
              ],
            },
          ],
        });

      await expect(
        handler(
          makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
        ),
      ).rejects.toThrow(/user\(s\) still assigned/);

      // Both pages were fetched — the PaginationToken from page 1 was followed.
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(2);
      // And the delete was blocked.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    test('throws "not found" and does NOT call Cognito when organization does not exist', async () => {
      // Existence check returns no row.
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      await expect(
        handler(
          makeEvent("deleteOrganization", { orgId: "missing" }, adminIdentity),
        ),
      ).rejects.toThrow("not found");

      // Cognito must NOT be consulted — existence check short-circuits first.
      // Pins the ordering invariant: existence-check → user-count check → delete.
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    // RATIFIED decision 228b3cc8, piece 3: a successful delete must
    // TOMBSTONE the freed name (flip the reservation row), not merely
    // delete the org row and leave the name free.
    test("tombstones the name reservation row after a successful delete", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
      );

      expect(result.success).toBe(true);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      const updateInput = updateCalls[0].args[0].input;
      expect(updateInput.Key).toEqual({ orgId: "NAME#Operations" });
      expect(updateInput.ExpressionAttributeValues?.[":tombstone"]).toBe(
        "name_tombstone",
      );
    });

    // If tombstoning fails (e.g. no pre-existing reservation row for an org
    // created before this mechanism shipped), the delete must still be
    // reported as successful — the org row is already gone, and this is a
    // best-effort closure of the reuse gap, not a blocking step.
    test("delete still succeeds even if tombstoning the reservation row fails", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: "org-1", name: "Operations" }],
      });
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      dynamoMock.on(DeleteCommand).resolves({});
      dynamoMock.on(UpdateCommand).rejects(conditionalCheckFailed());

      const result = await handler(
        makeEvent("deleteOrganization", { orgId: "org-1" }, adminIdentity),
      );

      expect(result.success).toBe(true);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });
  });

  test("throws a clear error naming the unknown field", async () => {
    // Dispatch must resolve the real field name from info.fieldName — an
    // unknown field yields 'Unknown field: <name>', never 'Unknown field: undefined'.
    await expect(handler(makeEvent("unknownField", {}))).rejects.toThrow(
      "Unknown field: unknownField",
    );
  });
});
