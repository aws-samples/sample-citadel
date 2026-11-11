/**
 * CIT-294/H16: PUBLISHED lifecycle guard tests.
 *
 * Before this fix, `input.status !== "PUBLISHED"` on the validated-transition
 * gate exempted PUBLISHED from ALL lifecycle validation — any status could
 * transition to PUBLISHED without a check. The fix adds an explicit guard:
 * only APPROVED → PUBLISHED is valid.
 */
process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AUTHORITY_UNITS_TABLE = "test-authority-units";
process.env.AWS_REGION = "us-east-1";
delete process.env.MODEL_CATALOG_TABLE;

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  seedMockRegistry,
  resetMockRegistry,
  getUpdateResourceCallCount,
  getUpdateResourceStatusCallCount,
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
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
    TypeMismatchError: actual.TypeMismatchError,
    RegistryLifecycleError: actual.RegistryLifecycleError,
    decideRecord: actual.decideRecord,
    DECISION_STATUSES: actual.DECISION_STATUSES,
  };
});

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

jest.mock("../../utils/appsync-publish", () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from "../registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  sub = "user-123",
) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub, "custom:organization": "org-1" } },
  } as unknown as HandlerEvent;
}

function seedApp(status: string, orgId = "org-1"): void {
  seedMockRegistry("agent", "app-1", {
    name: "Test App",
    description: "Test",
    status,
    customDescriptorContent: JSON.stringify({
      appId: "app-1",
      manifest: {
        orgId,
        version: 1,
        status,
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        createdBy: "user-123",
        access: {},
        routingConfig: null,
      },
    }),
  });
}

beforeEach(() => {
  resetMockRegistry();
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({});
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
  ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
});

describe("CIT-294/H16: PUBLISHED lifecycle guard", () => {
  test("allows APPROVED → PUBLISHED", async () => {
    seedApp("APPROVED");
    const result = await invokeHandler(
      makeEvent("updateApp", {
        input: { appId: "app-1", status: "PUBLISHED" },
      }),
    );
    expect(result).toBeDefined();
  });

  test("rejects DRAFT → PUBLISHED with INVALID_TRANSITION", async () => {
    seedApp("DRAFT");
    await expect(
      invokeHandler(
        makeEvent("updateApp", {
          input: { appId: "app-1", status: "PUBLISHED" },
        }),
      ),
    ).rejects.toThrow(/PUBLISHED is only valid from APPROVED/);
  });

  test("rejects PENDING_APPROVAL → PUBLISHED", async () => {
    seedApp("PENDING_APPROVAL");
    await expect(
      invokeHandler(
        makeEvent("updateApp", {
          input: { appId: "app-1", status: "PUBLISHED" },
        }),
      ),
    ).rejects.toThrow(/PUBLISHED is only valid from APPROVED/);
  });

  test("rejects REJECTED → PUBLISHED", async () => {
    seedApp("REJECTED");
    await expect(
      invokeHandler(
        makeEvent("updateApp", {
          input: { appId: "app-1", status: "PUBLISHED" },
        }),
      ),
    ).rejects.toThrow(/PUBLISHED is only valid from APPROVED/);
  });

  test("rejects DEPRECATED → PUBLISHED", async () => {
    seedApp("DEPRECATED");
    await expect(
      invokeHandler(
        makeEvent("updateApp", {
          input: { appId: "app-1", status: "PUBLISHED" },
        }),
      ),
    ).rejects.toThrow(/PUBLISHED is only valid from APPROVED/);
  });

  test("forbidden transitions produce zero Registry writes", async () => {
    seedApp("DRAFT");
    await expect(
      invokeHandler(
        makeEvent("updateApp", {
          input: { appId: "app-1", status: "PUBLISHED" },
        }),
      ),
    ).rejects.toThrow();
    expect(getUpdateResourceCallCount()).toBe(0);
    expect(getUpdateResourceStatusCallCount()).toBe(0);
  });
});
