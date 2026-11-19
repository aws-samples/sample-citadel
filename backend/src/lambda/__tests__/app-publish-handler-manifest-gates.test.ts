/**
 * Regression tests for finding 01a1ed59: app publish gates must evaluate
 * agent bindings from the registry manifest (the authoritative source of
 * truth), not from AppsTable AGENT# rows (which are never written by the
 * canonical mutation paths).
 *
 * Three cases:
 * 1. An app whose manifest has zero agent bindings cannot publish (fail-closed).
 * 2. An app whose manifest agent fails a gate (status != READY) blocks publish.
 * 3. An app whose manifest agents are all READY publishes successfully.
 */
process.env.REGISTRY_ID = "test-registry-id";

import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateAuthorizerCommand,
  DeleteApiCommand,
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
import { mockClient } from "aws-sdk-client-mock";

import {
  seedMockRegistry,
  resetMockRegistry,
} from "./fixtures/registry-service-mock";

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

import {
  validatePublishPreconditions,
  publishApp,
  AppMetadata,
  ComponentItem,
} from "../app-publish-handler";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PolicyManager } from "../../utils/policy-manager";
import * as apiKeyHash from "../../utils/api-key-hash";

// ── Owner-gate fixture ──────────────────────────────────────

const OWNER_ID = "user-manifest-test";
const APP_ORG = "org-manifest-test";

const OWNER_EVENT = {
  identity: {
    sub: OWNER_ID,
    claims: { sub: OWNER_ID, "custom:organization": APP_ORG },
  },
};

// ── Mocks ───────────────────────────────────────────────────

const apiGwMock = mockClient(ApiGatewayV2Client);
const cwLogsMock = mockClient(CloudWatchLogsClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const stsMock = mockClient(STSClient);
const iamMock = mockClient(IAMClient);

const TEST_PEPPER = "f".repeat(64);

beforeEach(() => {
  apiKeyHash.__resetApiKeyPepperCacheForTest();
  jest.spyOn(apiKeyHash, "getApiKeyPepper").mockResolvedValue(TEST_PEPPER);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────

function makeMetadata(overrides: Partial<AppMetadata> = {}): AppMetadata {
  return {
    appId: "app-manifest-1",
    name: "Manifest Test App",
    status: "ACTIVE",
    workflowIds: ["wf-1"],
    orgId: APP_ORG,
    sortId: "METADATA",
    groupId: "APP#app-manifest-1",
    version: 1,
    ...overrides,
  };
}

function seedRegistryApp(
  appId: string,
  manifestOverrides: Record<string, unknown> = {},
) {
  const manifest = {
    orgId: APP_ORG,
    createdBy: OWNER_ID,
    access: {},
    agentBindings: [],
    ...manifestOverrides,
  };
  seedMockRegistry("agent", appId, {
    name: "Manifest Test App",
    status: "ACTIVE",
    customDescriptorContent: JSON.stringify({ appId, manifest }),
  });
}

function setupDefaultMocks() {
  apiGwMock.reset();
  cwLogsMock.reset();
  ddbMock.reset();
  ebMock.reset();
  stsMock.reset();
  iamMock.reset();

  apiGwMock.on(CreateApiCommand).resolves({ ApiId: "api-manifest-test" });
  apiGwMock.on(CreateStageCommand).resolves({});
  apiGwMock.on(CreateIntegrationCommand).resolves({ IntegrationId: "int-1" });
  apiGwMock.on(CreateAuthorizerCommand).resolves({ AuthorizerId: "auth-1" });
  apiGwMock.on(CreateRouteCommand).resolves({});
  apiGwMock.on(DeleteApiCommand).resolves({});

  cwLogsMock.on(CreateLogGroupCommand).resolves({});
  cwLogsMock.on(DescribeLogGroupsCommand).resolves({
    logGroups: [
      {
        logGroupName: "/aws/apigateway/citadel-app-app-manifest-1-dev",
        arn: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigateway/citadel-app-app-manifest-1-dev:*",
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

const mockPolicyManager = {
  getAccountContext: jest
    .fn()
    .mockResolvedValue({ accountId: "123456789012", region: "us-east-1" }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  deleteRole: jest.fn().mockResolvedValue(undefined),
} as unknown as PolicyManager;

function makeDeps() {
  return {
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
}

// ── Unit: validatePublishPreconditions ──────────────────────

describe("validatePublishPreconditions — zero-agent fail-closed guard", () => {
  test("rejects publish when component items have zero agent bindings", () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toContainEqual(
      expect.stringContaining("At least one agent binding is required"),
    );
  });

  test("rejects publish when only config components exist (no agents)", () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      { sortId: "CONFIG#schema", schema: { type: "object" } },
      { sortId: "CONFIG#values", values: { foo: "bar" } },
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toContainEqual(
      expect.stringContaining("At least one agent binding is required"),
    );
  });

  test("passes when at least one READY agent binding exists", () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      { sortId: "AGENT#agent-1", agentId: "agent-1", status: "READY" },
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors.some((e) => e.includes("At least one agent binding"))).toBe(
      false,
    );
  });
});

// ── Integration: publishApp reads manifest from registry ────

describe("publishApp reads agent bindings from registry manifest", () => {
  const APP_ID = "app-manifest-1";

  beforeEach(() => {
    setupDefaultMocks();
    resetMockRegistry();
    (mockPolicyManager.getAccountContext as jest.Mock).mockClear();
    (mockPolicyManager.ensureRole as jest.Mock).mockClear();
  });

  test("blocks publish when manifest has zero agent bindings (vacuous-pass regression)", async () => {
    seedRegistryApp(APP_ID, { agentBindings: [] });

    // AppsTable returns METADATA only (no AGENT# rows) — this is the
    // real-world scenario for UI-created apps.
    ddbMock.on(QueryCommand).resolves({
      Items: [makeMetadata()],
    });

    await expect(
      publishApp(APP_ID, OWNER_ID, OWNER_EVENT, makeDeps()),
    ).rejects.toThrow("Publish preconditions not met");

    // No API Gateway provisioned
    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
  });

  test("blocks publish when a manifest agent has status DESIGN", async () => {
    seedRegistryApp(APP_ID, {
      agentBindings: [
        { agentId: "agent-a", status: "READY" },
        { agentId: "agent-b", status: "DESIGN" },
      ],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [makeMetadata()],
    });

    await expect(
      publishApp(APP_ID, OWNER_ID, OWNER_EVENT, makeDeps()),
    ).rejects.toThrow("Publish preconditions not met");
  });

  test("publishes successfully when manifest agents are all READY", async () => {
    // Seed a manifest with READY agents
    seedRegistryApp(APP_ID, {
      agentBindings: [
        { agentId: "agent-a", status: "READY" },
        { agentId: "agent-b", status: "READY" },
      ],
    });

    // Also seed the bound agent records so the approval gate resolves them
    seedMockRegistry("agent", "agent-a", {
      name: "Agent A",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: APP_ORG,
      }),
    });
    seedMockRegistry("agent", "agent-b", {
      name: "Agent B",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: APP_ORG,
      }),
    });

    // AppsTable: METADATA only (no AGENT# rows — real-world UI path)
    ddbMock.on(QueryCommand).resolves({
      Items: [makeMetadata({ workflowIds: ["wf-1"] })],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp(APP_ID, OWNER_ID, OWNER_EVENT, makeDeps());

    expect(result.app.status).toBe("PUBLISHED");
    expect(result.endpointUrl).toBeTruthy();
    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(1);
  });

  test("manifest agent bindings without explicit status default to DESIGN (fail-closed)", async () => {
    // A binding with no status field should not be treated as READY
    seedRegistryApp(APP_ID, {
      agentBindings: [{ agentId: "agent-no-status" }],
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [makeMetadata()],
    });

    await expect(
      publishApp(APP_ID, OWNER_ID, OWNER_EVENT, makeDeps()),
    ).rejects.toThrow("Publish preconditions not met");
  });
});
