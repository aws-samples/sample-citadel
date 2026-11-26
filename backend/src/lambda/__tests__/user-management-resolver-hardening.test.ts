/**
 * user-management-resolver-hardening.test.ts — Continuum findings:
 *   (a) HIGH: admin gate must read JWT cognito:groups, not in-memory cache
 *   (b) MEDIUM: role change (assign/remove) must AdminUserGlobalSignOut the target
 *   (c) LOW: IAM — AdminDeleteUser grant on pool ARN (tested in CDK stack test)
 *
 * Cache invalidation: target's groupCache entry must be cleared on any role mutation.
 */
process.env.USER_POOL_ID = "us-east-1_testpool";
process.env.ORGANISATION_TABLE = "test-orgs";
process.env.USER_ORG_MEMBERSHIP_TABLE = "test-user-org-membership";

jest.mock("../../utils/org-name", () => ({
  ...jest.requireActual("../../utils/org-name"),
  assertOrgNameExists: jest.fn().mockResolvedValue(undefined),
}));

import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

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
  dynamoMock.reset();
  dynamoMock.on(PutCommand).resolves({});
  dynamoMock.on(ScanCommand).resolves({ Items: [] });
  // Default: target-user has no groups
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "target-user" })
    .resolves({ Groups: [] });
  cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
  cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  cognitoMock.on(AdminSetUserPasswordCommand).resolves({});
  cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
  // Default AdminGetUser for target
  cognitoMock.on(AdminGetUserCommand, { Username: "target-user" }).resolves({
    Username: "target-user",
    UserAttributes: [
      { Name: "sub", Value: "target-sub-0000" },
      { Name: "custom:organization", Value: "Acme" },
    ],
  });
});

// ---------------------------------------------------------------------------
// (a) HIGH: demoted caller refused even if warm cache says admin
// ---------------------------------------------------------------------------
describe("finding (a): admin gate reads JWT cognito:groups, not cache", () => {
  test("demoted caller (JWT without admin group) refused even with a warm cache saying admin", async () => {
    // First call: caller IS admin per Cognito groups API (warms the cache)
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "demoted-admin" })
      .resolves({ Groups: [{ GroupName: "admin" }] });

    const warmEvent = buildEvent(
      "listUsers",
      { username: "demoted-admin", claims: { "cognito:groups": ["admin"] } },
    );
    // Warm the cache
    await handler(warmEvent);

    // Second call: JWT no longer contains admin group (user was demoted),
    // but the in-memory cache still has the stale "admin" entry.
    // The resolver MUST read from the JWT claim, not the cache.
    const demotedEvent = buildEvent(
      "assignUserRole",
      { username: "demoted-admin", claims: { "cognito:groups": ["developer"] } },
      { input: { userId: "target-user", role: "developer" } },
    );

    await expect(handler(demotedEvent)).rejects.toThrow(
      /Only administrators can assign/,
    );
  });

  test("admin with JWT admin group is allowed even on cold cache", async () => {
    // No prior call, cold cache. JWT says admin.
    const event = buildEvent(
      "assignUserRole",
      { username: "fresh-admin", claims: { "cognito:groups": ["admin"] } },
      { input: { userId: "target-user", role: "developer" } },
    );

    // Need AdminListGroupsForUser for the target (not the caller, since
    // caller auth should come from JWT)
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "fresh-admin" })
      .resolves({ Groups: [{ GroupName: "admin" }] });

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) MEDIUM: role change triggers AdminUserGlobalSignOut for target
// ---------------------------------------------------------------------------
describe("finding (b): role change triggers AdminUserGlobalSignOut", () => {
  beforeEach(() => {
    // Caller is admin per both JWT and API
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });
  });

  test("assignUserRole (role-only, no org change) signs out the target", async () => {
    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user", claims: { "cognito:groups": ["admin"] } },
      { input: { userId: "target-user", role: "developer" } },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    const signOutCalls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(signOutCalls.length).toBeGreaterThanOrEqual(1);
    expect(signOutCalls[0].args[0].input).toMatchObject({
      UserPoolId: "us-east-1_testpool",
      Username: "target-user",
    });
  });

  test("removeUserRole signs out the target", async () => {
    const event = buildEvent(
      "removeUserRole",
      { username: "admin-user", claims: { "cognito:groups": ["admin"] } },
      { userId: "target-user", role: "developer" },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    const signOutCalls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(signOutCalls).toHaveLength(1);
    expect(signOutCalls[0].args[0].input).toMatchObject({
      UserPoolId: "us-east-1_testpool",
      Username: "target-user",
    });
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation: target's entry cleared on role mutation
// ---------------------------------------------------------------------------
describe("cache invalidation: target's groupCache entry cleared on role mutation", () => {
  beforeEach(() => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });
  });

  test("after assignUserRole, subsequent getUser re-fetches target groups from Cognito", async () => {
    // First: getUser for target (warms cache with "developer")
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    cognitoMock.on(AdminGetUserCommand, { Username: "target-user" }).resolves({
      Username: "target-user",
      UserAttributes: [
        { Name: "sub", Value: "target-sub-0000" },
        { Name: "email", Value: "t@test.com" },
        { Name: "given_name", Value: "Test" },
        { Name: "family_name", Value: "User" },
        { Name: "custom:organization", Value: "Acme" },
      ],
      UserStatus: "CONFIRMED",
      Enabled: true,
      UserCreateDate: new Date(),
    });

    const getEvent = buildEvent(
      "getUser",
      { username: "admin-user", claims: { "cognito:groups": ["admin"] } },
      { userId: "target-user" },
    );
    await handler(getEvent);

    // Now assign a new role
    const assignEvent = buildEvent(
      "assignUserRole",
      { username: "admin-user", claims: { "cognito:groups": ["admin"] } },
      { input: { userId: "target-user", role: "architect" } },
    );
    await handler(assignEvent);

    // Change the Cognito response to reflect the new role
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [{ GroupName: "architect" }] });

    // getUser should reflect the new role (cache was invalidated)
    const result = (await handler(getEvent)) as { role?: string };
    expect(result.role).toBe("architect");
  });
});
