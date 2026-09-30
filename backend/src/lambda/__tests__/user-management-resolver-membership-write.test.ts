/**
 * user-management-resolver-membership-write.test.ts — decision 00d40a31
 * (option A): the UserOrgMembership DynamoDB table is the AUTHORITATIVE
 * source of a user's organization (the pre-token trigger mints the
 * `custom:organization` claim from it). `assignUserRole` must therefore:
 *
 *   1. PutItem `{sub, orgName, updatedAt, updatedBy}` to the membership
 *      table BEFORE the Cognito AdminUpdateUserAttributes write (the
 *      attribute is display/back-compat only);
 *   2. key the row by the target's Cognito `sub` (taken from the
 *      AdminGetUser response already fetched for the previous-org compare);
 *   3. abort — never touching the attribute nor signing the user out — if
 *      the Put fails or the sub cannot be resolved;
 *   4. leave the existing sign-out-on-real-change logic intact after the
 *      attribute write.
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
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
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

const TARGET_SUB = "11111111-2222-3333-4444-555555555555";

function withTarget(opts: { sub?: string; previousOrg?: string }) {
  const attrs: { Name: string; Value: string }[] = [];
  if (opts.sub) attrs.push({ Name: "sub", Value: opts.sub });
  if (opts.previousOrg)
    attrs.push({ Name: "custom:organization", Value: opts.previousOrg });
  cognitoMock
    .on(AdminGetUserCommand, { Username: "target-user" })
    .resolves({ Username: "target-user", UserAttributes: attrs });
}

function assignEvent(organization?: string) {
  return buildEvent(
    "assignUserRole",
    { username: "admin-user" },
    {
      input: {
        userId: "target-user",
        role: "developer",
        ...(organization ? { organization } : {}),
      },
    },
  );
}

beforeEach(() => {
  cognitoMock.reset();
  dynamoMock.reset();
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
  dynamoMock.on(PutCommand).resolves({});
});

describe("assignUserRole — membership table is authoritative (decision 00d40a31)", () => {
  test("writes {sub, orgName, updatedAt, updatedBy} to USER_ORG_MEMBERSHIP_TABLE keyed by the target's Cognito sub", async () => {
    withTarget({ sub: TARGET_SUB, previousOrg: "Old Org" });

    const result = (await handler(assignEvent("New Org"))) as {
      success: boolean;
    };
    expect(result.success).toBe(true);

    const puts = dynamoMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const input = puts[0].args[0].input;
    expect(input.TableName).toBe("test-user-org-membership");
    expect(input.Item).toMatchObject({
      sub: TARGET_SUB,
      orgName: "New Org",
      updatedBy: "admin-user",
    });
    expect(typeof input.Item?.updatedAt).toBe("string");
    expect(() =>
      new Date(input.Item!.updatedAt as string).toISOString(),
    ).not.toThrow();
  });

  test("ORDER: the membership Put happens BEFORE AdminUpdateUserAttributes, and sign-out is still last", async () => {
    withTarget({ sub: TARGET_SUB, previousOrg: "Old Org" });
    const order: string[] = [];
    dynamoMock.on(PutCommand).callsFake(() => {
      order.push("membership-put");
      return {};
    });
    cognitoMock.on(AdminUpdateUserAttributesCommand).callsFake(() => {
      order.push("update-attrs");
      return {};
    });
    cognitoMock.on(AdminUserGlobalSignOutCommand).callsFake(() => {
      order.push("global-signout");
      return {};
    });

    await handler(assignEvent("New Org"));

    expect(order).toEqual(["membership-put", "update-attrs", "global-signout"]);
  });

  test("the attribute write still carries the org NAME (display/back-compat) after the Put", async () => {
    withTarget({ sub: TARGET_SUB });

    await handler(assignEvent("New Org"));

    const updates = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0].input.UserAttributes).toEqual([
      { Name: "custom:organization", Value: "New Org" },
    ]);
  });

  test("Put failure ABORTS: error propagates, AdminUpdateUserAttributes and GlobalSignOut are never called", async () => {
    withTarget({ sub: TARGET_SUB, previousOrg: "Old Org" });
    dynamoMock.on(PutCommand).rejects(new Error("ddb unavailable"));

    await expect(handler(assignEvent("New Org"))).rejects.toThrow(
      /ddb unavailable/,
    );

    expect(
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand),
    ).toHaveLength(0);
    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(0);
  });

  test("missing Cognito sub on the target ABORTS before any Put or attribute write (fail closed)", async () => {
    withTarget({ sub: undefined, previousOrg: "Old Org" });

    await expect(handler(assignEvent("New Org"))).rejects.toThrow(/sub/i);

    expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand),
    ).toHaveLength(0);
  });

  test("no organization supplied → no membership Put and no attribute write (role-only assignment)", async () => {
    withTarget({ sub: TARGET_SUB });

    const result = (await handler(assignEvent(undefined))) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand),
    ).toHaveLength(0);
  });

  test("unchanged organization still upserts the membership row but does NOT sign the user out", async () => {
    withTarget({ sub: TARGET_SUB, previousOrg: "Same Org" });

    await handler(assignEvent("Same Org"));

    expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(0);
  });
});
