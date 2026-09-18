/**
 * user-management-resolver-org-write-validation.test.ts — Wave-3B design
 * item 1: adminCreateUser and assignUserRole must call assertOrgNameExists
 * (backend/src/utils/org-name.ts) BEFORE any Cognito write, rejecting a
 * non-existent or tombstoned organization name with distinct messages.
 */
process.env.USER_POOL_ID = "us-east-1_testpool";
process.env.ORGANISATION_TABLE = "test-orgs";

jest.mock("../../utils/org-name", () => ({
  ...jest.requireActual("../../utils/org-name"),
  assertOrgNameExists: jest.fn(),
}));

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { assertOrgNameExists } from "../../utils/org-name";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const mockAssertOrgNameExists = assertOrgNameExists as jest.Mock;

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
  mockAssertOrgNameExists.mockReset();
  mockAssertOrgNameExists.mockResolvedValue(undefined);
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
    .resolves({ Groups: [{ GroupName: "admin" }] });
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "target-user" })
    .resolves({ Groups: [] });
  cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
  cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminGetUserCommand).resolves({
    Username: "target-user",
    UserAttributes: [],
  });
  cognitoMock.on(AdminCreateUserCommand).resolves({});
});

describe("adminCreateUser — validates organization exists before any Cognito write", () => {
  test("calls assertOrgNameExists with the supplied organization before AdminCreateUserCommand", async () => {
    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Acme",
        },
      },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockAssertOrgNameExists).toHaveBeenCalledWith(
      expect.anything(),
      "test-orgs",
      "Acme",
    );
  });

  test("rejects when assertOrgNameExists throws (org does not exist) — no AdminCreateUserCommand sent", async () => {
    mockAssertOrgNameExists.mockRejectedValue(
      new Error(
        'Organization "Ghost" does not exist. Choose an organization from the list.',
      ),
    );

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Ghost",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/does not exist/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  test("rejects when assertOrgNameExists throws (tombstoned name) — distinct message, no Cognito write", async () => {
    mockAssertOrgNameExists.mockRejectedValue(
      new Error('Organization "Deleted" was deleted and cannot be reused.'),
    );

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Deleted",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/cannot be reused/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

describe("assignUserRole — validates organization exists before any Cognito write", () => {
  test("calls assertOrgNameExists with the supplied organization before AdminUpdateUserAttributesCommand", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [] });

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "Acme",
        },
      },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockAssertOrgNameExists).toHaveBeenCalledWith(
      expect.anything(),
      "test-orgs",
      "Acme",
    );
  });

  test("rejects when the organization does not exist — no attribute write, no group changes committed as a role change", async () => {
    mockAssertOrgNameExists.mockRejectedValue(
      new Error(
        'Organization "Ghost" does not exist. Choose an organization from the list.',
      ),
    );
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [] });

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "Ghost",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/does not exist/i);
    expect(
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand),
    ).toHaveLength(0);
  });

  test("rejects a tombstoned organization name with a distinct message", async () => {
    mockAssertOrgNameExists.mockRejectedValue(
      new Error('Organization "Deleted" was deleted and cannot be reused.'),
    );
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [] });

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "Deleted",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/cannot be reused/i);
    expect(
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand),
    ).toHaveLength(0);
  });

  test("role-only change (no organization) skips org validation entirely", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "target-user" })
      .resolves({ Groups: [] });

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      { input: { userId: "target-user", role: "developer" } },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockAssertOrgNameExists).not.toHaveBeenCalled();
  });
});
