/**
 * Cross-org item-level authz tests for datastore-resolver.ts (finding
 * ca76d041, datastore half; CRE item 2).
 *
 * Before this fix: getDataStore, updateDataStore, deleteDataStore,
 * connectDataStore, disconnectDataStore, and testDataStoreConnection all
 * acted on a client-supplied dataStoreId with NO reconciliation against the
 * caller's org — a cross-tenant IDOR. deleteDataStore is the worst case:
 * it deprovisions infrastructure, force-deletes the Secrets Manager secret,
 * and deletes the citadel-ds IAM role for the TARGET row's org, regardless
 * of who the caller is. createDataStore additionally trusted a
 * client-supplied input.orgId with no server-side derivation.
 *
 * Fix: fetch-then-verify via the shared `assertRowOrg` helper
 * (backend/src/utils/auth-event.ts) — load the row, reconcile its orgId
 * against the caller's server-derived org (extractOrgFromEvent), and refuse
 * BEFORE any mutation, secret deletion, IAM change, or adapter/provider
 * call. Admins bypass for EXISTING-ROW ops (getDataStore/updateDataStore/
 * deleteDataStore/connectDataStore/disconnectDataStore/
 * testDataStoreConnection), mirroring the read-path admin bypass already
 * used by listDataStores/getDataStoreStats/listAvailableDataSources.
 *
 * createDataStore is the ONE exception (decision b5d463f2, owner-ratified):
 * it does NOT honour the admin bypass. Previously a non-admin's mismatched
 * input.orgId was rejected but an admin's was not, so an admin could write
 * an arbitrary orgId into the record AND the Secrets Manager path
 * (/citadel/datastores/{orgId}/...). The mismatch is now rejected for
 * EVERYONE, admins included, before any DynamoDB write, Secrets Manager
 * call, or IAM change. If platform operators genuinely need to provision on
 * a tenant's behalf, that requires an EXPLICIT separate operator path —
 * intentionally not built here; this fix only removes the implicit bypass.
 */

// ---- Mock setup ----
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

const mockAdapter = {
  requiredPolicies: jest.fn().mockReturnValue({ provision: [], connect: [] }),
  provision: jest
    .fn()
    .mockResolvedValue({ resourceArn: "arn:aws:s3:::victim-bucket" }),
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

/** The victim row: belongs to org-victim, has a secretArn and is CREATE_NEW
 * (so deleteDataStore's worst-case path — deprovision + secret delete + IAM
 * role delete — would fire if the guard did not block it). */
const VICTIM_ROW = {
  dataStoreId: "ds-victim",
  name: "Victim Store",
  type: "S3",
  category: "S3_STORAGE",
  status: "CONNECTED",
  provisionMode: "CREATE_NEW",
  orgId: "org-victim",
  config: JSON.stringify({ bucketName: "victim-bucket" }),
  secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:victim",
  version: 1,
};

/**
 * Builds an event whose caller org resolves via the real
 * extractOrgFromEvent/isAdminFromEvent (auth-event.ts is NOT mocked in this
 * file — assertRowOrg's internal calls to those functions must observe the
 * same identity the test sets, which only works end-to-end through the real
 * claim-reading path, not through a jest.mock spy on the sibling exports).
 */
function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  identity: Record<string, unknown> = {
    sub: "attacker-1",
    "custom:organization": "org-attacker",
  },
): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity,
  } as unknown as HandlerEvent;
}

const ATTACKER_IDENTITY = {
  sub: "attacker-1",
  "custom:organization": "org-attacker",
};
const SAME_ORG_IDENTITY = {
  sub: "victim-user",
  "custom:organization": "org-victim",
};
const ADMIN_IDENTITY = {
  sub: "admin-1",
  "custom:role": "admin",
  "cognito:groups": ["admin"],
};

beforeEach(() => {
  jest.clearAllMocks();
  // GetCommand always returns the victim row; everything else is a no-op
  // success unless a test overrides it — if the guard fails to block, every
  // one of these would otherwise "succeed".
  mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
    if (cmd._type === "Get")
      return Promise.resolve({ Item: { ...VICTIM_ROW } });
    if (cmd._type === "Update")
      return Promise.resolve({ Attributes: { ...VICTIM_ROW } });
    return Promise.resolve({});
  });
  mockSecretsSend.mockResolvedValue({});
});

describe("cross-org caller is refused before any mutation/side-effect", () => {
  test("getDataStore: cross-org caller is denied", async () => {
    await expect(
      handler(
        makeEvent(
          "getDataStore",
          { dataStoreId: "ds-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);
  });

  test("updateDataStore: cross-org caller is denied and zero DynamoDB writes occur", async () => {
    await expect(
      handler(
        makeEvent(
          "updateDataStore",
          { input: { dataStoreId: "ds-victim", version: 1, name: "pwned" } },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    const updateCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Update",
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("deleteDataStore: cross-org caller is denied; zero deprovision/secret-delete/IAM-delete/DynamoDB-delete calls", async () => {
    await expect(
      handler(
        makeEvent(
          "deleteDataStore",
          { dataStoreId: "ds-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockAdapter.disconnect).not.toHaveBeenCalled();
    expect(mockAdapter.deprovision).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(mockPolicyManager.deleteRole).not.toHaveBeenCalled();
    const deleteCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Delete",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  test("connectDataStore: cross-org caller is denied; zero adapter.connect / DynamoDB update calls", async () => {
    await expect(
      handler(
        makeEvent(
          "connectDataStore",
          { dataStoreId: "ds-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockAdapter.connect).not.toHaveBeenCalled();
    const updateCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Update",
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("disconnectDataStore: cross-org caller is denied; zero adapter.disconnect / DynamoDB update calls", async () => {
    await expect(
      handler(
        makeEvent(
          "disconnectDataStore",
          { dataStoreId: "ds-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockAdapter.disconnect).not.toHaveBeenCalled();
    const updateCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Update",
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("testDataStoreConnection: cross-org caller is denied; zero secret reads / adapter.testConnection calls", async () => {
    await expect(
      handler(
        makeEvent(
          "testDataStoreConnection",
          { dataStoreId: "ds-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockAdapter.testConnection).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
  });
});

describe("legitimate same-org callers still succeed", () => {
  test("getDataStore: same-org caller succeeds", async () => {
    const result = (await handler(
      makeEvent(
        "getDataStore",
        { dataStoreId: "ds-victim" },
        SAME_ORG_IDENTITY,
      ),
    )) as { dataStoreId: string };

    expect(result.dataStoreId).toBe("ds-victim");
  });

  test("deleteDataStore: same-org caller succeeds and performs cleanup", async () => {
    const result = (await handler(
      makeEvent(
        "deleteDataStore",
        { dataStoreId: "ds-victim" },
        SAME_ORG_IDENTITY,
      ),
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockAdapter.deprovision).toHaveBeenCalledTimes(1);
    expect(mockSecretsSend).toHaveBeenCalled();
    expect(mockPolicyManager.deleteRole).toHaveBeenCalledTimes(1);
  });

  test("admin caller may act cross-org for existing-row ops (bypass preserved)", async () => {
    const result = (await handler(
      makeEvent("getDataStore", { dataStoreId: "ds-victim" }, ADMIN_IDENTITY),
    )) as { dataStoreId: string };

    expect(result.dataStoreId).toBe("ds-victim");
  });
});

describe("createDataStore rejects a foreign/mismatched orgId", () => {
  beforeEach(() => {
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Query") return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });
  });

  test("rejects when input.orgId does not match the server-derived caller org", async () => {
    await expect(
      handler(
        makeEvent(
          "createDataStore",
          {
            input: {
              name: "sneaky",
              type: "S3",
              category: "S3_STORAGE",
              provisionMode: "CONNECT_EXISTING",
              orgId: "org-foreign",
              config: JSON.stringify({ bucketName: "b" }),
              clientRequestToken: "tok-reject-1",
            },
          },
          { sub: "user-real", "custom:organization": "org-real" },
        ),
      ),
    ).rejects.toThrow(/access denied|org/i);

    const putCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Put",
    );
    expect(putCalls).toHaveLength(0);
  });

  test("accepts when input.orgId matches the server-derived caller org", async () => {
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Query") return Promise.resolve({ Items: [] });
      if (cmd._type === "Put") return Promise.resolve({});
      if (cmd._type === "Update") {
        return Promise.resolve({
          Attributes: {
            dataStoreId: "test-uuid",
            status: "CONNECTED",
            version: 1,
          },
        });
      }
      return Promise.resolve({});
    });

    const result = (await handler(
      makeEvent(
        "createDataStore",
        {
          input: {
            name: "legit",
            type: "S3",
            category: "S3_STORAGE",
            provisionMode: "CONNECT_EXISTING",
            orgId: "org-real",
            config: JSON.stringify({ bucketName: "b" }),
            clientRequestToken: "tok-accept-1",
          },
        },
        { sub: "user-real", "custom:organization": "org-real" },
      ),
    )) as { dataStoreId: string };

    expect(result.dataStoreId).toBe("test-uuid");
  });

  test("admin caller is REJECTED for a mismatched orgId — no implicit admin bypass on createDataStore (decision b5d463f2)", async () => {
    const putBefore = mockDynamoSend.mock.calls.length;

    await expect(
      handler(
        makeEvent(
          "createDataStore",
          {
            input: {
              name: "admin-attempted-foreign-write",
              type: "S3",
              category: "S3_STORAGE",
              provisionMode: "CONNECT_EXISTING",
              orgId: "org-any",
              config: JSON.stringify({ bucketName: "b" }),
              clientRequestToken: "tok-admin-1",
            },
          },
          ADMIN_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied|org/i);

    // Prove fail-closed by mutation, not by asserting an empty result:
    // zero DynamoDB calls of ANY kind (no Put, no Query, no Update), zero
    // Secrets Manager calls, zero IAM/policy-manager calls — the rejection
    // must happen before any of createDataStore's side effects, including
    // the idempotency-check Query that normally runs first.
    expect(mockDynamoSend.mock.calls.length).toBe(putBefore);
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(mockPolicyManager.ensureRole).not.toHaveBeenCalled();
    expect(mockPolicyManager.assumeScopedRole).not.toHaveBeenCalled();
    expect(mockAdapter.provision).not.toHaveBeenCalled();
    expect(mockAdapter.connect).not.toHaveBeenCalled();
  });
});
