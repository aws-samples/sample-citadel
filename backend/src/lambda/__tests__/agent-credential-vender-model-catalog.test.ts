/**
 * Tests for agent-credential-vender model-catalog integration.
 *
 * Verifies the vender reads MODEL_CATALOG_TABLE to compute inference-profile
 * ARNs and passes them as modelResources to computeAgentPolicies.
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
process.env.MODEL_CATALOG_TABLE = "model-catalog-table";

import { handler } from "../agent-credential-vender";

const ORG = "org-test";
const ACCOUNT_ID = "123456789012";
const REGION = "us-west-2";

describe("agent-credential-vender model-catalog integration", () => {
  beforeEach(() => {
    mockGetAccountContext.mockClear();
    mockEnsureRole.mockClear();
    mockAssumeScopedRole.mockClear();
    mockDynamoSend.mockClear();

    mockGetAccountContext.mockResolvedValue({
      accountId: ACCOUNT_ID,
      region: REGION,
    });
    mockEnsureRole.mockResolvedValue(undefined);
    mockAssumeScopedRole.mockResolvedValue({
      accessKeyId: "AKIA_SCOPED",
      secretAccessKey: "SECRET_SCOPED",
      sessionToken: "TOKEN_SCOPED",
    });
  });

  function setupDynamoMock(catalogEntry?: Record<string, unknown>): void {
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
      if (tableName === "model-catalog-table") {
        // The vender looks up by modelKey (derived from modelId)
        return Promise.resolve({ Item: catalogEntry });
      }
      return Promise.resolve({});
    });
  }

  test("uses inference-profile ARNs from model catalog when available", async () => {
    setupDynamoMock({
      modelKey: "anthropic_claude-sonnet-4-20250514-v1_0",
      baseModelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      regionProfiles: {
        us: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        eu: "eu.anthropic.claude-sonnet-4-20250514-v1:0",
      },
    });

    await handler({
      agentId: "agent-1",
      org: ORG,
      requiredPermissions: {
        models: ["anthropic.claude-sonnet-4-20250514-v1:0"],
      },
    });

    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    const policies = mockEnsureRole.mock.calls[0][1];
    const modelPolicy = policies.find((p: { actions: string[] }) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    // Should have foundation-model ARN + inference-profile ARNs
    expect(modelPolicy.resources).toContainEqual(
      `arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0`,
    );
    expect(modelPolicy.resources).toContainEqual(
      `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
    expect(modelPolicy.resources).toContainEqual(
      `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/eu.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
  });

  test("falls back to foundation-model ARN when catalog entry missing", async () => {
    setupDynamoMock(undefined); // no catalog entry

    await handler({
      agentId: "agent-2",
      org: ORG,
      requiredPermissions: {
        models: ["anthropic.claude-sonnet-4-20250514-v1:0"],
      },
    });

    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    const policies = mockEnsureRole.mock.calls[0][1];
    const modelPolicy = policies.find((p: { actions: string[] }) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    // Only foundation-model ARN (graceful degradation)
    expect(modelPolicy.resources).toEqual([
      `arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0`,
    ]);
  });

  test("falls back when MODEL_CATALOG_TABLE is unset", async () => {
    const savedTable = process.env.MODEL_CATALOG_TABLE;
    delete process.env.MODEL_CATALOG_TABLE;

    setupDynamoMock({
      modelKey: "anthropic_claude-sonnet-4-20250514-v1_0",
      baseModelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      regionProfiles: { us: "us.anthropic.claude-sonnet-4-20250514-v1:0" },
    });

    await handler({
      agentId: "agent-3",
      org: ORG,
      requiredPermissions: {
        models: ["anthropic.claude-sonnet-4-20250514-v1:0"],
      },
    });

    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    const policies = mockEnsureRole.mock.calls[0][1];
    const modelPolicy = policies.find((p: { actions: string[] }) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    // Foundation-model ARN only (catalog not consulted)
    expect(modelPolicy.resources).toEqual([
      `arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0`,
    ]);

    process.env.MODEL_CATALOG_TABLE = savedTable;
  });
});
