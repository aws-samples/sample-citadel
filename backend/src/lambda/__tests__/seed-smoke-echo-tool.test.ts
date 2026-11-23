/**
 * Seed Smoke Echo Tool — unit tests.
 *
 * Covers (lambda-binding version, board task 10c3bf48 Slice 2):
 *   - Production exclusion (ENVIRONMENT=prod → skip)
 *   - Smoke-disabled exclusion (SMOKE_FIXTURES_ENABLED absent → skip)
 *   - Missing SMOKE_ECHO_FUNCTION_ARN → failure
 *   - Happy path: registry create with a lambda integration binding +
 *     submitForApproval
 *   - Idempotency: existing APPROVED registry record → no re-create
 *   - Delete event → no-op
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

// Mock https.request for CFN response while preserving https.Agent (prevents
// @smithy/node-http-handler teardown crashes — see #466).
jest.mock("https", () => ({
  ...jest.requireActual("https"),
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
  INPUT_SCHEMA,
  SAFETY_MARGIN_MS,
  MAX_POLL_BUDGET_MS,
  pollBudgetMs,
  _resetSeedSmokeEchoTool,
} from "../seed-smoke-echo-tool/index";

const ECHO_FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:citadel-smoke-echo-dev";

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
      SMOKE_ECHO_FUNCTION_ARN: ECHO_FUNCTION_ARN,
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
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
  });

  // --- Smoke-disabled exclusion --------------------------------------------
  it("skips when SMOKE_FIXTURES_ENABLED is not true", async () => {
    delete process.env.SMOKE_FIXTURES_ENABLED;
    await handler(makeEvent(), mockContext, jest.fn());
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
  });

  // --- Delete no-op --------------------------------------------------------
  it("is a no-op on Delete", async () => {
    await handler(makeEvent("Delete"), mockContext, jest.fn());
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
  });

  // --- Missing function ARN -------------------------------------------------
  it("fails when SMOKE_ECHO_FUNCTION_ARN is not set", async () => {
    delete process.env.SMOKE_ECHO_FUNCTION_ARN;
    const sendResponseSpy = jest.fn();
    await handler(makeEvent(), mockContext, sendResponseSpy);
    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    // https.request mock resolves regardless of status; assert via console
    // error path indirectly by confirming no registry call occurred and the
    // handler did not throw (CFN FAILED response path is exercised).
  });

  // --- Happy path ----------------------------------------------------------
  it("creates an APPROVED registry record with a lambda integration binding", async () => {
    // Registry list → no match
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    // Registry getResource fallback → not found
    mockRegistryGetResource.mockResolvedValueOnce(null);
    // Create → DRAFT record
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-001",
      status: "DRAFT",
    });
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
    expect(metadata.integrationBindings).toEqual([
      {
        integrationId: "smoke-echo-lambda",
        integrationType: "lambda",
        functionArn: ECHO_FUNCTION_ARN,
      },
    ]);
    // The worker's resolve_tool_credential_mode (tool_run_handler.py) reads
    // this sentinel directly off the tool record and fails closed to
    // 'scoped' (triggering a credential vend against a non-existent
    // integration record) when it is absent. This fixture is invoked under
    // the worker's own execution role (see the SmokeEchoLambdaFunction
    // grantInvoke in arbiter-stack.ts) and vends no cloud credentials of
    // its own, so it must declare the explicit no-vend sentinel.
    expect(metadata.credentialMode).toBe("none");

    expect(mockRegistrySubmitForApproval).toHaveBeenCalledWith("rec-001");
  });

  // --- Idempotency: existing APPROVED record --------------------------------
  it("skips registry create when record is already APPROVED", async () => {
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-existing", name: TOOL_ID, status: "APPROVED" },
    ]);

    await handler(makeEvent(), mockContext, jest.fn());

    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    expect(mockRegistrySubmitForApproval).not.toHaveBeenCalled();
  });

  // --- Existing DRAFT record gets submitted for approval --------------------
  it("submits existing DRAFT record for approval", async () => {
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-draft", name: TOOL_ID, status: "DRAFT" },
    ]);
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-draft",
      status: "APPROVED",
    });

    await handler(makeEvent(), mockContext, jest.fn());

    expect(mockRegistryCreateResource).not.toHaveBeenCalled();
    expect(mockRegistrySubmitForApproval).toHaveBeenCalledWith("rec-draft");
  });

  // --- Record shape assertions -----------------------------------------------
  it("exports correct TOOL_ID", () => {
    expect(TOOL_ID).toBe("smoke-echo-tool");
    expect(ORG_ID).toBe("Default");
  });

  it("Update event behaves the same as Create", async () => {
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    mockRegistryGetResource.mockResolvedValueOnce(null);
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "DRAFT",
    });
    mockRegistryGetResource.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "DRAFT",
    });
    mockRegistrySubmitForApproval.mockResolvedValueOnce({
      recordId: "rec-002",
      status: "APPROVED",
    });

    await handler(makeEvent("Update"), mockContext, jest.fn());

    expect(mockRegistryCreateResource).toHaveBeenCalledTimes(1);
  });

  // --- Defect C: polls CREATING status before submitForApproval ------------
  it("polls until record leaves CREATING before submitting for approval", async () => {
    jest.useFakeTimers();
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    mockRegistryGetResource.mockResolvedValueOnce(null);
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-creating",
      status: "CREATING",
    });
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
    mockRegistryListResourceSummaries.mockResolvedValueOnce([]);
    mockRegistryGetResource.mockResolvedValueOnce(null);
    mockRegistryCreateResource.mockResolvedValueOnce({
      recordId: "rec-stuck",
      status: "CREATING",
    });
    mockRegistryGetResource.mockResolvedValue({
      recordId: "rec-stuck",
      status: "CREATING",
    });

    const handlerPromise = handler(makeEvent(), mockContext, jest.fn());
    await jest.advanceTimersByTimeAsync(120_000);
    await handlerPromise;

    jest.useRealTimers();

    expect(mockRegistrySubmitForApproval).not.toHaveBeenCalled();
    expect(mockRegistryCreateResource).toHaveBeenCalledTimes(1);
  });

  // --- Defect B: finds existing record by name via listResourceSummaries ---
  it("finds existing record by name and reuses it (no duplicate creation)", async () => {
    mockRegistryListResourceSummaries.mockResolvedValueOnce([
      { recordId: "rec-existing-abc", name: TOOL_ID, status: "APPROVED" },
    ]);

    await handler(makeEvent(), mockContext, jest.fn());

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
