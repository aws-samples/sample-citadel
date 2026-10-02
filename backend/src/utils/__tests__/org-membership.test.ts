/**
 * Unit tests for `lookupOwnerOrganization` (utils/org-membership.ts).
 *
 * Decision 00d40a31 (option A): the UserOrgMembership DynamoDB table is the
 * ONLY authoritative user↔org link. The Cognito `custom:organization`
 * user-pool attribute is a display/back-compat mirror and is never read —
 * Cognito AdminGetUser is used here solely as a username→sub identity
 * mapping for legacy non-sub `owner` values.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { lookupOwnerOrganization } from "../org-membership";

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const TABLE = "citadel-user-org-membership-test";
const SUB = "3f2a1b7c-9d4e-4f61-8a2b-0c5d6e7f8a9b";

describe("lookupOwnerOrganization", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
    process.env.USER_ORG_MEMBERSHIP_TABLE = TABLE;
    process.env.USER_POOL_ID = "us-west-2_testpool";
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.USER_ORG_MEMBERSHIP_TABLE;
    delete process.env.USER_POOL_ID;
  });

  test("returns row.orgName on a membership hit keyed by sub (ConsistentRead) without touching Cognito", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sub: SUB, orgName: "acme" } });

    await expect(lookupOwnerOrganization(SUB)).resolves.toBe("acme");

    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      TableName: TABLE,
      Key: { sub: SUB },
      ConsistentRead: true,
    });
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });

  test("returns null on a miss for a UUID-shaped sub without attempting a Cognito identity mapping", async () => {
    ddbMock.on(GetCommand).resolves({});

    await expect(lookupOwnerOrganization(SUB)).resolves.toBeNull();

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });

  test("returns null when the row exists but orgName is empty/missing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sub: SUB, orgName: "" } });
    await expect(lookupOwnerOrganization(SUB)).resolves.toBeNull();
  });

  test("maps a non-sub owner (username) to its sub via AdminGetUser and retries the membership read — never reads custom:organization", async () => {
    ddbMock
      .on(GetCommand, { TableName: TABLE, Key: { sub: "jane.doe" } })
      .resolves({})
      .on(GetCommand, { TableName: TABLE, Key: { sub: SUB } })
      .resolves({ Item: { sub: SUB, orgName: "acme" } });
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: "jane.doe",
      UserAttributes: [
        { Name: "sub", Value: SUB },
        // Deliberately conflicting mirror: must be IGNORED.
        { Name: "custom:organization", Value: "evil-org" },
      ],
    });

    await expect(lookupOwnerOrganization("jane.doe")).resolves.toBe("acme");

    const cognitoCalls = cognitoMock.commandCalls(AdminGetUserCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input).toEqual({
      UserPoolId: "us-west-2_testpool",
      Username: "jane.doe",
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  test("returns null (not the Cognito attribute) when the mapped sub has no membership row", async () => {
    ddbMock.on(GetCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: "sub", Value: SUB },
        { Name: "custom:organization", Value: "evil-org" },
      ],
    });

    await expect(lookupOwnerOrganization("jane.doe")).resolves.toBeNull();
  });

  test("skips the Cognito identity mapping when USER_POOL_ID is unset", async () => {
    delete process.env.USER_POOL_ID;
    ddbMock.on(GetCommand).resolves({});

    await expect(lookupOwnerOrganization("jane.doe")).resolves.toBeNull();
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });

  test("returns null and warns when USER_ORG_MEMBERSHIP_TABLE is unset", async () => {
    delete process.env.USER_ORG_MEMBERSHIP_TABLE;

    await expect(lookupOwnerOrganization(SUB)).resolves.toBeNull();

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("USER_ORG_MEMBERSHIP_TABLE"),
      expect.anything(),
    );
  });

  test("returns null and warns on a DynamoDB error", async () => {
    ddbMock.on(GetCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    await expect(lookupOwnerOrganization(SUB)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("returns null and warns on a Cognito identity-mapping error", async () => {
    ddbMock.on(GetCommand).resolves({});
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new Error("UserNotFoundException"));

    await expect(lookupOwnerOrganization("ghost")).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("returns null for an empty owner without any lookups", async () => {
    await expect(lookupOwnerOrganization("")).resolves.toBeNull();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });
});
