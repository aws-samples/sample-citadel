/**
 * Tests for document-resolver Lambda
 *
 * Security fix for finding 60a5a6ae (CRE item 1): getProjectDocument,
 * getDocumentVersion, listDocumentVersions, and generateDocumentPdf must
 * reconcile the client-supplied projectId against the caller BEFORE any S3
 * read, presign, or Lambda invocation (cross-tenant IDOR).
 */
import {
  S3Client,
  GetObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";

const s3Mock = mockClient(S3Client);
const lambdaMock = mockClient(LambdaClient);

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest
    .fn()
    .mockResolvedValue("https://signed-url.example.com/doc.pdf"),
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
import { handler } from "../document-resolver";
import { ProjectAccessDeniedError } from "../../utils/project-access";

type HandlerEvent = Parameters<typeof handler>[0];

const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

const makeEvent = (
  fieldName: string,
  args: Record<string, unknown>,
): HandlerEvent =>
  ({
    info: { fieldName },
    arguments: args,
    identity: { sub: "user-123", username: "testuser" },
  }) as unknown as HandlerEvent;

describe("document-resolver", () => {
  beforeEach(() => {
    s3Mock.reset();
    lambdaMock.reset();
    assertProjectAccessMock.mockReset();
    (getSignedUrl as jest.Mock).mockClear();
    process.env.SESSION_BUCKET = "test-session-bucket";
    process.env.PDF_GENERATOR_FUNCTION = "test-pdf-generator";
  });

  afterEach(() => {
    delete process.env.SESSION_BUCKET;
    delete process.env.PDF_GENERATOR_FUNCTION;
  });

  describe("cross-tenant projectId is refused before any privileged operation", () => {
    beforeEach(() => {
      assertProjectAccessMock.mockRejectedValue(
        new ProjectAccessDeniedError("Access denied"),
      );
    });

    test("getProjectDocument: denies and never calls S3", async () => {
      await expect(
        invokeHandler(
          makeEvent("getProjectDocument", {
            projectId: "victim-proj",
            documentKey: "design.md",
          }),
        ),
      ).rejects.toThrow("Access denied");

      expect(assertProjectAccessMock).toHaveBeenCalledWith(
        "victim-proj",
        "user-123",
        expect.anything(),
      );
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    });

    test("getDocumentVersion: denies and never calls S3", async () => {
      await expect(
        invokeHandler(
          makeEvent("getDocumentVersion", {
            projectId: "victim-proj",
            documentKey: "design.md",
            versionId: "v1",
          }),
        ),
      ).rejects.toThrow("Access denied");

      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    });

    test("listDocumentVersions: denies and never calls S3", async () => {
      await expect(
        invokeHandler(
          makeEvent("listDocumentVersions", {
            projectId: "victim-proj",
            documentKey: "design.md",
          }),
        ),
      ).rejects.toThrow("Access denied");

      expect(s3Mock.commandCalls(ListObjectVersionsCommand)).toHaveLength(0);
    });

    test("generateDocumentPdf: denies BEFORE any presign and before Lambda invoke (worst case — cross-tenant read + presigned URL mint)", async () => {
      await expect(
        invokeHandler(
          makeEvent("generateDocumentPdf", {
            projectId: "victim-proj",
            documentKey: "design.md",
          }),
        ),
      ).rejects.toThrow("Access denied");

      // ZERO presign calls recorded — the acceptance criterion.
      expect(getSignedUrl).toHaveBeenCalledTimes(0);
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    });
  });

  describe("legitimate same-org access still works", () => {
    beforeEach(() => {
      assertProjectAccessMock.mockResolvedValue(undefined);
    });

    test("getProjectDocument returns document content", async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => "file contents",
        } as unknown as never,
        VersionId: "v1",
        LastModified: new Date("2026-01-01T00:00:00Z"),
      });

      const result = (await invokeHandler(
        makeEvent("getProjectDocument", {
          projectId: "my-proj",
          documentKey: "design.md",
        }),
      )) as { content: string };

      expect(result.content).toBe("file contents");
      expect(assertProjectAccessMock).toHaveBeenCalledWith(
        "my-proj",
        "user-123",
        expect.anything(),
      );
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    });

    test("generateDocumentPdf returns a signed URL", async () => {
      lambdaMock.on(InvokeCommand).resolves({});

      const result = (await invokeHandler(
        makeEvent("generateDocumentPdf", {
          projectId: "my-proj",
          documentKey: "design.md",
        }),
      )) as { url: string; expiresIn: number };

      expect(result.url).toBe("https://signed-url.example.com/doc.pdf");
      expect(getSignedUrl).toHaveBeenCalledTimes(1);
    });
  });

  test("throws on unknown field", async () => {
    assertProjectAccessMock.mockResolvedValue(undefined);
    await expect(invokeHandler(makeEvent("unknownField", {}))).rejects.toThrow(
      "Unknown field",
    );
  });
});
