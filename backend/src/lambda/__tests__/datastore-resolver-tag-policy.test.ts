/**
 * CIT-042 PR2: tag-policy enforcement for datastore.provision
 * (datastore-resolver.ts).
 *
 * Datastores are org-scoped with no bound owning agent and no tags on the
 * CreateDataStoreInput. Enforcement is skipped with a debug log — the
 * wiring exists for future owning-agent binding. Tests verify the debug
 * log is emitted and that the import of enforceTagPolicy doesn't break
 * the module.
 */
process.env.DATASTORES_TABLE = "ds-table-test";
process.env.HEALTH_MONITOR_ROLE_PARAM = "";

// ── mocks: tag-policy-check ────────────────────────────────────────────
const mockEnforceTagPolicy = jest.fn();
jest.mock("../tag-policy-check", () => ({
  __esModule: true,
  enforceTagPolicy: mockEnforceTagPolicy,
}));

// ── mocks: auth ────────────────────────────────────────────────────────
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("org-ds-test"),
  isAdminFromEvent: jest.fn().mockReturnValue(false),
  assertRowOrg: jest.fn(),
}));

// ── mocks: adapters ────────────────────────────────────────────────────
const mockProvision = jest.fn().mockResolvedValue({
  resourceArn: "arn:aws:dynamodb:us-east-1:123:table/test",
  size: "100MB",
  records: 42,
});
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockGetMetrics = jest.fn().mockResolvedValue({
  size: "100MB",
  records: 42,
});
jest.mock("../adapters/registry", () => ({
  getAdapter: jest.fn().mockReturnValue({
    provision: mockProvision,
    connect: mockConnect,
    disconnect: jest.fn(),
    deprovision: jest.fn(),
    getMetrics: mockGetMetrics,
    testConnection: jest.fn(),
    requiredPolicies: jest.fn().mockReturnValue({
      provision: [],
      connect: [],
    }),
  }),
}));

// ── mocks: policy-manager ──────────────────────────────────────────────
jest.mock("../../utils/policy-manager", () => ({
  PolicyManager: jest.fn().mockImplementation(() => ({
    getAccountContext: jest
      .fn()
      .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
    ensureRole: jest.fn(),
    assumeScopedRole: jest.fn(),
    deleteRole: jest.fn(),
  })),
}));

// ── mocks: AWS SDK ─────────────────────────────────────────────────────
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ ARN: "arn:aws:secret:test" }),
  })),
  CreateSecretCommand: jest.fn(),
  GetSecretValueCommand: jest.fn(),
  DeleteSecretCommand: jest.fn(),
}));

// ── SUT ────────────────────────────────────────────────────────────────
import { handler } from "../datastore-resolver";

// ── helpers ────────────────────────────────────────────────────────────
const TEST_ORG = "org-ds-test";
const CALLER_EVENT = {
  identity: { sub: "user-1", claims: { "custom:organization": TEST_ORG } },
  info: { fieldName: "createDataStore" },
  arguments: {
    orgId: TEST_ORG,
    dataStoreId: "",
    input: {
      orgId: TEST_ORG,
      name: "Test DS",
      type: "DYNAMODB",
      category: "DOCUMENT",
      provisionMode: "CREATE_NEW",
      config: JSON.stringify({ tableName: "test-table" }),
      dataStoreId: "",
      version: 1,
    },
  },
};

// ── tests ──────────────────────────────────────────────────────────────
describe("datastore-resolver tag-policy enforcement", () => {
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    ddbMock.reset();
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    // Conditional PutItem succeeds
    ddbMock.on(PutCommand).resolves({});
    // Update returns the final record
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        dataStoreId: "ds-123",
        name: "Test DS",
        status: "CONNECTED",
        orgId: TEST_ORG,
      },
    });
    // No existing token
    ddbMock.on(QueryCommand).resolves({ Items: [] });
  });

  afterEach(() => {
    debugSpy.mockRestore();
    jest.restoreAllMocks();
  });

  test("createDataStore emits debug log about skipping enforcement (no owning agent)", async () => {
    await handler(CALLER_EVENT as never);

    const debugCalls = debugSpy.mock.calls.map((c) => c[0]);
    const tagPolicySkip = debugCalls.find(
      (msg: string) =>
        typeof msg === "string" &&
        msg.includes("skipped_no_owning_agent") &&
        msg.includes("createDatastore"),
    );
    expect(tagPolicySkip).toBeDefined();
  });

  test("enforceTagPolicy is NOT called (no owning agent, no tags on input)", async () => {
    await handler(CALLER_EVENT as never);

    expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
  });

  test("createDataStore still succeeds despite enforcement import", async () => {
    const result = await handler(CALLER_EVENT as never);

    expect(result).toBeDefined();
  });
});
