/**
 * TDD Tests for agent-credential-vender org scoping
 * (wave 2b, branch fix/vender-org-scoping)
 *
 * Covers:
 * - missing orgId on the request -> fail closed (no policy/role calls)
 * - agent's own orgId mismatch vs request org -> rejected
 * - declared datastore/integration id belonging to a different org -> whole
 *   request rejected (not silently dropped)
 * - declared id that cannot be resolved -> rejected
 * - same-org ids -> allowed, policies computed normally
 */

const mockGetAccountContext = jest.fn();
const mockEnsureRole = jest.fn();
const mockAssumeScopedRole = jest.fn();
const mockDynamoSend = jest.fn();

jest.mock("../../utils/policy-manager", () => {
  const MockPolicyManager = jest.fn().mockImplementation(() => ({
    getAccountContext: mockGetAccountContext,
    ensureRole: mockEnsureRole,
    assumeScopedRole: mockAssumeScopedRole,
  }));
  (
    MockPolicyManager as unknown as {
      getRoleName: (id: string, scope: string) => string;
    }
  ).getRoleName = (id: string, scope: string) => {
    const prefixes: Record<string, string> = {
      datastore: "citadel-ds-",
      integration: "citadel-int-",
      agent: "citadel-agent-",
    };
    return `${prefixes[scope] || "citadel-ds-"}${id}`;
  };
  (
    MockPolicyManager as unknown as {
      buildPolicyDocument: (
        policies: Array<{ actions: string[]; resources: string[] }>,
      ) => unknown;
    }
  ).buildPolicyDocument = (
    policies: Array<{ actions: string[]; resources: string[] }>,
  ) => ({
    Version: "2012-10-17",
    Statement: policies.map((p) => ({
      Effect: "Allow",
      Action: p.actions,
      Resource: p.resources,
    })),
  });
  return { PolicyManager: MockPolicyManager };
});

jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: mockDynamoSend })),
    },
  };
});

process.env.AGENT_CONFIG_TABLE = "agent-config-table";
process.env.DATASTORES_TABLE = "datastores-table";
process.env.INTEGRATIONS_TABLE = "integrations-table";

import { handler } from "../agent-credential-vender";

const AGENT_ORG_A = { agentId: "agent-1", orgId: "org-a" };
const DS_ORG_A = { dataStoreId: "ds-a", orgId: "org-a" };
const DS_ORG_B = { dataStoreId: "ds-b", orgId: "org-b" };
const INT_ORG_A = { integrationId: "int-a", orgId: "org-a" };
const INT_ORG_B = { integrationId: "int-b", orgId: "org-b" };

function mockDynamoResolvers(opts: {
  agent?: Record<string, unknown> | null;
  dataStores?: Record<string, Record<string, unknown> | null>;
  integrations?: Record<string, Record<string, unknown> | null>;
}) {
  mockDynamoSend.mockImplementation((command: unknown) => {
    const input = (command as { input?: Record<string, unknown> }).input || {};
    const tableName = input.TableName as string | undefined;
    if (tableName === "agent-config-table") {
      return Promise.resolve({
        Item: opts.agent === undefined ? AGENT_ORG_A : opts.agent,
      });
    }
    if (tableName === "datastores-table") {
      const key = input.Key as { dataStoreId: string } | undefined;
      const id = key?.dataStoreId as string;
      const row = opts.dataStores?.[id];
      return Promise.resolve({ Item: row === undefined ? undefined : row });
    }
    if (tableName === "integrations-table") {
      const values = input.ExpressionAttributeValues as
        Record<string, string> | undefined;
      const id = values?.[":id"] as string;
      const row = opts.integrations?.[id];
      return Promise.resolve({ Items: row ? [row] : [] });
    }
    return Promise.resolve({});
  });
}

describe("agent-credential-vender org scoping", () => {
  beforeEach(() => {
    mockGetAccountContext.mockClear();
    mockEnsureRole.mockClear();
    mockAssumeScopedRole.mockClear();
    mockDynamoSend.mockClear();

    mockGetAccountContext.mockResolvedValue({
      accountId: "123456789012",
      region: "us-west-2",
    });
    mockEnsureRole.mockResolvedValue(undefined);
    mockAssumeScopedRole.mockResolvedValue({
      accessKeyId: "AKIA_SCOPED",
      secretAccessKey: "SECRET_SCOPED",
      sessionToken: "TOKEN_SCOPED",
    });

    mockDynamoResolvers({
      agent: AGENT_ORG_A,
      dataStores: { "ds-a": DS_ORG_A, "ds-b": DS_ORG_B },
      integrations: { "int-a": INT_ORG_A, "int-b": INT_ORG_B },
    });
  });

  test("rejects request missing org (fail closed, never defaults org)", async () => {
    const result = await handler({
      agentId: "agent-1",
      requiredPermissions: { dataStores: ["ds-a"] },
    } as never);

    expect(result.credentials).toBeNull();
    expect(result.error).toBeDefined();
    expect(mockEnsureRole).not.toHaveBeenCalled();
    expect(mockAssumeScopedRole).not.toHaveBeenCalled();
  });

  test("rejects when agent record org does not match request org", async () => {
    mockDynamoResolvers({
      agent: AGENT_ORG_A, // agent belongs to org-a
      dataStores: { "ds-a": DS_ORG_A },
    });

    const result = await handler({
      agentId: "agent-1",
      org: "org-b", // request claims a different org
      requiredPermissions: { dataStores: ["ds-a"] },
    } as never);

    expect(result.credentials).toBeNull();
    expect(result.error).toBeDefined();
    expect(mockEnsureRole).not.toHaveBeenCalled();
  });

  test("rejects the whole request when a declared datastore id belongs to a different org", async () => {
    const result = await handler({
      agentId: "agent-1",
      org: "org-a",
      requiredPermissions: { dataStores: ["ds-a", "ds-b"] },
    } as never);

    expect(result.credentials).toBeNull();
    expect(result.error).toBeDefined();
    // Cross-org id must not silently drop — the whole vend is refused.
    expect(mockEnsureRole).not.toHaveBeenCalled();
    expect(mockAssumeScopedRole).not.toHaveBeenCalled();
  });

  test("rejects the whole request when a declared integration id belongs to a different org", async () => {
    const result = await handler({
      agentId: "agent-1",
      org: "org-a",
      requiredPermissions: { integrations: ["int-a", "int-b"] },
    } as never);

    expect(result.credentials).toBeNull();
    expect(result.error).toBeDefined();
    expect(mockEnsureRole).not.toHaveBeenCalled();
  });

  test("rejects when a declared datastore id cannot be resolved", async () => {
    mockDynamoResolvers({
      agent: AGENT_ORG_A,
      dataStores: { "ds-a": DS_ORG_A }, // ds-missing absent
    });

    const result = await handler({
      agentId: "agent-1",
      org: "org-a",
      requiredPermissions: { dataStores: ["ds-a", "ds-missing"] },
    } as never);

    expect(result.credentials).toBeNull();
    expect(result.error).toBeDefined();
    expect(mockEnsureRole).not.toHaveBeenCalled();
  });

  test("rejects when a declared integration id cannot be resolved", async () => {
    mockDynamoResolvers({
      agent: AGENT_ORG_A,
      integrations: {}, // int-missing absent
    });

    const result = await handler({
      agentId: "agent-1",
      org: "org-a",
      requiredPermissions: { integrations: ["int-missing"] },
    } as never);

    expect(result.credentials).toBeNull();
    expect(result.error).toBeDefined();
    expect(mockEnsureRole).not.toHaveBeenCalled();
  });

  test("allows the vend when all declared ids and the agent belong to the request org", async () => {
    const result = await handler({
      agentId: "agent-1",
      org: "org-a",
      requiredPermissions: { dataStores: ["ds-a"], integrations: ["int-a"] },
    } as never);

    expect(result.error).toBeUndefined();
    expect(result.credentials).not.toBeNull();
    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    expect(mockAssumeScopedRole).toHaveBeenCalledTimes(1);
  });

  test("allows a vend with only model permissions (no datastore/integration lookups needed) for a same-org agent", async () => {
    const result = await handler({
      agentId: "agent-1",
      org: "org-a",
      requiredPermissions: { models: ["anthropic.claude-sonnet-4-20250514"] },
    } as never);

    expect(result.error).toBeUndefined();
    expect(result.credentials).not.toBeNull();
    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
  });
});
