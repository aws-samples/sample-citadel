/**
 * datastore-resolver-create-server-derived-org.test.ts — Wave-3B design
 * item 4: createDataStore must use the server-derived callerOrgId for ALL
 * FOUR uses (stored record orgId, OrgIndex idempotency query, Secrets
 * Manager path, and — implicitly — dropping the equality-rejection branch
 * for non-admins). A mismatching client-supplied input.orgId is no longer
 * rejected; it is silently ignored in favor of the caller's own resolved
 * org. schema.graphql is unchanged — orgId remains a required input field,
 * just no longer trusted.
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

jest.mock("../adapters/registry", () => ({
  getAdapter: jest.fn().mockReturnValue({
    category: "datastore",
    spec: {
      type: "KNOWLEDGE_BASE",
      provider: "AWS",
      category: "datastore",
      authentication: { method: "IAM_ROLE", fields: [], secretStructure: {} },
      configuration: { required: [], optional: [], ssmParameters: [] },
    },
    requiredPolicies: jest.fn().mockReturnValue({ provision: [], connect: [] }),
    provision: jest.fn().mockResolvedValue({
      resourceArn: "arn:aws:bedrock:us-east-1:123:knowledge-base/KB1",
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    deprovision: jest.fn().mockResolvedValue(undefined),
    testConnection: jest
      .fn()
      .mockResolvedValue({ success: true, message: "OK" }),
    getMetrics: jest.fn().mockResolvedValue({ size: "0 MB", records: 0 }),
  }),
}));

jest.mock("../../utils/policy-manager", () => ({
  PolicyManager: jest.fn().mockImplementation(() => ({
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
  })),
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid") }));

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
  assertRowOrg: jest.fn(),
}));

process.env.DATASTORES_TABLE = "TestDataStoresTable";

import { handler } from "../datastore-resolver";
import { extractOrgFromEvent } from "../../utils/auth-event";
import { PermissionError } from "../adapters/errors";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.Mock;

type HandlerEvent = Parameters<typeof handler>[0];

const makeCreateEvent = (
  input: Record<string, unknown>,
  identity: Record<string, unknown> = { username: "test-user" },
): HandlerEvent =>
  ({
    info: { fieldName: "createDataStore" },
    arguments: { input },
    identity,
  }) as unknown as HandlerEvent;

const baseInput = {
  name: "test-kb",
  type: "KNOWLEDGE_BASE",
  category: "KNOWLEDGE_BASE",
  provisionMode: "CREATE_NEW",
  config: JSON.stringify({ resourceName: "test-kb" }),
};

describe("createDataStore — server-derived org used for all four call sites", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let lastPutItem: Record<string, unknown> | undefined;
    mockDynamoSend.mockImplementation(
      (cmd: { _type?: string; input?: { Item?: Record<string, unknown> } }) => {
        if (cmd._type === "Query") return Promise.resolve({ Items: [] });
        if (cmd._type === "Put") {
          lastPutItem = cmd.input?.Item;
          return Promise.resolve({});
        }
        if (cmd._type === "Update") {
          return Promise.resolve({
            Attributes: { ...lastPutItem, status: "CONNECTED" },
          });
        }
        return Promise.resolve({});
      },
    );
    mockSecretsSend.mockResolvedValue({
      ARN: "arn:aws:secretsmanager:us-east-1:123:secret:test",
    });
  });

  test("a mismatched client-supplied input.orgId is IGNORED, not rejected — the record is stamped with the caller's server-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");

    const event = makeCreateEvent({
      ...baseInput,
      orgId: "org-attacker-supplied",
      clientRequestToken: "tok-mismatch",
    });

    const result = (await handler(event)) as { orgId: string };

    expect(result.orgId).toBe("org-real");

    const putCall = mockDynamoSend.mock.calls.find(
      (c) => c[0]._type === "Put",
    )?.[0];
    expect(putCall.input.Item.orgId).toBe("org-real");
  });

  test("still denies when no caller org resolves at all (provisioning gap)", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);

    const event = makeCreateEvent({
      ...baseInput,
      orgId: "org-whatever",
      clientRequestToken: "tok-none",
    });

    await expect(handler(event)).rejects.toBeInstanceOf(PermissionError);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  test("OrgIndex idempotency query uses the server-derived org, not the client-supplied orgId", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");

    const event = makeCreateEvent({
      ...baseInput,
      orgId: "org-attacker-supplied",
      clientRequestToken: "tok-idem",
    });

    await handler(event);

    const queryCall = mockDynamoSend.mock.calls.find(
      (c) => c[0]._type === "Query",
    )?.[0];
    expect(queryCall.input.ExpressionAttributeValues[":orgId"]).toBe(
      "org-real",
    );
  });

  test("idempotent replay: an existing row for the caller's server-derived org + token short-circuits without a new Put", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockDynamoSend.mockImplementation(
      (cmd: { _type?: string; input?: never }) => {
        if (cmd._type === "Query") {
          return Promise.resolve({
            Items: [{ dataStoreId: "existing-ds", orgId: "org-real" }],
          });
        }
        return Promise.resolve({});
      },
    );

    const event = makeCreateEvent({
      ...baseInput,
      orgId: "org-attacker-supplied",
      clientRequestToken: "tok-replay",
    });

    const result = (await handler(event)) as { dataStoreId: string };
    expect(result.dataStoreId).toBe("existing-ds");
    expect(mockDynamoSend.mock.calls.some((c) => c[0]._type === "Put")).toBe(
      false,
    );
  });

  test("Secrets Manager path is built from the server-derived org, not the client-supplied orgId", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");

    const event = makeCreateEvent({
      ...baseInput,
      orgId: "org-attacker-supplied",
      credentials: JSON.stringify({ apiKey: "secret-value" }),
      clientRequestToken: "tok-secret",
    });

    await handler(event);

    const secretCall = mockSecretsSend.mock.calls[0]?.[0];
    expect(secretCall.input.Name).toContain("/citadel/datastores/org-real/");
    expect(secretCall.input.Name).not.toContain("org-attacker-supplied");
  });

  test("admin callers get no special-cased bypass either — same server-derived org applies", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");

    const event = makeCreateEvent(
      {
        ...baseInput,
        orgId: "org-other-tenant",
        clientRequestToken: "tok-admin",
      },
      { username: "admin-user", "custom:role": "admin" },
    );

    const result = (await handler(event)) as { orgId: string };
    expect(result.orgId).toBe("org-real");
  });

  test("matching client orgId still works exactly as before (control case)", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");

    const event = makeCreateEvent({
      ...baseInput,
      orgId: "org-real",
      clientRequestToken: "tok-match",
    });

    const result = (await handler(event)) as { orgId: string };
    expect(result.orgId).toBe("org-real");
  });
});
