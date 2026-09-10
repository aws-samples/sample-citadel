/**
 * TDD (red-first) for the createDataStore org fail-closed message split.
 *
 * Background: decision b5d463f2 removed the admin bypass so createDataStore
 * rejects an org mismatch for EVERYONE, including admins (see the block
 * comment above createDataStore in datastore-resolver.ts). That correctly
 * exposed a pre-existing diagnosability defect: the single check
 *   `if (!callerOrgId || callerOrgId !== input.orgId)`
 * threw the SAME message ("Access denied: orgId does not match caller's
 * organization") whether the caller had NO resolvable org claim at all (a
 * provisioning gap — nothing to compare against) or had a real org that
 * simply didn't match the submitted orgId (a genuine cross-org attempt).
 * That made "your account isn't provisioned yet" look identical to "you
 * tried to write into someone else's org".
 *
 * This test asserts the two cases now produce distinct, actionable
 * messages, that BOTH still reject (fail closed — no coercion, no admin
 * bypass), and that neither message leaks another tenant's org id.
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
    provision: jest
      .fn()
      .mockResolvedValue({
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

describe("createDataStore — distinct fail-closed org messages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === "Query") return Promise.resolve({ Items: [] });
      if (cmd._type === "Put") return Promise.resolve({});
      return Promise.resolve({});
    });
  });

  const baseInput = {
    name: "test-kb",
    type: "KNOWLEDGE_BASE",
    category: "KNOWLEDGE_BASE",
    provisionMode: "CREATE_NEW",
    config: JSON.stringify({ resourceName: "test-kb" }),
    clientRequestToken: "tok-1",
  };

  test("no resolvable org claim → provisioning-gap message telling caller to contact an administrator", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);

    const event = makeCreateEvent({ ...baseInput, orgId: "org-target" });

    await expect(handler(event)).rejects.toMatchObject({
      message: expect.stringMatching(/contact.*administrator/i),
    });
    // Must NOT be the generic mismatch wording, and must not echo the
    // submitted orgId back (nothing to leak, but guard the shape anyway).
    await expect(handler(event)).rejects.not.toMatchObject({
      message: expect.stringContaining("does not match"),
    });
  });

  test("resolved org differs from submitted orgId → mismatch message, without leaking either org id", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");

    const event = makeCreateEvent({ ...baseInput, orgId: "org-other-tenant" });

    await expect(handler(event)).rejects.toMatchObject({
      message: expect.stringMatching(/does not match/i),
    });
    await expect(handler(event)).rejects.not.toMatchObject({
      message: expect.stringContaining("org-real"),
    });
    await expect(handler(event)).rejects.not.toMatchObject({
      message: expect.stringContaining("org-other-tenant"),
    });
    // Must be distinguishable from the no-claim message.
    await expect(handler(event)).rejects.not.toMatchObject({
      message: expect.stringMatching(/contact.*administrator/i),
    });
  });

  test("both cases still reject — no admin bypass, no coercion to make the call succeed", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    const noClaimEvent = makeCreateEvent(
      { ...baseInput, orgId: "org-target" },
      { username: "admin-user", "custom:role": "admin" },
    );
    await expect(handler(noClaimEvent)).rejects.toBeTruthy();

    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    const mismatchEvent = makeCreateEvent(
      { ...baseInput, orgId: "org-other-tenant" },
      { username: "admin-user", "custom:role": "admin" },
    );
    await expect(handler(mismatchEvent)).rejects.toBeTruthy();
  });
});

// Note: the "matching org succeeds" control case is already covered by
// datastore-resolver-create.test.ts (config enrichment suite), which uses
// makeCreateEvent with identity['custom:organization'] === input.orgId.
// Not duplicated here to avoid re-running the ~10s IAM-propagation wait
// inside createDataStore's CREATE_NEW path per test.
