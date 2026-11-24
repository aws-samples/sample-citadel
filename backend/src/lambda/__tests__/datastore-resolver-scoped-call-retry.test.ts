/**
 * RED/GREEN: createDataStore must not sleep a fixed 10s after
 * PolicyManager.ensureRole before dispatching the first scoped call
 * (connect/getMetrics). IAM propagation delay is real but variable; a
 * fixed sleep either wastes time or isn't long enough. Replace with a
 * bounded retry of the FIRST scoped call on AccessDenied/
 * AccessDeniedException (up to 5 attempts, backoff 2,4,6,8s). Non-
 * AccessDenied errors must propagate immediately without retry. Uses
 * jest fake timers to assert on the backoff schedule without real delay.
 */

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

class FakeAccessDeniedError extends Error {
  constructor(message = "Access Denied") {
    super(message);
    this.name = "AccessDeniedException";
  }
}

class FakeOtherError extends Error {
  constructor(message = "Some other failure") {
    super(message);
    this.name = "ThrottlingException";
  }
}

function makeMockAdapter() {
  return {
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
          resources: ["arn:aws:s3:::citadel-retry-bucket"],
        },
      ],
    }),
    provision: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    deprovision: jest.fn().mockResolvedValue(undefined),
    testConnection: jest
      .fn()
      .mockResolvedValue({ success: true, message: "OK" }),
    getMetrics: jest.fn().mockResolvedValue({ size: "0 objects", records: 0 }),
  };
}

let mockAdapter: ReturnType<typeof makeMockAdapter>;
jest.mock("../adapters/registry", () => ({
  getAdapter: jest.fn(() => mockAdapter),
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

describe("createDataStore - bounded retry of first scoped call on AccessDenied", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ advanceTimers: false });
    mockAdapter = makeMockAdapter();
    mockDynamoSend.mockImplementation(
      (cmd: { _type?: string; input?: Record<string, unknown> }) => {
        if (cmd._type === "Query") return Promise.resolve({ Items: [] });
        if (cmd._type === "Put") return Promise.resolve({});
        if (cmd._type === "Update") {
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

  afterEach(() => {
    jest.useRealTimers();
  });

  const makeCreateEvent = (input: Record<string, unknown>): HandlerEvent =>
    ({
      info: { fieldName: "createDataStore" },
      arguments: { input },
      identity: { username: "test-user", "custom:organization": "org-test" },
    }) as unknown as HandlerEvent;

  async function runWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
    // advanceTimersByTimeAsync flushes microtasks between timer advances,
    // which is required because the handler's retry loop awaits a
    // setTimeout-based delay and then awaits further async work.
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 20 && !settled; i++) {
      await jest.advanceTimersByTimeAsync(8000);
    }
    return promise;
  }

  test("does NOT wait a fixed 10s sleep before the first scoped call when it succeeds immediately", async () => {
    const event = makeCreateEvent({
      name: "retry-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CONNECT_EXISTING",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-retry-bucket" }),
      clientRequestToken: "tok-retry-1",
    });

    const result = await handler(event);

    // No fixed-delay timer of exactly 10000ms should have been scheduled.
    expect(jest.getTimerCount()).toBe(0);
    expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  test("succeeds after N AccessDenied retries on the first scoped call (connect)", async () => {
    let calls = 0;
    mockAdapter.connect.mockImplementation(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(new FakeAccessDeniedError());
      }
      return Promise.resolve(undefined);
    });

    const event = makeCreateEvent({
      name: "retry-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CONNECT_EXISTING",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-retry-bucket" }),
      clientRequestToken: "tok-retry-2",
    });

    const resultPromise = handler(event);
    const result = await runWithFakeTimers(resultPromise);

    expect(mockAdapter.connect).toHaveBeenCalledTimes(3);
    expect(result).toBeDefined();
  });

  test("a non-AccessDenied error on the first scoped call propagates immediately without retry", async () => {
    mockAdapter.connect.mockRejectedValue(new FakeOtherError());

    const event = makeCreateEvent({
      name: "retry-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CONNECT_EXISTING",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-retry-bucket" }),
      clientRequestToken: "tok-retry-3",
    });

    await expect(handler(event)).rejects.toThrow("Some other failure");
    expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
  });

  test("gives up after the retry cap and surfaces the error via errorMessage path", async () => {
    mockAdapter.connect.mockRejectedValue(
      new FakeAccessDeniedError("still denied"),
    );

    const event = makeCreateEvent({
      name: "retry-bucket",
      type: "S3",
      category: "S3_STORAGE",
      provisionMode: "CONNECT_EXISTING",
      orgId: "org-test",
      config: JSON.stringify({ bucketName: "citadel-retry-bucket" }),
      clientRequestToken: "tok-retry-4",
    });

    const resultPromise = handler(event);
    const assertion = expect(resultPromise).rejects.toThrow("still denied");
    await runWithFakeTimers(resultPromise.catch(() => undefined));
    await assertion;

    // 5 attempts total on the capped retry.
    expect(mockAdapter.connect).toHaveBeenCalledTimes(5);
  });
});
