/**
 * CIT-042 PR2: tag-policy enforcement at publish time
 * (app-publish-handler.ts, step 3c).
 *
 * Each bound agent's tags (from customDescriptorContent) are validated
 * against the org's tag policy. strict → TAG_POLICY_VIOLATION before any
 * provisioning/write; shadow → proceeds with warn; no policy → proceeds.
 */
process.env.REGISTRY_ID = "test-registry-id";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";

// ── mocks: RegistryService ─────────────────────────────────────────────
jest.mock("../../services/registry-service", () => {
  const { getMockRegistryService } = jest.requireActual(
    "./fixtures/registry-service-mock",
  );
  const actual = jest.requireActual("../../services/registry-service");
  return {
    RegistryService: jest
      .fn()
      .mockImplementation(() => getMockRegistryService()),
    TypeMismatchError: actual.TypeMismatchError,
    RegistryLifecycleError: actual.RegistryLifecycleError,
  };
});

// ── mocks: governance-flag ─────────────────────────────────────────────
const mockGetGovernanceEnforce = jest.fn();
jest.mock("../../utils/governance-flag", () => ({
  __esModule: true,
  getGovernanceEnforce: mockGetGovernanceEnforce,
}));

// ── mocks: tag-policy-check ────────────────────────────────────────────
const mockEnforceTagPolicy = jest.fn();

class TagPolicyViolationError extends Error {
  readonly code = "TAG_POLICY_VIOLATION" as const;
  constructor(
    public readonly violations: Array<{ type: string; key: string }>,
    public readonly action: string,
    public readonly orgId: string,
  ) {
    super(
      `tag_policy_violation: missing required keys: ${violations.map((v) => v.key).join(", ")}`,
    );
    this.name = "TagPolicyViolationError";
  }
}

jest.mock("../tag-policy-check", () => ({
  __esModule: true,
  enforceTagPolicy: mockEnforceTagPolicy,
  TagPolicyViolationError,
}));

// ── mocks: AWS SDK ─────────────────────────────────────────────────────
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateAuthorizerCommand,
} from "@aws-sdk/client-apigatewayv2";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  seedMockRegistry,
  resetMockRegistry,
} from "./fixtures/registry-service-mock";
import { publishApp, type AppMetadata } from "../app-publish-handler";
import { PolicyManager } from "../../utils/policy-manager";
import * as apiKeyHash from "../../utils/api-key-hash";

// ── constants ──────────────────────────────────────────────────────────
const OWNER_ID = "user-1";
const APP_ORG = "org-1";

const OWNER_EVENT = {
  identity: {
    sub: OWNER_ID,
    claims: { sub: OWNER_ID, "custom:organization": APP_ORG },
  },
};

function seedOwnerApp(appId = "app-1") {
  seedMockRegistry("agent", appId, {
    name: "Test App",
    status: "ACTIVE",
    customDescriptorContent: JSON.stringify({
      appId,
      manifest: {
        orgId: APP_ORG,
        createdBy: OWNER_ID,
        access: {},
      },
    }),
  });
}

function seedAgentWithTags(
  agentId: string,
  tags: Record<string, string>,
  status = "APPROVED",
) {
  seedMockRegistry("agent", agentId, {
    name: agentId,
    status,
    customDescriptorContent: JSON.stringify({
      orgId: APP_ORG,
      tags,
    }),
  });
}

function seedAgentWithoutTags(agentId: string, status = "APPROVED") {
  seedMockRegistry("agent", agentId, {
    name: agentId,
    status,
    customDescriptorContent: JSON.stringify({
      orgId: APP_ORG,
    }),
  });
}

function makeMetadata(overrides: Partial<AppMetadata> = {}): AppMetadata {
  return {
    appId: "app-1",
    name: "Test App",
    status: "ACTIVE",
    workflowIds: ["wf-1"],
    orgId: APP_ORG,
    sortId: "METADATA",
    groupId: "APP#app-1",
    version: 1,
    ...overrides,
  } as AppMetadata;
}

// ── SDK mocks ──────────────────────────────────────────────────────────
const apiGwMock = mockClient(ApiGatewayV2Client);
const cwLogsMock = mockClient(CloudWatchLogsClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const stsMock = mockClient(STSClient);
const iamMock = mockClient(IAMClient);

const TEST_PEPPER = "e".repeat(64);

function setupDefaultMocks() {
  apiGwMock.reset();
  cwLogsMock.reset();
  ddbMock.reset();
  ebMock.reset();
  stsMock.reset();
  iamMock.reset();

  apiGwMock.on(CreateApiCommand).resolves({
    ApiId: "api-123",
    ApiEndpoint: "https://api-123.execute-api.us-east-1.amazonaws.com",
  });
  apiGwMock.on(CreateStageCommand).resolves({});
  apiGwMock.on(CreateIntegrationCommand).resolves({ IntegrationId: "int-456" });
  apiGwMock.on(CreateAuthorizerCommand).resolves({ AuthorizerId: "auth-789" });
  apiGwMock.on(CreateRouteCommand).resolves({});

  cwLogsMock.on(CreateLogGroupCommand).resolves({});
  cwLogsMock.on(DescribeLogGroupsCommand).resolves({
    logGroups: [
      {
        logGroupName: "/aws/apigateway/citadel-app-app-1-dev",
        arn: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigateway/citadel-app-app-1-dev:*",
      },
    ],
  });

  ebMock.on(PutEventsCommand).resolves({});
  stsMock.on(GetCallerIdentityCommand).resolves({
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/test-role/session",
  });
  iamMock.on(CreateRoleCommand).resolves({});
  iamMock.on(PutRolePolicyCommand).resolves({});
}

// ── describe ───────────────────────────────────────────────────────────
describe("publishApp: tag-policy enforcement (step 3c)", () => {
  const mockPolicyManager = {
    getAccountContext: jest
      .fn()
      .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
    ensureRole: jest.fn().mockResolvedValue(undefined),
    deleteRole: jest.fn().mockResolvedValue(undefined),
  } as unknown as PolicyManager;

  let defaultDeps: Parameters<typeof publishApp>[3];

  beforeEach(() => {
    setupDefaultMocks();
    resetMockRegistry();
    seedOwnerApp();
    mockGetGovernanceEnforce.mockReset();
    mockEnforceTagPolicy.mockReset();
    jest.spyOn(apiKeyHash, "getApiKeyPepper").mockResolvedValue(TEST_PEPPER);
    defaultDeps = {
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      apiGwClient: new ApiGatewayV2Client({}),
      eventBridgeClient: new EventBridgeClient({}),
      policyManager: mockPolicyManager,
      appsTable: "citadel-apps-test",
      eventBusName: "citadel-agents-test",
      environment: "dev",
      authorizerFnArn: "arn:aws:lambda:us-east-1:123:function:auth",
      region: "us-east-1",
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("strict + bound agent with policy-violating tags → TAG_POLICY_VIOLATION, no publish", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    seedAgentWithTags("agent-tagged-1", { team: "platform" });
    mockEnforceTagPolicy.mockRejectedValueOnce(
      new TagPolicyViolationError(
        [{ type: "MISSING_KEY", key: "env" }],
        "publish",
        APP_ORG,
      ),
    );

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-tagged-1",
          agentId: "agent-tagged-1",
          status: "READY",
        },
      ],
    });

    await expect(
      publishApp("app-1", OWNER_ID, OWNER_EVENT, defaultDeps),
    ).rejects.toThrow(TagPolicyViolationError);

    expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: APP_ORG,
        action: "publish",
        tags: { team: "platform" },
        subjectId: "agent-tagged-1",
      }),
    );

    // No API Gateway provisioning or DDB writes
    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("shadow + bound agent with violating tags → proceeds with warn", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("shadow");
    seedAgentWithTags("agent-tagged-2", { team: "platform" });
    mockEnforceTagPolicy.mockResolvedValueOnce({
      ok: false,
      violations: [{ type: "MISSING_KEY", key: "env" }],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-tagged-2",
          agentId: "agent-tagged-2",
          status: "READY",
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(
      "app-1",
      OWNER_ID,
      OWNER_EVENT,
      defaultDeps,
    );

    expect(mockEnforceTagPolicy).toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result.endpointUrl).toContain("api-123");
  });

  test("no policy → proceeds (enforcement returns ok:true)", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    seedAgentWithTags("agent-tagged-3", {
      env: "prod",
      team: "platform",
    });
    mockEnforceTagPolicy.mockResolvedValueOnce({
      ok: true,
      violations: [],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-tagged-3",
          agentId: "agent-tagged-3",
          status: "READY",
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(
      "app-1",
      OWNER_ID,
      OWNER_EVENT,
      defaultDeps,
    );

    expect(mockEnforceTagPolicy).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  test("bound agent with no tags → enforcement NOT called", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    seedAgentWithoutTags("agent-no-tags-1");

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-no-tags-1",
          agentId: "agent-no-tags-1",
          status: "READY",
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(
      "app-1",
      OWNER_ID,
      OWNER_EVENT,
      defaultDeps,
    );

    expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  test("multiple bound agents, one violates in strict → blocks before any write", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    seedAgentWithTags("agent-ok", { env: "prod", team: "platform" });
    seedAgentWithTags("agent-bad", { team: "platform" });

    // First agent passes
    mockEnforceTagPolicy.mockResolvedValueOnce({
      ok: true,
      violations: [],
    });
    // Second agent fails
    mockEnforceTagPolicy.mockRejectedValueOnce(
      new TagPolicyViolationError(
        [{ type: "MISSING_KEY", key: "env" }],
        "publish",
        APP_ORG,
      ),
    );

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: ["wf-1"] }),
        {
          sortId: "AGENT#agent-ok",
          agentId: "agent-ok",
          status: "READY",
        },
        {
          sortId: "AGENT#agent-bad",
          agentId: "agent-bad",
          status: "READY",
        },
      ],
    });

    await expect(
      publishApp("app-1", OWNER_ID, OWNER_EVENT, defaultDeps),
    ).rejects.toThrow(TagPolicyViolationError);

    expect(mockEnforceTagPolicy).toHaveBeenCalledTimes(2);
    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
  });
});
