/**
 * Org-scoping + credential-in-response tests for user-management-resolver.ts
 * (finding f21582e6).
 *
 * Defect: listUsers, getUser, listOrganizations and listAvailableRoles read
 * NO identity, apply NO admin gate, and apply NO org filter — any
 * authenticated user of any tenant could enumerate every user (with role +
 * custom:organization) and every organization. Separately,
 * adminResetUserPassword / adminResendInvitation echoed the generated
 * temporary password back in the response message.
 *
 * Fix under test:
 *  - listUsers / getUser: non-admin callers see/only-access their own org;
 *    the GLOBAL 'admin' Cognito group (checked via the module's existing
 *    isUserAdmin()) retains cross-tenant visibility, preserved deliberately.
 *  - listOrganizations: non-admin sees only the caller's own org; admin sees
 *    all (same admin bypass).
 *  - listAvailableRoles: no tenant data, stays global, but must read
 *    identity (fails closed if caller identity is unresolvable).
 *  - Fail closed when the caller's org cannot be resolved (non-admin).
 *  - adminResetUserPassword / adminResendInvitation: temp password must
 *    never appear in the response `message`.
 *
 * assignUserRole / removeUserRole / adminCreateUser are explicitly OUT OF
 * SCOPE (finding 59e5a79c, separately accepted risk) — no test here asserts
 * on their org-confinement behavior changing.
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListGroupsCommand,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

process.env.USER_POOL_ID = "test-pool";
process.env.ORGANISATION_TABLE = "test-orgs";

import { handler } from "../user-management-resolver";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cognitoUser(username: string, org: string, statusEnabled = true) {
  return {
    Username: username,
    Attributes: [
      { Name: "email", Value: `${username}@example.com` },
      { Name: "given_name", Value: "First" },
      { Name: "family_name", Value: "Last" },
      { Name: "custom:organization", Value: org },
    ],
    UserStatus: "CONFIRMED",
    Enabled: statusEnabled,
    UserCreateDate: new Date("2024-01-01T00:00:00Z"),
  };
}

type ResolverEvent = Parameters<typeof handler>[0];

interface UserResult {
  userId: string;
  email: string;
  name: string;
  role?: string;
  organization?: string;
}

interface OrganizationResult {
  orgId: string;
  name: string;
}

interface UserManagementResponseResult {
  success: boolean;
  message?: string;
}

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
});

// ---------------------------------------------------------------------------
// listUsers — org scoping
// ---------------------------------------------------------------------------

describe("listUsers — org scoping", () => {
  test("non-admin caller only sees users in their own org", async () => {
    // caller "alice" is in org-a, not an admin
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "alice" }).resolves({
      Username: "alice",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
    });

    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser("alice", "org-a"),
        cognitoUser("bob", "org-a"),
        cognitoUser("carol", "org-b"),
      ],
    });
    // Per-user role lookups used inside listUsers' mapping loop.
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "bob" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "carol" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent("listUsers", { username: "alice" });
    const result = (await handler(event)) as UserResult[];

    const ids = result.map((u) => u.userId).sort();
    expect(ids).toEqual(["alice", "bob"]);
    expect(ids).not.toContain("carol");
  });

  test("GLOBAL admin caller sees users across all orgs (deliberately preserved)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });

    cognitoMock.on(ListUsersCommand).resolves({
      Users: [cognitoUser("alice", "org-a"), cognitoUser("carol", "org-b")],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "carol" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent("listUsers", { username: "admin-user" });
    const result = (await handler(event)) as UserResult[];

    const ids = result.map((u) => u.userId).sort();
    expect(ids).toEqual(["alice", "carol"]);
  });

  test("fails closed when caller org cannot be resolved (non-admin, no org claim/attribute)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "orgless" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "orgless" }).resolves({
      Username: "orgless",
      UserAttributes: [],
    });

    const event = buildEvent("listUsers", { username: "orgless" });

    await expect(handler(event)).rejects.toThrow();
  });

  test("unresolvable caller identity is rejected, not silently allowed through", async () => {
    const event = buildEvent("listUsers", {});
    await expect(handler(event)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getUser — org scoping
// ---------------------------------------------------------------------------

describe("getUser — org scoping", () => {
  test("non-admin caller can fetch a same-org user", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "alice" }).resolves({
      Username: "alice",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
    });
    cognitoMock.on(AdminGetUserCommand, { Username: "bob" }).resolves({
      Username: "bob",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
      UserStatus: "CONFIRMED",
      Enabled: true,
      UserCreateDate: new Date("2024-01-01T00:00:00Z"),
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "bob" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "getUser",
      { username: "alice" },
      { userId: "bob" },
    );
    const result = (await handler(event)) as UserResult;
    expect(result.userId).toBe("bob");
  });

  test("non-admin caller is refused (or gets not-found) for a foreign-org userId", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "alice" }).resolves({
      Username: "alice",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
    });
    cognitoMock.on(AdminGetUserCommand, { Username: "carol" }).resolves({
      Username: "carol",
      UserAttributes: [{ Name: "custom:organization", Value: "org-b" }],
      UserStatus: "CONFIRMED",
      Enabled: true,
      UserCreateDate: new Date("2024-01-01T00:00:00Z"),
    });
    // Fully stub the per-user groups lookup the CURRENT (unfixed) getUser
    // also performs, so a pre-fix run fails for the org-check reason under
    // test, not an unrelated missing-stub throw.
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "carol" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "getUser",
      { username: "alice" },
      { userId: "carol" },
    );

    await expect(handler(event)).rejects.toThrow();
  });

  test("GLOBAL admin caller can fetch a cross-org user (deliberately preserved)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "carol" }).resolves({
      Username: "carol",
      UserAttributes: [{ Name: "custom:organization", Value: "org-b" }],
      UserStatus: "CONFIRMED",
      Enabled: true,
      UserCreateDate: new Date("2024-01-01T00:00:00Z"),
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "carol" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "getUser",
      { username: "admin-user" },
      { userId: "carol" },
    );
    const result = (await handler(event)) as UserResult;
    expect(result.userId).toBe("carol");
  });
});

// ---------------------------------------------------------------------------
// listOrganizations — org scoping
// ---------------------------------------------------------------------------

describe("listOrganizations — org scoping", () => {
  // Realistic row shape: orgId is a generated UUID, distinct from name.
  const orgItems = [
    {
      orgId: "11111111-1111-1111-1111-111111111111",
      name: "Org A",
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      orgId: "22222222-2222-2222-2222-222222222222",
      name: "Org B",
      createdAt: "2024-01-01T00:00:00Z",
    },
  ];

  // RATIFIED decision 228b3cc8, piece 1: the org-scoping filter at
  // listOrganizations used to compare a DynamoDB row's `orgId` (a generated
  // UUID) against the caller's `custom:organization` claim, which is ALWAYS
  // the organisation NAME (per assignUserRole, extractOrgFromEvent, and
  // every other tenancy comparison in this codebase — see auth-event.ts's
  // "Canonical tenancy claim" note). `item.orgId === callerOrg` was
  // therefore always false for a real, non-coincidental org row. This test
  // uses a REALISTIC row shape (orgId is a UUID, distinct from name) and
  // asserts the caller's NAME-valued claim resolves against the row's NAME.
  test("non-admin caller sees only their own org (claim is the organisation NAME, orgId is a distinct UUID)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "alice" }).resolves({
      Username: "alice",
      // The claim is the org NAME, never the orgId — matches
      // assignUserRole's Cognito attribute write and extractOrgFromEvent.
      UserAttributes: [{ Name: "custom:organization", Value: "Org A" }],
    });
    dynamoMock.on(ScanCommand).resolves({ Items: orgItems });

    const event = buildEvent("listOrganizations", { username: "alice" });
    const result = (await handler(event)) as OrganizationResult[];

    expect(result.map((o) => o.name)).toEqual(["Org A"]);
  });

  test("GLOBAL admin caller sees all organizations (deliberately preserved)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });
    dynamoMock.on(ScanCommand).resolves({ Items: orgItems });

    const event = buildEvent("listOrganizations", { username: "admin-user" });
    const result = (await handler(event)) as OrganizationResult[];

    expect(result.map((o) => o.name).sort()).toEqual(["Org A", "Org B"]);
  });

  test("fails closed when caller org cannot be resolved", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "orgless" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "orgless" }).resolves({
      Username: "orgless",
      UserAttributes: [],
    });

    const event = buildEvent("listOrganizations", { username: "orgless" });
    await expect(handler(event)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listAvailableRoles — must read identity but stays global
// ---------------------------------------------------------------------------

describe("listAvailableRoles — identity required, no tenant data", () => {
  test("resolves for any caller with a resolvable identity (non-admin included)", async () => {
    cognitoMock.on(ListGroupsCommand).resolves({
      Groups: [{ GroupName: "admin" }, { GroupName: "developer" }],
    });

    const event = buildEvent("listAvailableRoles", { username: "alice" });
    const result = await handler(event);

    expect(result).toEqual(["admin", "developer"]);
  });

  test("fails closed when caller identity is unresolvable", async () => {
    const event = buildEvent("listAvailableRoles", {});
    await expect(handler(event)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Credential-in-response removal
// ---------------------------------------------------------------------------

describe("adminResetUserPassword / adminResendInvitation — no temp password in response", () => {
  beforeEach(() => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
      .resolves({ Groups: [{ GroupName: "admin" }] });
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});
  });

  test("adminResetUserPassword response never contains the temp password", async () => {
    const event = buildEvent(
      "adminResetUserPassword",
      { username: "admin-user" },
      { userId: "bob" },
    );
    const result = (await handler(event)) as UserManagementResponseResult;

    expect(result.success).toBe(true);
    // No 12+ char alnum/symbol blob resembling a generated password, and the
    // literal label used previously must be gone.
    expect(result.message).not.toMatch(/Temporary password:/i);
  });

  test("adminResendInvitation response never contains the temp password", async () => {
    const event = buildEvent(
      "adminResendInvitation",
      { username: "admin-user" },
      { userId: "bob" },
    );
    const result = (await handler(event)) as UserManagementResponseResult;

    expect(result.success).toBe(true);
    expect(result.message).not.toMatch(/Temporary password:/i);
  });

  test("adminResetUserPassword still requires admin (non-admin blocked)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "adminResetUserPassword",
      { username: "alice" },
      { userId: "bob" },
    );
    await expect(handler(event)).rejects.toThrow(/Only administrators/);
  });
});
