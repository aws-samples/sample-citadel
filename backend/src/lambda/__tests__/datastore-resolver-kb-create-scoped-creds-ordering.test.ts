/**
 * Continuum C3 (PR-2) supersedes the H4 §3d test this file originally
 * contained: `ensureRole` is now called from `.connect`, never
 * `.provision`, and only AFTER `adapter.provision` has run on the
 * platform path (no scoped credentials dispatched to provision).
 *
 * The mock adapter below reproduces the real KnowledgeBaseAdapter's
 * id-dependent `requiredPolicies` contract: `.connect` is non-empty only
 * once `knowledgeBaseId`/`collectionId` are present in config — which, for
 * CREATE_NEW, only happens AFTER `adapter.provision` has run and enriched
 * `config` (CIT-299 config-writeback, persisted by the resolver before
 * `.connect` is computed).
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

const idsSeenAtPreflightTime: Array<{ dataStoreId: unknown; orgId: unknown }> =
  [];

const mockAdapter = {
  category: "datastore" as const,
  spec: {
    type: "KNOWLEDGE_BASE",
    provider: "AWS",
    category: "datastore" as const,
    authentication: { method: "IAM_ROLE", fields: [], secretStructure: {} },
    configuration: { required: [], optional: [], ssmParameters: [] },
  },
  // Mirrors KnowledgeBaseAdapter.requiredPolicies: `.connect` is non-empty
  // ONLY once knowledgeBaseId + collectionId are present — i.e. only after
  // provision() has enriched config.
  requiredPolicies: jest.fn((config: Record<string, unknown>) => {
    const hasConnectIds =
      typeof config.knowledgeBaseId === "string" &&
      typeof config.collectionId === "string";
    return {
      provision: [],
      connect: hasConnectIds
        ? [
            {
              actions: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
              resources: [
                `arn:aws:bedrock:us-east-1:123456789012:knowledge-base/${config.knowledgeBaseId}`,
              ],
            },
          ]
        : [],
    };
  }),
  preflight: jest.fn((config: Record<string, unknown>) => {
    idsSeenAtPreflightTime.push({
      dataStoreId: config.dataStoreId,
      orgId: config.orgId,
    });
    return Promise.resolve(undefined);
  }),
  // Mirrors the real adapter: provision enriches config with the
  // resolved knowledgeBaseId/collectionId (CIT-299).
  provision: jest.fn((config: Record<string, unknown>) => {
    config.knowledgeBaseId = "KB1";
    config.collectionId = "COLL1";
    return Promise.resolve({
      resourceArn: "arn:aws:bedrock:us-east-1:123:knowledge-base/KB1",
    });
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

describe("createDataStore KNOWLEDGE_BASE CREATE_NEW — provision runs before connect-only role mint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    idsSeenAtPreflightTime.length = 0;
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

  test("preflight receives config with dataStoreId and orgId already injected", async () => {
    await handler(event);
    expect(idsSeenAtPreflightTime.length).toBeGreaterThan(0);
    expect(idsSeenAtPreflightTime[0]).toEqual({
      dataStoreId: "test-uuid",
      orgId: "org-test",
    });
  });

  test("provision runs before ensureRole, with no scoped credentials dispatched", async () => {
    await handler(event);
    expect(mockAdapter.provision).toHaveBeenCalledTimes(1);
    expect(mockAdapter.provision.mock.calls[0][1]).toBeUndefined();
    const provisionOrder = mockAdapter.provision.mock.invocationCallOrder[0];
    const ensureRoleOrder =
      mockPolicyManager.ensureRole.mock.invocationCallOrder[0];
    expect(provisionOrder).toBeLessThan(ensureRoleOrder);
  });

  test("a connect-only scoped role is minted and vended AFTER provision enriches config", async () => {
    await handler(event);
    expect(mockPolicyManager.ensureRole).toHaveBeenCalledTimes(1);
    const policiesArg = mockPolicyManager.ensureRole.mock.calls[0][1];
    expect(policiesArg).toEqual([
      {
        actions: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
        resources: [
          "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB1",
        ],
      },
    ]);
    expect(mockPolicyManager.assumeScopedRole).toHaveBeenCalledTimes(1);
  });
});
