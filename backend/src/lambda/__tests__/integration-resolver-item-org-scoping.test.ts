/**
 * Cross-org item-level authz tests for integration-resolver.ts (finding
 * ca76d041, integration half; CRE item 3).
 *
 * Before this fix: getIntegration, updateIntegration, deleteIntegration,
 * testIntegration, connectIntegration, and disconnectIntegration all acted
 * on a client-supplied integrationId with NO reconciliation against the
 * caller's org — a cross-tenant IDOR. testIntegration/connectIntegration
 * read the row's secret from Secrets Manager; deleteIntegration emits a
 * teardown event that (via gateway-registration-handler) deletes the
 * gateway target, credential provider, and Secrets Manager secret;
 * updateIntegration can read+rewrite the secret and SSM config.
 * createIntegration additionally trusted a client-supplied input.orgId
 * with no server-side derivation.
 *
 * Fix: fetch-then-verify via the shared `assertRowOrg` helper
 * (backend/src/utils/auth-event.ts) — load the row, reconcile its orgId
 * against the caller's server-derived org (extractOrgFromEvent), and refuse
 * BEFORE any Secrets Manager call, SSM call, EventBridge publish, or
 * DynamoDB write. Admins bypass, mirroring the read-path admin bypass
 * already used by listIntegrations.
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
    UpdateCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Update", input })),
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

const mockSsmSend = jest.fn();
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  PutParameterCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "PutParameter", input })),
  GetParameterCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "GetParameter", input })),
}));

const mockEventBridgeSend = jest.fn();
jest.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockEventBridgeSend })),
  PutEventsCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "PutEvents", input })),
}));

jest.mock("../../utils/connector-registry", () => ({
  getConnectorSpec: jest.fn().mockReturnValue({
    provider: "Slack",
    authentication: { method: "API_KEY", fields: ["apiKey"] },
    configuration: { required: [], ssmParameters: [] },
  }),
  validateCredentials: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
}));

jest.mock("../../utils/connection-tester", () => ({
  testConnection: jest.fn().mockResolvedValue({ success: true, message: "OK" }),
}));

jest.mock("../../utils/credential-manager", () => ({
  storeCredentials: jest.fn().mockResolvedValue({
    secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:new",
    ssmParameterPrefix: "/citadel/integrations/new",
  }),
}));

jest.mock("../../utils/gateway-target-manager", () => ({
  provisionCredentialProvider: jest.fn().mockResolvedValue({
    credentialProviderArn: "arn:aws:bedrock-agentcore:...:provider/new",
  }),
  deprovisionCredentialProvider: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("test-uuid") }));

process.env.INTEGRATIONS_TABLE = "TestIntegrationsTable";
process.env.EVENT_BUS_NAME = "test-event-bus";

import { handler } from "../integration-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

/** The victim row: belongs to org-victim, has a secretArn (so
 * testIntegration/connectIntegration's Secrets Manager read, and
 * deleteIntegration's teardown event, would fire if the guard did not
 * block it). */
const VICTIM_ROW = {
  PK: "ORG#org-victim",
  SK: "INTEGRATION#SLACK#int-victim",
  integrationId: "int-victim",
  integrationType: "SLACK",
  name: "Victim Slack",
  status: "CONFIGURED",
  orgId: "org-victim",
  config: {},
  secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:victim",
  ssmParameterPrefix: "/citadel/integrations/victim",
  credentialProviderArn: "arn:aws:bedrock-agentcore:...:provider/victim",
  credentialProviderType: "API_KEY",
  version: 1,
};

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  identity: Record<string, unknown>,
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
const ADMIN_IDENTITY = { sub: "admin-1", "custom:role": "admin" };

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
    if (cmd._type === "Query")
      return Promise.resolve({ Items: [{ ...VICTIM_ROW }] });
    if (cmd._type === "Update")
      return Promise.resolve({ Attributes: { ...VICTIM_ROW } });
    return Promise.resolve({});
  });
  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ apiKey: "shh" }),
  });
  mockEventBridgeSend.mockResolvedValue({ FailedEntryCount: 0, Entries: [] });
});

describe("cross-org caller is refused before any mutation/side-effect", () => {
  test("getIntegration: cross-org caller is denied", async () => {
    await expect(
      handler(
        makeEvent(
          "getIntegration",
          { integrationId: "int-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);
  });

  test("updateIntegration: cross-org caller is denied; zero secret/SSM/DynamoDB writes", async () => {
    await expect(
      handler(
        makeEvent(
          "updateIntegration",
          { input: { integrationId: "int-victim", name: "pwned" } },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(mockSsmSend).not.toHaveBeenCalled();
    const putCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Put",
    );
    expect(putCalls).toHaveLength(0);
  });

  test("deleteIntegration: cross-org caller is denied; zero EventBridge/DynamoDB-update calls", async () => {
    await expect(
      handler(
        makeEvent(
          "deleteIntegration",
          { integrationId: "int-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockEventBridgeSend).not.toHaveBeenCalled();
    const updateCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Update",
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("testIntegration: cross-org caller is denied; zero Secrets Manager / SSM / DynamoDB-write calls", async () => {
    await expect(
      handler(
        makeEvent(
          "testIntegration",
          { integrationId: "int-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(mockSsmSend).not.toHaveBeenCalled();
    const putCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Put",
    );
    expect(putCalls).toHaveLength(0);
  });

  test("connectIntegration: cross-org caller is denied; zero EventBridge/DynamoDB-write calls", async () => {
    await expect(
      handler(
        makeEvent(
          "connectIntegration",
          { integrationId: "int-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockEventBridgeSend).not.toHaveBeenCalled();
    const putCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Put",
    );
    expect(putCalls).toHaveLength(0);
  });

  test("disconnectIntegration: cross-org caller is denied; zero EventBridge/DynamoDB-write calls", async () => {
    // Use a CONNECTED row so the lifecycle precondition (canDisconnect)
    // does not itself short-circuit before the org guard is reached — the
    // guard must run before ANY logic that would otherwise proceed, and
    // this asserts denial happens even when the row is otherwise eligible.
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Query")
        return Promise.resolve({
          Items: [{ ...VICTIM_ROW, status: "CONNECTED" }],
        });
      if (cmd._type === "Update")
        return Promise.resolve({ Attributes: { ...VICTIM_ROW } });
      return Promise.resolve({});
    });

    await expect(
      handler(
        makeEvent(
          "disconnectIntegration",
          { integrationId: "int-victim" },
          ATTACKER_IDENTITY,
        ),
      ),
    ).rejects.toThrow(/access denied/i);

    expect(mockEventBridgeSend).not.toHaveBeenCalled();
    const putCalls = mockDynamoSend.mock.calls.filter(
      ([cmd]: [{ _type?: string }]) => cmd._type === "Put",
    );
    expect(putCalls).toHaveLength(0);
  });
});

describe("legitimate same-org callers still succeed", () => {
  test("getIntegration: same-org caller succeeds", async () => {
    const result = (await handler(
      makeEvent(
        "getIntegration",
        { integrationId: "int-victim" },
        SAME_ORG_IDENTITY,
      ),
    )) as { integrationId: string };

    expect(result.integrationId).toBe("int-victim");
  });

  test("testIntegration: same-org caller succeeds", async () => {
    const result = (await handler(
      makeEvent(
        "testIntegration",
        { integrationId: "int-victim" },
        SAME_ORG_IDENTITY,
      ),
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockSecretsSend).toHaveBeenCalled();
  });

  test("deleteIntegration: same-org caller succeeds and publishes teardown event", async () => {
    const result = (await handler(
      makeEvent(
        "deleteIntegration",
        { integrationId: "int-victim" },
        SAME_ORG_IDENTITY,
      ),
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockEventBridgeSend).toHaveBeenCalledTimes(1);
  });

  test("admin caller may act cross-org (bypass preserved)", async () => {
    const result = (await handler(
      makeEvent(
        "getIntegration",
        { integrationId: "int-victim" },
        ADMIN_IDENTITY,
      ),
    )) as { integrationId: string };

    expect(result.integrationId).toBe("int-victim");
  });
});

describe("createIntegration rejects a foreign/mismatched orgId", () => {
  beforeEach(() => {
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Put") return Promise.resolve({});
      return Promise.resolve({});
    });
  });

  test("rejects when input.orgId does not match the server-derived caller org", async () => {
    await expect(
      handler(
        makeEvent(
          "createIntegration",
          {
            input: {
              integrationType: "SLACK",
              name: "sneaky",
              orgId: "org-foreign",
              credentials: { apiKey: "x" },
              config: {},
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
    expect(mockSecretsSend).not.toHaveBeenCalled();
  });

  test("accepts when input.orgId matches the server-derived caller org", async () => {
    const result = (await handler(
      makeEvent(
        "createIntegration",
        {
          input: {
            integrationType: "SLACK",
            name: "legit",
            orgId: "org-real",
            credentials: { apiKey: "x" },
            config: {},
          },
        },
        { sub: "user-real", "custom:organization": "org-real" },
      ),
    )) as { integrationId: string };

    expect(result.integrationId).toBe("test-uuid");
  });

  test("admin may create with an explicit orgId (bypass preserved)", async () => {
    const result = (await handler(
      makeEvent(
        "createIntegration",
        {
          input: {
            integrationType: "SLACK",
            name: "admin-created",
            orgId: "org-any",
            credentials: { apiKey: "x" },
            config: {},
          },
        },
        ADMIN_IDENTITY,
      ),
    )) as { integrationId: string };

    expect(result.integrationId).toBe("test-uuid");
  });
});
