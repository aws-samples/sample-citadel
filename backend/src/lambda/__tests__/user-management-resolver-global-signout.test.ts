/**
 * user-management-resolver-global-signout.test.ts — Wave-3B design item 2:
 * assignUserRole must AdminGetUser the target's CURRENT custom:organization,
 * exact-compare against the new value, and on a real change call
 * AdminUserGlobalSignOutCommand AFTER the attribute write (so the next
 * login re-stamps the token with the new org claim).
 */
process.env.USER_POOL_ID = "us-east-1_testpool";
process.env.ORGANISATION_TABLE = "test-orgs";

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
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

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

function withPreviousOrg(org: string | undefined) {
  cognitoMock.on(AdminGetUserCommand, { Username: "target-user" }).resolves({
    Username: "target-user",
    UserAttributes: org ? [{ Name: "custom:organization", Value: org }] : [],
  });
}

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
    .resolves({ Groups: [{ GroupName: "admin" }] });
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "target-user" })
    .resolves({ Groups: [] });
  cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
  cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
});

describe("assignUserRole — AdminUserGlobalSignOut on real organization change", () => {
  test("calls AdminUserGlobalSignOut when organization changes", async () => {
    withPreviousOrg("Old Org");

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "New Org",
        },
      },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    const signOutCalls = cognitoMock.commandCalls(
      AdminUserGlobalSignOutCommand,
    );
    expect(signOutCalls).toHaveLength(1);
    expect(signOutCalls[0].args[0].input).toMatchObject({
      UserPoolId: "us-east-1_testpool",
      Username: "target-user",
    });
  });

  test("sign-out happens AFTER the attribute write (ordering)", async () => {
    withPreviousOrg("Old Org");
    const callOrder: string[] = [];
    cognitoMock.on(AdminUpdateUserAttributesCommand).callsFake(() => {
      callOrder.push("update-attrs");
      return {};
    });
    cognitoMock.on(AdminUserGlobalSignOutCommand).callsFake(() => {
      callOrder.push("global-signout");
      return {};
    });

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "New Org",
        },
      },
    );

    await handler(event);

    expect(callOrder).toEqual(["update-attrs", "global-signout"]);
  });

  test("does NOT sign out when organization is unchanged (exact same value)", async () => {
    withPreviousOrg("Same Org");

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "Same Org",
        },
      },
    );

    await handler(event);

    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(0);
  });

  test("does NOT sign out on a role-only change (organization omitted)", async () => {
    withPreviousOrg("Existing Org");

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      { input: { userId: "target-user", role: "developer" } },
    );

    await handler(event);

    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(0);
    expect(
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand),
    ).toHaveLength(0);
  });

  test("exact string compare — trailing-whitespace variant counts as a change (no normalization)", async () => {
    withPreviousOrg("Acme");

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "Acme ",
        },
      },
    );

    await handler(event);

    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(1);
  });

  test("target with no previous organization claim: setting one for the first time signs out", async () => {
    withPreviousOrg(undefined);

    const event = buildEvent(
      "assignUserRole",
      { username: "admin-user" },
      {
        input: {
          userId: "target-user",
          role: "developer",
          organization: "First Org",
        },
      },
    );

    await handler(event);

    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(1);
  });
});
