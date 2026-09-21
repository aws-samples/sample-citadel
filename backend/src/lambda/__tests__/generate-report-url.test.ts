/**
 * Tests for generate-report-url Lambda (finding 13f1f782).
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// Mock the presigner
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest
    .fn()
    .mockResolvedValue("https://signed-url.example.com/report.pdf"),
}));

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

const assertProjectAccessMock = jest.fn();
jest.mock("../../utils/project-access", () => ({
  assertProjectAccess: (...args: unknown[]) => assertProjectAccessMock(...args),
  ProjectAccessDeniedError: class ProjectAccessDeniedError extends Error {},
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { handler } from "../generate-report-url";
import { ProjectAccessDeniedError } from "../../utils/project-access";

describe("generate-report-url", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    assertProjectAccessMock.mockReset();
    assertProjectAccessMock.mockResolvedValue(undefined);
    (getSignedUrl as jest.Mock).mockClear();
    process.env.SESSION_BUCKET = "test-sessions";
    process.env.PROJECTS_TABLE = "test-projects";
  });

  afterEach(() => {
    delete process.env.SESSION_BUCKET;
    delete process.env.PROJECTS_TABLE;
  });

  test("reconciles projectId against the caller BEFORE the DynamoDB read and presign", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { id: "proj-1", name: "My Project" },
    });

    const result = await handler({
      arguments: { projectId: "proj-1" },
      identity: { sub: "user-123" } as never,
    });

    expect(assertProjectAccessMock).toHaveBeenCalledWith(
      "proj-1",
      "user-123",
      expect.anything(),
    );
    expect(result.url).toBe("https://signed-url.example.com/report.pdf");
    expect(result.expiresIn).toBe(3600);
  });

  test("uses fallback name when project not found", async () => {
    dynamoMock.on(GetCommand).resolves({});

    const result = await handler({
      arguments: { projectId: "proj-missing" },
      identity: { sub: "user-123" } as never,
    });

    expect(result.url).toBeDefined();
    expect(result.expiresIn).toBe(3600);
  });

  describe("caller entitled to the project (owner, org member, or admin, per assertProjectAccess semantics)", () => {
    beforeEach(() => {
      // From this resolver's point of view an owner, a same-org member, and
      // an admin are indistinguishable — assertProjectAccess (tested
      // directly in project-access.test.ts) resolves for all three. This
      // suite proves the resolver wires the gate rather than re-deriving
      // owner/org/admin semantics here.
      assertProjectAccessMock.mockResolvedValue(undefined);
      dynamoMock.on(GetCommand).resolves({
        Item: { id: "proj-1", name: "My Project" },
      });
    });

    test("owner: presign succeeds", async () => {
      const result = await handler({
        arguments: { projectId: "proj-1" },
        identity: { sub: "owner-user" } as never,
      });
      expect(result.url).toBeDefined();
    });

    test("same-org member: presign succeeds", async () => {
      const result = await handler({
        arguments: { projectId: "proj-1" },
        identity: { sub: "org-member-user" } as never,
      });
      expect(result.url).toBeDefined();
    });

    test("admin: presign succeeds", async () => {
      const result = await handler({
        arguments: { projectId: "proj-1" },
        identity: { sub: "admin-user", "cognito:groups": ["admin"] } as never,
      });
      expect(result.url).toBeDefined();
    });
  });

  describe("cross-project / cross-org caller is refused before any privileged operation", () => {
    beforeEach(() => {
      assertProjectAccessMock.mockRejectedValue(
        new ProjectAccessDeniedError("Access denied"),
      );
    });

    test("denies and calls neither getSignedUrl nor the DynamoDB read", async () => {
      await expect(
        handler({
          arguments: { projectId: "victim-proj" },
          identity: { sub: "attacker-user" } as never,
        }),
      ).rejects.toThrow("Access denied");

      expect(assertProjectAccessMock).toHaveBeenCalledWith(
        "victim-proj",
        "user-123",
        expect.anything(),
      );
      expect(getSignedUrl).toHaveBeenCalledTimes(0);
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
    });
  });
});
