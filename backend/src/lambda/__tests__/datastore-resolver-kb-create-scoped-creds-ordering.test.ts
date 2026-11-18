/**
 * H4 §3d regression guard: on the KNOWLEDGE_BASE CREATE_NEW path the
 * resolver must inject config.dataStoreId + config.orgId BEFORE calling
 * adapter.requiredPolicies(), because KnowledgeBaseAdapter.requiredPolicies
 * derives its (non-empty) provision policy from those ids and returns
 * `provision: []` when they are absent. If the ids are injected after the
 * call, no scoped role is minted, dispatchCreds() yields `undefined` for
 * the IAM_ROLE adapter, and provision is dispatched with no credentials.
 *
 * The mock adapter below reproduces the real adapter's id-dependent
 * requiredPolicies contract instead of hard-coding a policy list.
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

const idsSeenAtCallTime: Array<{ dataStoreId: unknown; orgId: unknown }> = [];

const mockAdapter = {
  category: "datastore" as const,
  spec: {
    type: "KNOWLEDGE_BASE",
    provider: "AWS",
    category: "datastore" as const,
    authentication: { method: "IAM_ROLE", fields: [], secretStructure: {} },
    configuration: { required: [], optional: [], ssmParameters: [] },
  },
  // Mirrors KnowledgeBaseAdapter.requiredPolicies: provision policy exists
  // ONLY when the resolver has already injected dataStoreId + orgId.
  requiredPolicies: jest.fn(
    (config: Record<string, unknown>, accountId: string) => {
      // Snapshot at call time: the resolver mutates this same object later,
      // so inspecting mock.calls[0][0] after the fact would be misleading.
      idsSeenAtCallTime.push({
        dataStoreId: config.dataStoreId,
        orgId: config.orgId,
      });
      const hasIds =
        typeof config.dataStoreId === "string" &&
        typeof config.orgId === "string";
      return {
        provision: hasIds
          ? [
              {
                actions: ["bedrock:CreateKnowledgeBase"],
                resources: ["*"],
              },
              {
                actions: ["iam:PassRole"],
                resources: [
                  `arn:aws:iam::${accountId}:role/citadel-ds-kb-svc-${config.dataStoreId}`,
                ],
              },
            ]
          : [],
        connect: [],
      };
    },
  ),
  provision: jest.fn().mockResolvedValue({
    resourceArn: "arn:aws:bedrock:us-east-1:123:knowledge-base/KB1",
  }),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  deprovision: jest.fn().mockResolvedValue(undefined),
  testConnection: jest.fn().mockResolvedValue({ success: true, message: "OK" }),
  getMetrics: jest.fn().mockResolvedValue({ size: "0 MB", records: 0 }),
};
jest.mock("../adapters/registry", () => ({
  getAdapter: jest.fn().mockReturnValue(mockAdapter),
}));

const SCOPED = {
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  sessionToken: "TOKEN",
};
const mockPolicyManager = {
  getAccountContext: jest
    .fn()
    .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  assumeScopedRole: jest.fn().mockResolvedValue(SCOPED),
  deleteRole: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../../utils/policy-manager", () => ({
  PolicyManager: jest.fn().mockImplementation(() => mockPolicyManager),
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid") }));

process.env.DATASTORES_TABLE = "TestDataStoresTable";

import { handler } from "../datastore-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

describe("createDataStore KNOWLEDGE_BASE CREATE_NEW — ids injected before requiredPolicies", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    idsSeenAtCallTime.length = 0;
    jest.useFakeTimers({ advanceTimers: true });
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Query") return Promise.resolve({ Items: [] });
      if (cmd._type === "Put") return Promise.resolve({});
      if (cmd._type === "Update")
        return Promise.resolve({
          Attributes: {
            dataStoreId: "test-uuid",
            status: "CONNECTED",
            version: 1,
          },
        });
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const event = {
    info: { fieldName: "createDataStore" },
    arguments: {
      input: {
        name: "kb-display",
        type: "KNOWLEDGE_BASE",
        category: "KNOWLEDGE_BASE",
        provisionMode: "CREATE_NEW",
        orgId: "org-test",
        config: JSON.stringify({ resourceName: "kb-display" }),
        clientRequestToken: "tok-kb-1",
      },
    },
    identity: { username: "test-user", "custom:organization": "org-test" },
  } as unknown as HandlerEvent;

  test("requiredPolicies receives config with dataStoreId and orgId already injected", async () => {
    await handler(event);
    expect(idsSeenAtCallTime.length).toBeGreaterThan(0);
    expect(idsSeenAtCallTime[0]).toEqual({
      dataStoreId: "test-uuid",
      orgId: "org-test",
    });
  });

  test("a scoped role is minted and vended, and provision is dispatched with the scoped credentials", async () => {
    await handler(event);
    expect(mockPolicyManager.ensureRole).toHaveBeenCalledTimes(1);
    expect(mockPolicyManager.assumeScopedRole).toHaveBeenCalledTimes(1);
    expect(mockAdapter.provision).toHaveBeenCalledTimes(1);
    expect(mockAdapter.provision.mock.calls[0][1]).toBe(SCOPED);
  });
});
