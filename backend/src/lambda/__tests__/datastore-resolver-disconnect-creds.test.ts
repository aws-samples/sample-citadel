/**
 * Verifies that disconnectDataStore vends scoped credentials to adapter.disconnect.
 */

// Mock DynamoDB
const mockGetItem = jest.fn();
const mockUpdateItem = jest.fn().mockResolvedValue({ Attributes: {} });
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "GetCommand") return mockGetItem();
        if (cmd.constructor.name === "UpdateCommand") return mockUpdateItem();
        return {};
      },
    }),
  },
  GetCommand: jest
    .fn()
    .mockImplementation((p: unknown) => ({
      ...p,
      constructor: { name: "GetCommand" },
    })),
  UpdateCommand: jest
    .fn()
    .mockImplementation((p: unknown) => ({
      ...p,
      constructor: { name: "UpdateCommand" },
    })),
  PutCommand: jest.fn(),
  DeleteCommand: jest.fn(),
  QueryCommand: jest.fn(),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest
    .fn()
    .mockImplementation(() => ({ send: jest.fn() })),
  CreateSecretCommand: jest.fn(),
  GetSecretValueCommand: jest.fn(),
  DeleteSecretCommand: jest.fn(),
}));

// Mock adapter registry
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
jest.mock("../adapters/registry", () => ({
  getAdapter: () => ({
    requiredPolicies: () => ({
      provision: [],
      connect: [{ actions: ["s3:GetObject"], resources: ["*"] }],
    }),
    disconnect: mockDisconnect,
  }),
}));

// Mock policy manager
const mockAssumeScopedRole = jest.fn().mockResolvedValue({
  accessKeyId: "AKIATEST",
  secretAccessKey: "secret",
  sessionToken: "tok",
});
jest.mock("../../utils/policy-manager", () => ({
  PolicyManager: jest.fn().mockImplementation(() => ({
    getAccountContext: jest
      .fn()
      .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
    assumeScopedRole: mockAssumeScopedRole,
  })),
}));

// Mock auth
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("org-1"),
  isAdminFromEvent: jest.fn().mockReturnValue(false),
  assertRowOrg: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../utils/operations-registry", () => ({
  getDataStoreOperations: jest.fn().mockReturnValue([]),
}));

jest.mock("../../utils/arn-safety", () => ({
  assertCrossAccountRole: jest.fn(),
  assertSameAccountArn: jest.fn(),
  ArnRejectedError: class extends Error {},
  emitArnRefused: jest.fn(),
}));

jest.mock("../../utils/trust-path", () => ({
  computeTrustPath: jest.fn().mockResolvedValue({ clean: true, findings: [] }),
}));

process.env.DATASTORES_TABLE = "test-datastores";

describe("disconnectDataStore credential vending", () => {
  it("passes scoped credentials to adapter.disconnect", async () => {
    mockGetItem.mockResolvedValue({
      Item: {
        dataStoreId: "ds-1",
        type: "S3",
        config: JSON.stringify({ bucketName: "test" }),
        version: 1,
        orgId: "org-1",
      },
    });

    const { handler } = await import("../datastore-resolver");
    await handler({
      info: { fieldName: "disconnectDataStore" },
      arguments: { dataStoreId: "ds-1", orgId: "org-1", input: {} },
    } as never);

    expect(mockAssumeScopedRole).toHaveBeenCalledWith(
      "ds-1",
      "123456789012",
      "datastore",
    );
    expect(mockDisconnect).toHaveBeenCalledWith(
      { bucketName: "test" },
      expect.objectContaining({ accessKeyId: "AKIATEST" }),
    );
  });
});
