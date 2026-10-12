/**
 * Seed Smoke Echo Tool — unit tests.
 *
 * Covers:
 *   - Production exclusion (ENVIRONMENT=prod → skip)
 *   - Smoke-disabled exclusion (SMOKE_FIXTURES_ENABLED absent → skip)
 *   - Happy path: S3 upload + registry create + submitForApproval
 *   - Idempotency: matching content hash → no S3 upload, existing APPROVED
 *     registry record → no re-create
 *   - Delete event → no-op
 *   - Record shape (toolId, inputSchema, orgId)
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------
const mockS3Send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _type: "PutObjectCommand",
    input,
  })),
  HeadObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _type: "HeadObjectCommand",
    input,
  })),
}));

const mockRegistryGetResource =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRegistryCreateResource =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRegistrySubmitForApproval =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockRegistryGetResource,
    createResource: mockRegistryCreateResource,
    submitForApproval: mockRegistrySubmitForApproval,
  })),
}));

// Suppress the https response callback
jest.mock("https", () => ({
  request: jest.fn((_opts: unknown, cb: () => void) => {
    const req = {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(() => cb()),
    };
    return req;
  }),
}));

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks.
// ---------------------------------------------------------------------------
import {
  handler,
  TOOL_ID,
  ORG_ID,
  CONTENT_HASH,
  TOOL_MODULE_SOURCE,
  INPUT_SCHEMA,
  S3_KEY,
  _resetSeedSmokeEchoTool,
} from "../seed-smoke-echo-tool/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEvent(
  requestType: "Create" | "Update" | "Delete" = "Create",
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: "arn:aws:lambda:us-east-1:123456789012:function:test",
    ResponseURL: "https://cfn-response.example.com",
    StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid",
    RequestId: "test-request-id",
    ResourceType: "Custom::SeedSmokeEchoTool",
    LogicalResourceId: "SeedSmokeEchoToolResource",
    ResourceProperties: {
      ServiceToken: "arn:aws:lambda:us-east-1:123456789012:function:test",
    },
    PhysicalResourceId: TOOL_ID,
  } as unknown as CloudFormationCustomResourceEvent;
}

const mockContext = {
  logStreamName: "test-log-stream",
} as unknown as Context;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("seed-smoke-echo-tool", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetSeedSmokeEchoTool();
    process.env = {
      ...originalEnv,
      ENVIRONMENT: "dev",
      SMOKE_FIXTURES_ENABLED: "true",
      TOOLS_BUCKET: "citadel-tools-dev-123456789012-us-east-1",
      REGISTRY_ID: "test-registry-id",
      AWS_REGION: "us-east-1",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // --- Production exclusion ------------------------------------------------
  it("skips when ENVIRONMENT is prod", async () => {
    process.env.ENVIRONMENT = "prod";
    await handler(makeEvent(), mockContext, jest.fn());
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
  });

  // --- Smoke-disabled exclusion --------------------------------------------
  it("skips when SMOKE_FIXTURES_ENABLED is not true", async () => {
    delete process.env.SMOKE_FIXTURES_ENABLED;
    await handler(makeEvent(), mockContext, jest.fn());
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
  });

  // --- Delete no-op --------------------------------------------------------
  it("is a no-op on Delete", async () => {
    await handler(makeEvent("Delete"), mockContext, jest.fn());
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
  });

  // --- Happy path ----------------------------------------------------------
  it("uploads to S3 and creates an APPROVED registry record", async () => {
    // HeadObject → not found (first deploy)
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject → success
    mockS3Send.mockResolvedValueOnce({});

    // Registry lookup → not found
    mockRegistryGetResource.mockResolvedValueOnce(null);
    // Create → DRAFT record
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "DRAFT",
    });
    // Submit for approval → APPROVED (auto-approval)
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "APPROVED",
    });

    await handler(makeEvent(), mockContext, jest.fn());

    // S3 upload happened
    expect(mockS3Send).toHaveBeenCalledTimes(2); // HeadObject + PutObject
    const putCall = mockS3Send.mock.calls[1]![0] as {
      input: {
        Bucket: string;
        Key: string;
        Body: string;
        Metadata: { "content-hash": string };
      };
    };
    expect(putCall.input.Bucket).toBe(
      "citadel-tools-dev-123456789012-us-east-1",
    );
    expect(putCall.input.Key).toBe(S3_KEY);
    expect(putCall.input.Body).toBe(TOOL_MODULE_SOURCE);
    expect(putCall.input.Metadata["content-hash"]).toBe(CONTENT_HASH);

    // Registry create + submit
    expect(mockRegistryCreateResource).toHaveBeenCalledTimes(1);
    const createCall = mockRegistryCreateResource.mock.calls[0] as [
      string,
      string,
      { name: string; description: string; customMetadata: string },
    ];
    expect(createCall[0]).toBe("tool");
    expect(createCall[1]).toBe(TOOL_ID);
    const metadata = JSON.parse(createCall[2].customMetadata);
    expect(metadata.toolId).toBe(TOOL_ID);
    expect(metadata.orgId).toBe(ORG_ID);
    expect(metadata.inputSchema).toBe(INPUT_SCHEMA);
    expect(metadata.createdBy).toBe("SYSTEM_SEED");

    expect(mockRegistrySubmitForApproval).toHaveBeenCalledWith("rec-001");
  });

  // --- Idempotency: S3 content hash match ----------------------------------
  it("skips S3 upload when content hash matches", async () => {
    // HeadObject → hash matches
    mockS3Send.mockResolvedValueOnce({
      Metadata: { "content-hash": CONTENT_HASH },
    });

    // Registry → already APPROVED
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "APPROVED",
    });

    await handler(makeEvent(), mockContext, jest.fn());

    // Only HeadObject, no PutObject
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    // No registry create/submit
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    expect(mockRegistrySubmitForApproval).not.toHaveBeenCalled();
  });

  // --- Idempotency: existing APPROVED record --------------------------------
  it("skips registry create when record is already APPROVED", async () => {
    // S3: new upload
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    mockS3Send.mockResolvedValueOnce({});

    // Registry → already APPROVED
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-existing",
      status: "APPROVED",
    });

    await handler(makeEvent(), mockContext, jest.fn());

    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    expect(mockRegistrySubmitForApproval).not.toHaveBeenCalled();
  });

  // --- Existing DRAFT record gets submitted for approval --------------------
  it("submits existing DRAFT record for approval", async () => {
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    mockS3Send.mockResolvedValueOnce({});

    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-draft",
      status: "DRAFT",
    });
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-draft",
      status: "APPROVED",
    });

    await handler(makeEvent(), mockContext, jest.fn());

    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    expect(mockRegistrySubmitForApproval).toHaveBeenCalledWith("rec-draft");
  });

  // --- Record shape assertions -----------------------------------------------
  it("exports correct TOOL_ID and content hash", () => {
    expect(TOOL_ID).toBe("smoke-echo-tool");
    expect(ORG_ID).toBe("Default");
    expect(CONTENT_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(S3_KEY).toBe("tools/smoke-echo-tool/index.js");
  });

  it("Update event behaves the same as Create", async () => {
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    mockS3Send.mockResolvedValueOnce({});
    mockRegistryGetResource.mockResolvedValueOnce(null);
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "DRAFT",
    });
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "APPROVED",
    });

    await handler(makeEvent("Update"), mockContext, jest.fn());

    expect(mockS3Send).toHaveBeenCalledTimes(2);
    expect(mockRegistryCreateResource).toHaveBeenCalledTimes(1);
  });
});
