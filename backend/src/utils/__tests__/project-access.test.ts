/**
 * Tests for the shared project-access gate (finding 60a5a6ae, CRE item 1).
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);

const isAdminFromEventMock = jest.fn();
const extractOrgFromEventMock = jest.fn();
jest.mock("../auth-event", () => ({
  isAdminFromEvent: (...args: unknown[]) => isAdminFromEventMock(...args),
  extractOrgFromEvent: (...args: unknown[]) => extractOrgFromEventMock(...args),
}));

import {
  assertProjectAccess,
  ProjectAccessDeniedError,
} from "../project-access";

describe("assertProjectAccess", () => {
  beforeEach(() => {
    ddbMock.reset();
    isAdminFromEventMock.mockReset();
    extractOrgFromEventMock.mockReset();
    isAdminFromEventMock.mockReturnValue(false);
    extractOrgFromEventMock.mockResolvedValue(null);
    process.env.PROJECTS_TABLE = "test-projects";
  });

  afterEach(() => {
    delete process.env.PROJECTS_TABLE;
  });

  test("admin bypasses the project lookup entirely", async () => {
    isAdminFromEventMock.mockReturnValue(true);

    await expect(
      assertProjectAccess("any-proj", "user-1", {}),
    ).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test("allows the project owner", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { owner: "user-1", organization: "org-a" } });

    await expect(
      assertProjectAccess("proj-1", "user-1", {}),
    ).resolves.toBeUndefined();
  });

  test("allows a caller in the same organization", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { owner: "someone-else", organization: "org-a" } });
    extractOrgFromEventMock.mockResolvedValue("org-a");

    await expect(
      assertProjectAccess("proj-1", "user-1", {}),
    ).resolves.toBeUndefined();
  });

  test("denies a cross-tenant caller (different owner, different org)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { owner: "victim-user", organization: "org-victim" } });
    extractOrgFromEventMock.mockResolvedValue("org-attacker");

    await expect(
      assertProjectAccess("victim-proj", "attacker", {}),
    ).rejects.toThrow(ProjectAccessDeniedError);
  });

  test("fails closed when the project does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(
      assertProjectAccess("missing-proj", "user-1", {}),
    ).rejects.toThrow(ProjectAccessDeniedError);
  });

  test("fails closed when the org lookup throws", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { owner: "someone-else", organization: "org-a" } });
    extractOrgFromEventMock.mockRejectedValue(new Error("Cognito unavailable"));

    await expect(assertProjectAccess("proj-1", "user-1", {})).rejects.toThrow(
      ProjectAccessDeniedError,
    );
  });

  test("fails closed when the DynamoDB lookup throws", async () => {
    ddbMock.on(GetCommand).rejects(new Error("DDB unavailable"));

    await expect(assertProjectAccess("proj-1", "user-1", {})).rejects.toThrow(
      ProjectAccessDeniedError,
    );
  });

  test("fails closed when PROJECTS_TABLE is not configured", async () => {
    delete process.env.PROJECTS_TABLE;

    await expect(assertProjectAccess("proj-1", "user-1", {})).rejects.toThrow(
      ProjectAccessDeniedError,
    );
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test("fails closed on an empty projectId", async () => {
    await expect(assertProjectAccess("", "user-1", {})).rejects.toThrow(
      ProjectAccessDeniedError,
    );
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
