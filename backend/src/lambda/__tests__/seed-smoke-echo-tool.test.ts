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
const mockRegistryListResourceSummaries =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockRegistryGetResource,
    createResource: mockRegistryCreateResource,
    submitForApproval: mockRegistrySubmitForApproval,
    listResourceSummaries: mockRegistryListResourceSummaries,
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
  SAFETY_MARGIN_MS,
  MAX_POLL_BUDGET_MS,
  pollBudgetMs,
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
  getRemainingTimeInMillis: () => 180_000,
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

    // Registry list → no match
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    // Registry getResource fallback → not found
    mockRegistryGetResource.mockResolvedValueOnce(null);
    // Create → DRAFT record
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "DRAFT",
    });
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});
    // Poll: getResource → DRAFT (stable)
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "DRAFT",
    });
    // Submit for approval → APPROVED (auto-approval)
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "APPROVED",
    });

    await handler(makeEvent(), mockContext, jest.fn());

    // S3 upload happened (HeadObject + PutObject + HeadObject copy + PutObject copy)
    expect(mockS3Send).toHaveBeenCalledTimes(4);
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
    expect(metadata.codeKey).toBe(`tools/${TOOL_ID}`);

    expect(mockRegistrySubmitForApproval).toHaveBeenCalledWith("rec-001");
  });

  // --- Idempotency: S3 content hash match ----------------------------------
  it("skips S3 upload when content hash matches", async () => {
    // HeadObject → hash matches
    mockS3Send.mockResolvedValueOnce({
      Metadata: { "content-hash": CONTENT_HASH },
    });

    // Registry list → already APPROVED by name
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-001", name: TOOL_ID, status: "APPROVED" },
    ]);
    // HeadObject for recordId copy → hash matches
    mockS3Send.mockResolvedValueOnce({
      Metadata: { "content-hash": CONTENT_HASH },
    });

    await handler(makeEvent(), mockContext, jest.fn());

    // HeadObject for primary + HeadObject for recordId copy
    expect(mockS3Send).toHaveBeenCalledTimes(2);
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

    // Registry list → already APPROVED
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-existing", name: TOOL_ID, status: "APPROVED" },
    ]);
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});

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

    // Registry list → DRAFT by name
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-draft", name: TOOL_ID, status: "DRAFT" },
    ]);
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});
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
    // Registry list → no match
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    mockRegistryGetResource.mockResolvedValueOnce(null);
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "DRAFT",
    });
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});
    // Poll → DRAFT (stable)
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "DRAFT",
    });
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "APPROVED",
    });

    await handler(makeEvent("Update"), mockContext, jest.fn());

    expect(mockS3Send).toHaveBeenCalledTimes(4);
    expect(mockRegistryCreateResource).toHaveBeenCalledTimes(1);
  });

  // --- Defect C: polls CREATING status before submitForApproval ------------
  it("polls until record leaves CREATING before submitting for approval", async () => {
    jest.useFakeTimers();
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    mockS3Send.mockResolvedValueOnce({});

    // Registry list → no match
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    mockRegistryGetResource.mockResolvedValueOnce(null);
    // Create → CREATING (transitional)
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-creating",
      status: "CREATING",
    });
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});
    // Poll 1: still CREATING
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-creating",
      status: "CREATING",
    });
    // Poll 2: settled to DRAFT
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-creating",
      status: "DRAFT",
    });
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-creating",
      status: "APPROVED",
    });

    const handlerPromise = handler(makeEvent(), mockContext, jest.fn());
    // Advance past the poll delays
    await jest.advanceTimersByTimeAsync(120_000);
    await handlerPromise;

    jest.useRealTimers();

    // getResource called: fallback + poll1 + poll2 = 3
    expect(mockRegistryGetResource).toHaveBeenCalledTimes(3);
    expect(mockRegistrySubmitForApproval).toHaveBeenCalledWith("rec-creating");
  });

  // --- Defect C: logs and succeeds if still CREATING after timeout ----------
  it("succeeds with CREATING status if record never settles", async () => {
    jest.useFakeTimers();
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    mockS3Send.mockResolvedValueOnce({});

    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    mockRegistryGetResource.mockResolvedValueOnce(null);
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-stuck",
      status: "CREATING",
    });
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});
    // Every poll returns CREATING
    mockRegistryGetResource.mockResolvedValue({
      recordId: "rec-stuck",
      status: "CREATING",
    });

    const handlerPromise = handler(makeEvent(), mockContext, jest.fn());
    await jest.advanceTimersByTimeAsync(120_000);
    await handlerPromise;

    jest.useRealTimers();

    // Should NOT have called submitForApproval
    expect(mockRegistrySubmitForApproval).not.toHaveBeenCalled();
    // Should not have thrown — handler succeeds with CREATING status
    expect(mockRegistryCreateResource).toHaveBeenCalledTimes(1);
  });

  // --- Defect B: finds existing record by name via listResourceSummaries ---
  it("finds existing record by name and reuses it (no duplicate creation)", async () => {
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    mockS3Send.mockResolvedValueOnce({});

    // Registry list → existing record with different recordId
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-existing-abc", name: TOOL_ID, status: "APPROVED" },
    ]);
    // HeadObject for recordId copy → not found
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { name: "NotFound" }),
    );
    // PutObject for recordId copy
    mockS3Send.mockResolvedValueOnce({});

    await handler(makeEvent(), mockContext, jest.fn());

    // Should NOT create a new record
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    expect(mockRegistrySubmitForApproval).not.toHaveBeenCalled();
  });
});

describe("pollBudgetMs", () => {
  it("subtracts safety margin and caps at 60 s", () => {
    const ctx = { getRemainingTimeInMillis: () => 180_000 };
    expect(pollBudgetMs(ctx)).toBe(MAX_POLL_BUDGET_MS);
  });

  it("returns remaining minus margin when under 60 s", () => {
    const ctx = { getRemainingTimeInMillis: () => 40_000 };
    expect(pollBudgetMs(ctx)).toBe(40_000 - SAFETY_MARGIN_MS);
  });

  it("returns 0 when remaining is less than the safety margin", () => {
    const ctx = { getRemainingTimeInMillis: () => 5_000 };
    expect(pollBudgetMs(ctx)).toBe(0);
  });
});
