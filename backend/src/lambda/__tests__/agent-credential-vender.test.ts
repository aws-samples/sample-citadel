/**
 * TDD Tests for agent-credential-vender Lambda
 *
 * Updated for wave 2b (branch fix/vender-org-scoping): the vender now
 * requires `org` on every request and resolves the agent record plus every
 * declared dataStore/integration id to that org before calling
 * ensureRole/assumeScopedRole. These tests supply a same-org agent and
 * same-org declared ids so the pre-existing (non-org) assertions below
 * still exercise the exact same policy-computation path.
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
  // Static methods
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

const ORG = "org-legacy";

describe("agent-credential-vender", () => {
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

    // Every agent/dataStore/integration id used below resolves to the same
    // org as the request, so the org-scoping gate is a no-op pass-through
    // and these tests still exercise only the policy-computation path.
    mockDynamoSend.mockImplementation((command: unknown) => {
      const input =
        (command as { input?: Record<string, unknown> }).input || {};
      const tableName = input.TableName as string | undefined;
      if (tableName === "agent-config-table") {
        return Promise.resolve({
          Item: {
            agentId: (input.Key as { agentId: string }).agentId,
            orgId: ORG,
          },
        });
      }
      if (tableName === "datastores-table") {
        const key = input.Key as { dataStoreId: string };
        return Promise.resolve({
          Item: { dataStoreId: key.dataStoreId, orgId: ORG },
        });
      }
      if (tableName === "integrations-table") {
        const values = input.ExpressionAttributeValues as Record<
          string,
          string
        >;
        return Promise.resolve({
          Items: [{ integrationId: values[":id"], orgId: ORG }],
        });
      }
      return Promise.resolve({});
    });
  });

  test("returns scoped credentials for an agent with model permissions", async () => {
    const result = await handler({
      agentId: "agent-1",
      org: ORG,
      requiredPermissions: { models: ["anthropic.claude-sonnet-4-20250514"] },
    });

    expect(result.credentials).toBeDefined();
    expect(result.credentials!.accessKeyId).toBe("AKIA_SCOPED");

    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    expect(mockEnsureRole.mock.calls[0][0]).toBe("agent-1");
    expect(mockEnsureRole.mock.calls[0][3]).toBe("agent");

    const policies = mockEnsureRole.mock.calls[0][1];
    expect(policies[0].actions).toContain("bedrock:InvokeModel");
  });

  test("returns scoped credentials with datastore and integration access", async () => {
    const result = await handler({
      agentId: "agent-2",
      org: ORG,
      requiredPermissions: {
        models: ["anthropic.claude-sonnet-4-20250514"],
        dataStores: ["ds-abc"],
        integrations: ["int-xyz"],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.credentials).not.toBeNull();
    expect(mockGetAccountContext).toHaveBeenCalledTimes(1);
    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    const policies = mockEnsureRole.mock.calls[0][1];
    expect(policies).toHaveLength(3);
  });

  test("returns null credentials when no permissions declared", async () => {
    const result = await handler({
      agentId: "agent-3",
      org: ORG,
      requiredPermissions: {},
    });
    expect(result.credentials).toBeNull();
    expect(mockEnsureRole).not.toHaveBeenCalled();
  });

  test("returns null credentials when requiredPermissions is missing", async () => {
    const result = await handler({ agentId: "agent-4", org: ORG });
    expect(result.credentials).toBeNull();
  });

  test("returns error when PolicyManager fails", async () => {
    mockEnsureRole.mockRejectedValueOnce(new Error("IAM failure"));

    const result = await handler({
      agentId: "agent-5",
      org: ORG,
      requiredPermissions: { models: ["anthropic.claude-sonnet-4-20250514"] },
    });

    expect(result.error).toContain("IAM failure");
    expect(result.credentials).toBeNull();
  });
});
