/**
 * CIT-254 C12: datastore-resolver createDataStore / connectDataStore reject
 * bad crossAccountRoleArn values via arn-safety.ts.
 *
 * Per site: two negatives (foreign account without externalId; non-IAM ARN) + positive.
 */

// ---- Mock setup (same shape as sibling datastore-resolver-create.test.ts) ----
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
      .mockImplementation((input: unknown) => ({ _type: "Put", input })),
    GetCommand: jest
      .fn()
      .mockImplementation((input: unknown) => ({ _type: "Get", input })),
    UpdateCommand: jest
      .fn()
      .mockImplementation((input: unknown) => ({ _type: "Update", input })),
    DeleteCommand: jest
      .fn()
      .mockImplementation((input: unknown) => ({ _type: "Delete", input })),
    QueryCommand: jest
      .fn()
      .mockImplementation((input: unknown) => ({ _type: "Query", input })),
  };
});

const mockSecretsSend = jest.fn();
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockSecretsSend })),
  CreateSecretCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ _type: "CreateSecret", input })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({
    _type: "GetSecretValue",
    input,
  })),
  DeleteSecretCommand: jest.fn().mockImplementation((input: unknown) => ({
    _type: "DeleteSecret",
    input,
  })),
}));

const mockAdapter = {
  category: "datastore" as const,
  spec: {
    type: "S3",
    provider: "AWS",
    category: "datastore" as const,
    authentication: { method: "IAM_ROLE", fields: [], secretStructure: {} },
    configuration: { required: [], optional: [], ssmParameters: [] },
  },
  requiredPolicies: jest.fn().mockReturnValue({
    provision: [{ actions: ["s3:*"], resources: ["*"] }],
    connect: [{ actions: ["s3:GetObject"], resources: ["*"] }],
  }),
  provision: jest
    .fn()
    .mockResolvedValue({ resourceArn: "arn:aws:s3:::bucket" }),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  deprovision: jest.fn().mockResolvedValue(undefined),
  testConnection: jest.fn().mockResolvedValue({ success: true, message: "OK" }),
  getMetrics: jest.fn().mockResolvedValue({ size: "0 MB", records: 0 }),
};
jest.mock("../adapters/registry", () => ({
  getAdapter: jest.fn().mockReturnValue(mockAdapter),
}));

const PLATFORM = "123456789012";
const FOREIGN = "999888777666";

const mockPolicyManager = {
  getAccountContext: jest
    .fn()
    .mockResolvedValue({ accountId: PLATFORM, region: "us-east-1" }),
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

// Mock trust-path (soft gate, non-blocking)
jest.mock("../../utils/trust-path", () => ({
  computeTrustPath: jest.fn().mockResolvedValue({
    hops: [],
    notes: [],
    findings: [],
    clean: true,
  }),
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-ds-uuid") }));

process.env.DATASTORES_TABLE = "TestDataStoresTable";

import { handler } from "../datastore-resolver";
import { ValidationError } from "../adapters/errors";

type HandlerEvent = Parameters<typeof handler>[0];

function makeCreateEvent(config: Record<string, unknown>): HandlerEvent {
  return {
    info: { fieldName: "createDataStore" },
    arguments: {
      input: {
        orgId: "org-test",
        name: "test-ds",
        type: "S3",
        category: "storage",
        provisionMode: "CREATE_NEW",
        config: JSON.stringify(config),
      },
    },
    identity: { username: "test-user", "custom:organization": "org-test" },
  } as unknown as HandlerEvent;
}

function makeConnectEvent(
  dataStoreId: string,
  _config: Record<string, unknown>,
): HandlerEvent {
  return {
    info: { fieldName: "connectDataStore" },
    arguments: { dataStoreId, orgId: "org-test" },
    identity: { username: "test-user", "custom:organization": "org-test" },
  } as unknown as HandlerEvent;
}

describe("CIT-254 C12 — datastore-resolver ARN binding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Query") return Promise.resolve({ Items: [] });
      if (cmd._type === "Put") return Promise.resolve({});
      if (cmd._type === "Update")
        return Promise.resolve({
          Attributes: {
            dataStoreId: "test-ds-uuid",
            status: "CONNECTED",
            version: 1,
          },
        });
      if (cmd._type === "Get")
        return Promise.resolve({
          Item: {
            dataStoreId: "existing-ds",
            type: "S3",
            config: JSON.stringify({
              bucketName: "b",
              crossAccountRoleArn: `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
            }),
            version: 1,
            status: "DISCONNECTED",
            orgId: "org-test",
          },
        });
      return Promise.resolve({});
    });
  });

  describe("createDataStore", () => {
    // --- Negative: cross-account without externalId ---
    it("rejects crossAccountRoleArn in a foreign account without externalId", async () => {
      const event = makeCreateEvent({
        bucketName: "b",
        crossAccountRoleArn: `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
      });

      await expect(handler(event)).rejects.toThrow(ValidationError);
      expect(mockPolicyManager.ensureRole).not.toHaveBeenCalled();
    });

    // --- Negative: non-IAM ARN ---
    it("rejects a non-IAM ARN (arn:aws:s3:::bucket)", async () => {
      const event = makeCreateEvent({
        bucketName: "b",
        crossAccountRoleArn: "arn:aws:s3:::evil-bucket",
        externalId: "ext-123",
      });

      await expect(handler(event)).rejects.toThrow(ValidationError);
      expect(mockPolicyManager.ensureRole).not.toHaveBeenCalled();
    });

    // --- Positive: valid cross-account role with externalId ---
    it("accepts a valid cross-account IAM role with externalId", async () => {
      const event = makeCreateEvent({
        bucketName: "b",
        crossAccountRoleArn: `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
        externalId: "ext-abc",
      });

      const result = await handler(event);
      expect(result).toBeDefined();
      // ensureRole was called with the externalId
      expect(mockPolicyManager.ensureRole).toHaveBeenCalledWith(
        "test-ds-uuid",
        expect.any(Array),
        PLATFORM,
        "datastore",
        `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
        expect.any(Array),
        "ext-abc",
        expect.any(Object),
      );
    });
  });

  describe("connectDataStore", () => {
    // --- Negative: cross-account without externalId stored in config ---
    it("rejects a stored crossAccountRoleArn without externalId", async () => {
      // Config from the DynamoDB mock has crossAccountRoleArn but no externalId
      const event = makeConnectEvent("existing-ds", {});

      await expect(handler(event)).rejects.toThrow(ValidationError);
      expect(mockPolicyManager.ensureRole).not.toHaveBeenCalled();
    });

    // --- Positive: stored config with externalId ---
    it("accepts a stored crossAccountRoleArn when config includes externalId", async () => {
      mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
        if (cmd._type === "Get")
          return Promise.resolve({
            Item: {
              dataStoreId: "existing-ds",
              type: "S3",
              config: JSON.stringify({
                bucketName: "b",
                crossAccountRoleArn: `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
                externalId: "ext-xyz",
              }),
              version: 1,
              status: "DISCONNECTED",
              orgId: "org-test",
            },
          });
        if (cmd._type === "Update")
          return Promise.resolve({
            Attributes: {
              dataStoreId: "existing-ds",
              status: "CONNECTED",
              version: 2,
            },
          });
        return Promise.resolve({ Items: [] });
      });

      const event = makeConnectEvent("existing-ds", {});
      const result = await handler(event);
      expect(result).toBeDefined();
      expect(mockPolicyManager.ensureRole).toHaveBeenCalledWith(
        "existing-ds",
        expect.any(Array),
        PLATFORM,
        "datastore",
        `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
        expect.any(Array),
        "ext-xyz",
        expect.any(Object),
      );
    });
  });
});
