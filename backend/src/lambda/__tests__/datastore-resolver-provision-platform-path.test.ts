/**
 * Citadel PR-2 (Continuum C3): resolver mint-source test.
 *
 * On the CREATE_NEW path, `createDataStore` must:
 *   1. Call `adapter.provision` BEFORE `ensureRole` — provisioning runs on
 *      the platform path (ambient adapter clients), not under a freshly
 *      minted tenant role.
 *   2. Call `ensureRole` exactly once, with the CONNECT policy array
 *      (never `.provision`) — the tenant-assumable `citadel-ds-<id>` role
 *      is minted from concrete, post-provision ARNs only.
 *   3. Dispatch `adapter.provision` WITHOUT scoped credentials (the
 *      platform path uses ambient/named platform clients internally, not
 *      vended STS creds) — `dispatchCreds(...)` for an IAM_ROLE adapter
 *      returns the scoped credentials parameter it was given, so
 *      asserting the third argument to `provision` is `undefined` proves
 *      no scoped role was consulted for provisioning.
 *
 * MUST FAIL on main (before the reorder): today `ensureRole` is called
 * BEFORE `adapter.provision`, with the `.provision` policy array.
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

const callOrder: string[] = [];

const CONNECT_POLICY = [
  {
    actions: ["dynamodb:GetItem"],
    resources: ["arn:aws:dynamodb:us-east-1:123456789012:table/citadel-t"],
  },
];
const PROVISION_POLICY = [
  {
    actions: ["dynamodb:CreateTable", "dynamodb:DeleteTable"],
    resources: ["*"],
  },
];

const mockAdapter = {
  category: "datastore" as const,
  spec: {
    type: "DYNAMODB",
    provider: "AWS",
    category: "datastore" as const,
    authentication: { method: "IAM_ROLE", fields: [], secretStructure: {} },
    configuration: { required: [], optional: [], ssmParameters: [] },
  },
  requiredPolicies: jest.fn().mockReturnValue({
    provision: PROVISION_POLICY,
    connect: CONNECT_POLICY,
  }),
  provision: jest.fn().mockImplementation(() => {
    callOrder.push("provision");
    return Promise.resolve({
      resourceArn: "arn:aws:dynamodb:us-east-1:123456789012:table/citadel-t",
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

const mockPolicyManager = {
  getAccountContext: jest
    .fn()
    .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
  ensureRole: jest.fn().mockImplementation(() => {
    callOrder.push("ensureRole");
    return Promise.resolve(undefined);
  }),
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

describe("createDataStore CREATE_NEW — provision runs on the platform path before role mint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    callOrder.length = 0;
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
        name: "citadel-t",
        type: "DYNAMODB",
        category: "DYNAMODB",
        provisionMode: "CREATE_NEW",
        orgId: "org-test",
        config: JSON.stringify({ tableName: "citadel-t" }),
        clientRequestToken: "tok-ddb-1",
      },
    },
    identity: { username: "test-user", "custom:organization": "org-test" },
  } as unknown as HandlerEvent;

  test("adapter.provision is called before PolicyManager.ensureRole", async () => {
    await handler(event);
    expect(callOrder).toEqual(["provision", "ensureRole"]);
  });

  test("ensureRole is called exactly once, with the CONNECT policy array (never provision)", async () => {
    await handler(event);
    expect(mockPolicyManager.ensureRole).toHaveBeenCalledTimes(1);
    const policiesArg = mockPolicyManager.ensureRole.mock.calls[0][1];
    expect(policiesArg).toEqual(CONNECT_POLICY);
    expect(policiesArg).not.toEqual(PROVISION_POLICY);
  });

  test("adapter.provision is dispatched without scoped credentials (platform path)", async () => {
    await handler(event);
    expect(mockAdapter.provision).toHaveBeenCalledTimes(1);
    const credsArg = mockAdapter.provision.mock.calls[0][1];
    expect(credsArg).toBeUndefined();
  });

  test("adapter.deprovision also runs without scoped credentials", async () => {
    // Deletion path: deprovision runs on the platform path too.
    const { deleteDataStore } = { deleteDataStore: undefined }; // not exported; covered via handler
    void deleteDataStore;
    const existingItem = {
      dataStoreId: "test-uuid",
      type: "DYNAMODB",
      config: JSON.stringify({
        tableName: "citadel-t",
        dataStoreId: "test-uuid",
        orgId: "org-test",
      }),
      version: 1,
      provisionMode: "CREATE_NEW",
      orgId: "org-test",
    };
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Get") return Promise.resolve({ Item: existingItem });
      if (cmd._type === "Delete") return Promise.resolve({});
      return Promise.resolve({});
    });

    const deleteEvent = {
      info: { fieldName: "deleteDataStore" },
      arguments: { dataStoreId: "test-uuid" },
      identity: { username: "test-user", "custom:organization": "org-test" },
    } as unknown as HandlerEvent;

    await handler(deleteEvent);

    expect(mockAdapter.deprovision).toHaveBeenCalledTimes(1);
    const deprovisionCredsArg = mockAdapter.deprovision.mock.calls[0][1];
    expect(deprovisionCredsArg).toBeUndefined();
  });
});
