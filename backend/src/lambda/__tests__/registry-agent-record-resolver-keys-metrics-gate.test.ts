/**
 * Coverage for the finding-13ffaca1 / board task a6ff10ff (ITEM2) fix:
 * listAppApiKeys and getAppMetrics previously took no `event` at all and
 * delegated straight to their DDB-backed impls with zero tenant check —
 * any authenticated caller could read any app's key metadata or metrics
 * cross-org. Both now thread `event`, fetch the Registry record, and call
 * `assertManifestAccess(appId, record, event, "viewer")` before delegating.
 */
process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "test-apps";
process.env.WORKFLOWS_TABLE = "test-workflows";
process.env.AGENT_CONFIG_TABLE = "test-agents";
process.env.EVENT_BUS_NAME = "test-bus";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AUTHORITY_UNITS_TABLE = "test-authority-units";

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);

import {
  resetMockRegistry,
  seedMockRegistry,
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
  };
});

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn(
    (identity: { sub?: string }) => identity?.sub ?? "anonymous",
  ),
}));

const mockList = jest.fn();
jest.mock("../app-api-key-management", () => ({
  createAppApiKey: jest.fn(),
  revokeAppApiKey: jest.fn(),
  rotateAppApiKey: jest.fn(),
  listAppApiKeys: (...args: unknown[]) => mockList(...args),
}));

const mockGetAppMetrics = jest.fn();
jest.mock("../app-metrics-handler", () => ({
  getAppMetrics: (...args: unknown[]) => mockGetAppMetrics(...args),
}));

import { handler } from "../registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  sub = "user-1",
  orgId = "org-1",
) {
  return {
    info: { fieldName, parentTypeName: "Query", selectionSetList: [] },
    arguments: args,
    identity: {
      sub,
      claims: { sub, "custom:organization": orgId },
    },
    source: null,
    request: { headers: {} },
    prev: null,
    stash: {},
  } as unknown as HandlerEvent;
}

function seedApp(appId: string, orgId: string, createdBy = "user-123") {
  seedMockRegistry("agent", appId, {
    name: "Test App",
    description: "Test",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      appId,
      manifest: {
        orgId,
        version: 1,
        status: "DRAFT",
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        createdBy,
        access: {},
        routingConfig: null,
      },
    }),
  });
}

describe("registry-agent-record-resolver — listAppApiKeys / getAppMetrics viewer gate", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    mockList.mockReset();
    mockGetAppMetrics.mockReset();
  });

  describe("listAppApiKeys", () => {
    test("same-org viewer is allowed and reaches the impl", async () => {
      seedApp("app-1", "org-1", "user-1");
      mockList.mockResolvedValueOnce([]);

      await invokeHandler(makeEvent("listAppApiKeys", { appId: "app-1" }));

      expect(mockList).toHaveBeenCalledTimes(1);
    });

    test("cross-org caller is denied and the impl is never called", async () => {
      seedApp("app-1", "org-1", "user-123");

      await expect(
        invokeHandler(
          makeEvent("listAppApiKeys", { appId: "app-1" }, "user-2", "org-2"),
        ),
      ).rejects.toThrow(/Access denied/);

      expect(mockList).not.toHaveBeenCalled();
    });

    test("throws 'App not found' when the registry record does not exist", async () => {
      await expect(
        invokeHandler(makeEvent("listAppApiKeys", { appId: "missing-app" })),
      ).rejects.toThrow(/not found/i);
      expect(mockList).not.toHaveBeenCalled();
    });
  });

  describe("getAppMetrics", () => {
    test("same-org viewer is allowed and reaches the impl", async () => {
      seedApp("app-2", "org-1", "user-1");
      mockGetAppMetrics.mockResolvedValueOnce({ requestCount: 0 });

      await invokeHandler(
        makeEvent("getAppMetrics", {
          appId: "app-2",
          startTime: "2025-01-01T00:00:00Z",
          endTime: "2025-01-02T00:00:00Z",
        }),
      );

      expect(mockGetAppMetrics).toHaveBeenCalledTimes(1);
    });

    test("cross-org caller is denied and the impl is never called", async () => {
      seedApp("app-2", "org-1", "user-123");

      await expect(
        invokeHandler(
          makeEvent(
            "getAppMetrics",
            {
              appId: "app-2",
              startTime: "2025-01-01T00:00:00Z",
              endTime: "2025-01-02T00:00:00Z",
            },
            "user-2",
            "org-2",
          ),
        ),
      ).rejects.toThrow(/Access denied/);

      expect(mockGetAppMetrics).not.toHaveBeenCalled();
    });

    test("throws 'App not found' when the registry record does not exist", async () => {
      await expect(
        invokeHandler(
          makeEvent("getAppMetrics", {
            appId: "missing-app",
            startTime: "2025-01-01T00:00:00Z",
            endTime: "2025-01-02T00:00:00Z",
          }),
        ),
      ).rejects.toThrow(/not found/i);
      expect(mockGetAppMetrics).not.toHaveBeenCalled();
    });
  });
});
