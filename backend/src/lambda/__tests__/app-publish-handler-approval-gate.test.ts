/**
 * Tests for the record-approval dispatch gate wired into publishApp
 * (app-publish-handler.ts, step 3b): every bound agent's Registry record
 * must be APPROVED before the app can publish. Strict mode throws before
 * any provisioning/status write; shadow mode warns and proceeds.
 *
 * Synthetic ids only.
 */
process.env.REGISTRY_ID = "test-registry-id";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";

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

const mockGetGovernanceEnforce = jest.fn();
jest.mock("../../utils/governance-flag", () => ({
  __esModule: true,
  getGovernanceEnforce: mockGetGovernanceEnforce,
}));

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
  GetCommand,
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
import { publishApp, AppMetadata } from "../app-publish-handler";
import { PolicyManager } from "../../utils/policy-manager";
import * as apiKeyHash from "../../utils/api-key-hash";

const PUBLISH_OWNER_ID = "user-1";
const PUBLISH_APP_ORG = "org-1";

const OWNER_EVENT = {
  identity: {
    sub: PUBLISH_OWNER_ID,
    claims: { sub: PUBLISH_OWNER_ID, "custom:organization": PUBLISH_APP_ORG },
  },
};

function seedOwnerApp(appId: string = "app-1") {
  seedMockRegistry("agent", appId, {
    name: "Test App",
    status: "ACTIVE",
    customDescriptorContent: JSON.stringify({
      appId,
      manifest: {
        orgId: PUBLISH_APP_ORG,
        createdBy: PUBLISH_OWNER_ID,
        access: {},
      },
    }),
  });
}

function makeMetadata(overrides: Partial<AppMetadata> = {}): AppMetadata {
  return {
    appId: "app-1",
    name: "Test App",
    status: "ACTIVE",
    workflowIds: ["wf-1"],
    orgId: "org-1",
    sortId: "METADATA",
    groupId: "APP#app-1",
    version: 1,
    ...overrides,
  };
}

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

describe("publishApp: record-approval dispatch gate", () => {
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

  function seedAgentRecord(agentId: string, status: string) {
    seedMockRegistry("agent", agentId, { name: agentId, status });
  }

  test("strict + DRAFT bound-agent record throws, no publish write", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    seedAgentRecord("agent-draft-1", "DRAFT");

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-draft-1",
          agentId: "agent-draft-1",
          status: "READY",
        },
        {
          sortId: "CONFIG#values",
          values: { adminEmail: "admin@example.com" },
        },
      ],
    });

    await expect(
      publishApp("app-1", "user-1", OWNER_EVENT, defaultDeps),
    ).rejects.toThrow("approval_absent:DRAFT");

    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("shadow + DRAFT bound-agent record proceeds and warns", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("shadow");
    seedAgentRecord("agent-draft-2", "DRAFT");
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-draft-2",
          agentId: "agent-draft-2",
          status: "READY",
        },
        {
          sortId: "CONFIG#values",
          values: { adminEmail: "admin@example.com" },
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(
      "app-1",
      "user-1",
      OWNER_EVENT,
      defaultDeps,
    );

    expect(result.app.status).toBe("PUBLISHED");
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("would_block"),
      ),
    ).toBe(true);
  });

  test("APPROVED bound-agent record proceeds in strict mode without warning", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    seedAgentRecord("agent-approved-1", "APPROVED");
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-approved-1",
          agentId: "agent-approved-1",
          status: "READY",
        },
        {
          sortId: "CONFIG#values",
          values: { adminEmail: "admin@example.com" },
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(
      "app-1",
      "user-1",
      OWNER_EVENT,
      defaultDeps,
    );

    expect(result.app.status).toBe("PUBLISHED");
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("would_block"),
      ),
    ).toBe(false);
  });

  test("legacy agent (no Registry record) falls back to AGENT_CONFIG_TABLE registryStatus, strict + DRAFT throws", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    // No seedAgentRecord call: "agent-legacy-1" has no Registry record, so
    // getResource resolves null and the loop must fall back to the legacy
    // cache row instead of skipping (verify feedback, loop 1).
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-legacy-1",
          agentId: "agent-legacy-1",
          status: "READY",
        },
        {
          sortId: "CONFIG#values",
          values: { adminEmail: "admin@example.com" },
        },
      ],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "agent-legacy-1",
        state: "active",
        registryStatus: "DRAFT",
      },
    });

    await expect(
      publishApp("app-1", "user-1", OWNER_EVENT, defaultDeps),
    ).rejects.toThrow("approval_absent:DRAFT");

    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("legacy agent with no AGENT_CONFIG_TABLE row is skipped (not found anywhere), publish proceeds", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeMetadata({ workflowIds: [] }),
        {
          sortId: "AGENT#agent-ghost-1",
          agentId: "agent-ghost-1",
          status: "READY",
        },
        {
          sortId: "CONFIG#values",
          values: { adminEmail: "admin@example.com" },
        },
      ],
    });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(
      "app-1",
      "user-1",
      OWNER_EVENT,
      defaultDeps,
    );

    expect(result.app.status).toBe("PUBLISHED");
  });
});
