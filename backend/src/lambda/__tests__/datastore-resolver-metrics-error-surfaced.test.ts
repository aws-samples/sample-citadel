/**
 * RED/GREEN: when adapter.getMetrics throws AccessDenied (PermissionError),
 * createDataStore must surface it via DataStore.errorMessage instead of
 * silently swallowing it while status still reports CONNECTED.
 *
 * Root cause (finding: S3 datastore getMetrics AccessDenied hidden behind
 * CONNECTED): backend/src/lambda/datastore-resolver.ts wraps the
 * `adapter.getMetrics!(...)` call in a try/catch that only
 * `console.warn`s, with no field ever reflecting the failure to the
 * caller. The underlying IAM grant (S3Adapter.requiredPolicies().connect)
 * already scopes s3:ListBucket to the exact bucket ARN — this test does
 * not touch that grant, it pins the resolver's error-surfacing contract.
 */

// ---- Mock setup (mirrors datastore-resolver-create.test.ts) ----
const mockDynamoSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({ send: mockDynamoSend }),
    },
    PutCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Put", input })),
    GetCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Get", input })),
    UpdateCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Update", input })),
    DeleteCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Delete", input })),
    QueryCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Query", input })),
  };
});

const mockSecretsSend = jest.fn();
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockSecretsSend })),
  CreateSecretCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateSecret", input })),
  GetSecretValueCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "GetSecretValue", input })),
  DeleteSecretCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "DeleteSecret", input })),
}));

class FakePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

const mockAdapter = {
  category: "datastore" as const,
  spec: {
    type: "S3",
    provider: "AWS",
    category: "datastore" as const,
    authentication: { method: "IAM_ROLE", fields: [], secretStructure: {} },
    configuration: {
      required: ["bucketName"],
      optional: [],
      ssmParameters: [],
    },
  },
  requiredPolicies: jest.fn().mockReturnValue({
    provision: [],
    connect: [
      {
        actions: ["s3:ListBucket"],
        resources: ["arn:aws:s3:::citadel-metrics-bucket"],
      },
    ],
  }),
  provision: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  deprovision: jest.fn().mockResolvedValue(undefined),
  testConnection: jest.fn().mockResolvedValue({ success: true, message: "OK" }),
  // The reproduction: getMetrics rejects with AccessDenied, exactly what
  // S3Adapter.getMetrics throws when the scoped role lacks (or has not yet
  // propagated) s3:ListBucket.
  getMetrics: jest
    .fn()
    .mockRejectedValue(
      new FakePermissionError(
        "Permission denied listing objects in bucket citadel-metrics-bucket",
      ),
    ),
};
jest.mock("../adapters/registry", () => ({
  getAdapter: jest.fn().mockReturnValue(mockAdapter),
}));

const mockPolicyManager = {
  getAccountContext: jest
    .fn()
    .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  assumeScopedRole: jest.fn().mockResolvedValue({
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    sessionToken: "TOKEN",
  }),
  deleteRole: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../../utils/policy-manager", () => ({
  PolicyManager: jest.fn().mockImplementation(() => mockPolicyManager),
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid") }));

process.env.DATASTORES_TABLE = "TestDataStoresTable";

import { handler } from "../datastore-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

describe("createDataStore - getMetrics AccessDenied must be surfaced", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoSend.mockImplementation(
      (cmd: { _type?: string; input?: Record<string, unknown> }) => {
        if (cmd._type === "Query") return Promise.resolve({ Items: [] });
        if (cmd._type === "Put") return Promise.resolve({});
        if (cmd._type === "Update") {
          // Echo back the ExpressionAttributeValues the resolver actually
          // sent, so the assertion below reflects what the resolver wrote
          // rather than a canned fixture.
          const values = (cmd.input?.ExpressionAttributeValues ?? {}) as Record<
            string,
            unknown
          >;
          return Promise.resolve({
            Attributes: {
              dataStoreId: "test-uuid",
              status: values[":status"] ?? "CONNECTED",
              errorMessage: values[":errorMessage"],
              version: 1,
            },
          });
        }
        return Promise.resolve({});
      },
    );
  });

  const makeCreateEvent = (input: Record<string, unknown>): HandlerEvent =>
    ({
      info: { fieldName: "createDataStore" },
      arguments: { input },
      identity: { username: "test-user", "custom:organization": "org-test" },
    }) as unknown as HandlerEvent;

  test("surfaces the AccessDenied metrics failure via errorMessage instead of swallowing it", async () => {
    const event = makeCreateEvent({
      name: "my-existing-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CONNECT_EXISTING",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-metrics-bucket" }),
      clientRequestToken: "tok-s3-metrics",
    });

    const result = await handler(event);

    expect(mockAdapter.getMetrics).toHaveBeenCalledTimes(1);

    // Find the UpdateCommand call that wrote the final state.
    const updateCalls = mockDynamoSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd._type === "Update");
    const finalUpdate = updateCalls[updateCalls.length - 1];
    const values = finalUpdate.input.ExpressionAttributeValues as Record<
      string,
      unknown
    >;

    // The metrics AccessDenied must be visible on the record, not dropped.
    expect(values[":errorMessage"]).toBeDefined();
    expect(String(values[":errorMessage"])).toMatch(/permission denied/i);
    expect(result).toBeDefined();
  });
});
