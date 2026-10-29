/**
 * adminCreateUser — wires the organisation claim at user creation
 * (decision 228b3cc8 piece 5 / finding cbbc3be1).
 *
 * Defect: adminCreateUser set only email, email_verified, given_name and
 * family_name on AdminCreateUserCommand. The organisation was applied
 * SOLELY by a separate, OPTIONAL assignUserRole call the frontend happened
 * to make afterwards (Team.tsx's handleAddUser only calls assignUserRole
 * if a role was also selected — organisation-only, no-role creation left
 * the user with NO custom:organization claim at all). A user with no claim
 * fails closed across every org-scoped resolver (by design — see
 * user-management-resolver-org-scoping.test.ts and the no-caller-org-
 * fallback-idiom guard) but that "fails closed" only helps once the user
 * already has SOME resolvable identity; a user who can never pass ANY
 * org-scoped check is a support burden, not a security feature, and the
 * root cause is that organisation assignment was optional at the one
 * point (admin-only creation) it could have been enforced.
 *
 * DECISION: `organization` is now a REQUIRED field on
 * `AdminCreateUserInput` (both the GraphQL schema and the resolver code
 * enforce this) rather than defaulting to some organisation if omitted.
 * Team.tsx's Add User dialog already collects an organisation from
 * `organizations` (name-valued, per the ratified NAME-is-canonical
 * convention) — inventing a silent default (e.g. "Default") would let a
 * caller who forgets to pick one create a user in the wrong tenant without
 * any signal, which is a worse failure mode than a clear upfront
 * validation error. This keeps `adminCreateUser` an admin-only write (PR
 * 146: custom:organization stays non-user-writable) — the value comes from
 * the input, not from any self-service path.
 */
process.env.USER_POOL_ID = "us-east-1_testpool";
process.env.ORGANISATION_TABLE = "test-orgs";
process.env.USER_ORG_MEMBERSHIP_TABLE = "test-user-org-membership";

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from "../user-management-resolver";

type ResolverEvent = Parameters<typeof handler>[0];

function buildEvent(
  fieldName: string,
  identity: ResolverEvent["identity"],
  args: Partial<ResolverEvent["arguments"]> = {},
): ResolverEvent {
  return {
    info: { fieldName },
    identity,
    arguments: args as ResolverEvent["arguments"],
  };
}

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
    .resolves({ Groups: [{ GroupName: "admin" }] });

  // AdminGetUserCommand returns a sub for the newly created user so the
  // membership-table write (decision 00d40a31 / finding H20) succeeds.
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: "sub", Value: "new-user-sub-123" },
      { Name: "email", Value: "new.user@example.com" },
    ],
  });

  // Write-boundary org validation (Wave-3B design item 1) does a point
  // GetItem on the NAME# reservation row before any Cognito write. Stub a
  // live name_reservation row so the pre-existing happy-path tests in this
  // file (which predate assertOrgNameExists and never mocked DynamoDB)
  // keep exercising adminCreateUser's own behaviour rather than failing on
  // an unmocked DynamoDBDocumentClient call.
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({
    Item: {
      orgId: "NAME#Engineering",
      itemType: "name_reservation",
      name: "Engineering",
      createdAt: new Date().toISOString(),
    },
  });
  ddbMock.on(PutCommand).resolves({});
});

describe("adminCreateUser — organization is required and wired into custom:organization", () => {
  test("sets custom:organization on AdminCreateUserCommand from a supplied organization", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Engineering",
        },
      },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    const calls = cognitoMock.commandCalls(AdminCreateUserCommand);
    expect(calls).toHaveLength(1);
    const attrs = calls[0].args[0].input.UserAttributes ?? [];
    const orgAttr = attrs.find((a) => a.Name === "custom:organization");
    expect(orgAttr?.Value).toBe("Engineering");
  });

  test("still sets email, email_verified, given_name and family_name (pre-existing behaviour preserved)", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Engineering",
        },
      },
    );

    await handler(event);

    const attrs =
      cognitoMock.commandCalls(AdminCreateUserCommand)[0].args[0].input
        .UserAttributes ?? [];
    const byName = (n: string) => attrs.find((a) => a.Name === n)?.Value;
    expect(byName("email")).toBe("new.user@example.com");
    expect(byName("email_verified")).toBe("true");
    expect(byName("given_name")).toBe("New");
    expect(byName("family_name")).toBe("User");
  });

  test("rejects a create with NO organization, with a clear message, and does NOT call AdminCreateUserCommand (fail clearly, no silent default)", async () => {
    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "no-org@example.com",
          givenName: "No",
          familyName: "Org",
        },
      },
    );

    const result = (await handler(event)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/organization/i);

    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  test("rejects a create with an EMPTY-STRING organization the same way as a missing one", async () => {
    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "blank-org@example.com",
          givenName: "Blank",
          familyName: "Org",
          organization: "",
        },
      },
    );

    const result = (await handler(event)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/organization/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  test("still requires admin (non-admin caller refused, no Cognito call)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "adminCreateUser",
      { username: "alice" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Engineering",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/administrators/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

describe("adminCreateUser — membership table write (finding H20 / decision 00d40a31)", () => {
  test("writes UserOrgMembership row with the INPUT organization, not the caller's org", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "alpha.user@example.com",
          givenName: "Alpha",
          familyName: "User",
          organization: "Alpha",
        },
      },
    );

    // Stub the org-name reservation for "Alpha"
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "NAME#Alpha",
        itemType: "name_reservation",
        name: "Alpha",
        createdAt: new Date().toISOString(),
      },
    });
    ddbMock.on(PutCommand).resolves({});

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const putItem = putCalls[0].args[0].input.Item;
    expect(putItem).toMatchObject({
      sub: "new-user-sub-123",
      orgName: "Alpha",
    });
    expect(putItem?.updatedBy).toBe("admin-user");
    expect(putItem?.updatedAt).toBeDefined();
    expect(putCalls[0].args[0].input.TableName).toBe(
      "test-user-org-membership",
    );
  });

  test("invalid organization is refused with no Cognito call", async () => {
    ddbMock.reset();
    // No reservation row → assertOrgNameExists throws
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "bad-org@example.com",
          givenName: "Bad",
          familyName: "Org",
          organization: "NonExistent",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/does not exist/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  test("membership PutCommand failure compensates by deleting the Cognito user", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "NAME#Engineering",
        itemType: "name_reservation",
        name: "Engineering",
        createdAt: new Date().toISOString(),
      },
    });
    ddbMock.on(PutCommand).rejects(new Error("DynamoDB throttle"));

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "fail-put@example.com",
          givenName: "Fail",
          familyName: "Put",
          organization: "Engineering",
        },
      },
    );

    const result = (await handler(event)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/membership/i);

    // Verify compensation: AdminDeleteUserCommand was called
    const deleteCalls = cognitoMock.commandCalls(AdminDeleteUserCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Username).toBe("fail-put@example.com");
  });

  test("missing sub after AdminCreateUser compensates by deleting the Cognito user", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});
    cognitoMock.on(AdminDeleteUserCommand).resolves({});
    // AdminGetUserCommand returns NO sub
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [{ Name: "email", Value: "no-sub@example.com" }],
    });

    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "NAME#Engineering",
        itemType: "name_reservation",
        name: "Engineering",
        createdAt: new Date().toISOString(),
      },
    });
    ddbMock.on(PutCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "no-sub@example.com",
          givenName: "No",
          familyName: "Sub",
          organization: "Engineering",
        },
      },
    );

    const result = (await handler(event)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/sub/i);

    // Verify compensation
    const deleteCalls = cognitoMock.commandCalls(AdminDeleteUserCommand);
    expect(deleteCalls).toHaveLength(1);

    // No PutCommand should have been attempted
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("removeUserRole does not touch the membership table (role-only mutation)", async () => {
    // removeUserRole removes a group but has no membership side-effects —
    // audited in finding H20's sibling check. This test verifies the
    // negative: no PutCommand or DeleteCommand issued for membership.
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    const { AdminRemoveUserFromGroupCommand } =
      await import("@aws-sdk/client-cognito-identity-provider");
    cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});

    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});

    const event = buildEvent(
      "removeUserRole",
      { username: "admin-user" },
      { userId: "target-user", role: "developer" },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    // No membership writes
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
