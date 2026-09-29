/**
 * Tests for the record-approval dispatch gate wired into updateAgentBinding's
 * READY (attach) transition: both the registry-resolved path (targetAgent)
 * and the legacy-catalog fallback path (getLegacyAgentRow) must be approved
 * before the binding write proceeds. Strict mode throws before any bind
 * write; shadow mode warns and proceeds.
 *
 * The registry-resolved-path cases use status=PENDING_APPROVAL rather than
 * DRAFT: PENDING_APPROVAL maps to the internal "active" state via
 * toInternalState (so the pre-existing activation gate passes), while its
 * raw status is still not APPROVED — isolating the new approval gate's
 * behavior from the pre-existing activation gate above it.
 *
 * Synthetic ids only.
 */

process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AUTHORITY_UNITS_TABLE = "test-authority-units";
process.env.APPSYNC_ENDPOINT =
  "https://test-api.appsync-api.us-east-1.amazonaws.com/graphql";
process.env.AWS_REGION = "us-east-1";
process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const resolveRecordIdMock = jest.fn();
const getResourceMock = jest.fn();
const updateResourceMock = jest.fn();
const mockGetGovernanceEnforce = jest.fn();

jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  const { getMockRegistryService } = jest.requireActual(
    "./fixtures/registry-service-mock",
  );
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => {
      const base = getMockRegistryService();
      return {
        ...base,
        resolveRecordId: (...args: unknown[]) => resolveRecordIdMock(...args),
        getResource: (...args: unknown[]) => getResourceMock(...args),
        updateResource: (...args: unknown[]) => updateResourceMock(...args),
      };
    }),
    isRegistryEnabled: jest.fn(() => true),
  };
});

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

jest.mock("../../utils/appsync-publish", () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../utils/governance-flag", () => ({
  __esModule: true,
  getGovernanceEnforce: mockGetGovernanceEnforce,
}));

jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("test-correlation-id"),
}));

import { updateAgentBinding } from "../registry-agent-record-resolver";
import {
  seedMockRegistry,
  resetMockRegistry,
} from "./fixtures/registry-service-mock";

const APP_RECORD_ID = "app000000002";
const AGENT_RECORD_ID = "agt000000002";
const LEGACY_AGENT_NAME = "legacy_attach_agent";

function seedAppWithBinding(agentId: string) {
  seedMockRegistry("agent", APP_RECORD_ID, {
    name: "Test App",
    description: "Test",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      appId: APP_RECORD_ID,
      manifest: {
        orgId: "org-1",
        createdBy: "user-123",
        version: 1,
        status: "DRAFT",
        workflowIds: [],
        agentBindings: [
          { agentId, status: "DESIGN", addedAt: "2026-01-01T00:00:00Z" },
        ],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        routingConfig: null,
      },
    }),
  });
}

function makeEvent(args: Record<string, unknown>) {
  return {
    info: { fieldName: "updateAgentBinding" },
    arguments: args,
    identity: {
      sub: "user-123",
      claims: { sub: "user-123", "custom:organization": "org-1" },
    },
  };
}

describe("updateAgentBinding — record-approval dispatch gate (registry-resolved path)", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    resolveRecordIdMock.mockReset();
    getResourceMock.mockReset();
    updateResourceMock.mockReset();
    mockGetGovernanceEnforce.mockReset();
    updateResourceMock.mockImplementation(
      async (
        _type: unknown,
        id: unknown,
        input: { customMetadata?: string },
      ) => ({
        recordId: id,
        name: "Test App",
        status: "DRAFT",
        customDescriptorContent: input.customMetadata,
      }),
    );
    seedAppWithBinding(AGENT_RECORD_ID);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("strict + PENDING_APPROVAL registry record throws, no bind write", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    resolveRecordIdMock.mockResolvedValue(AGENT_RECORD_ID);
    getResourceMock.mockImplementation(async (type: string, id: string) => {
      if (id === APP_RECORD_ID) {
        return {
          recordId: APP_RECORD_ID,
          name: "Test App",
          status: "DRAFT",
          customDescriptorContent: JSON.stringify({
            appId: APP_RECORD_ID,
            manifest: {
              orgId: "org-1",
              createdBy: "user-123",
              agentBindings: [{ agentId: AGENT_RECORD_ID, status: "DESIGN" }],
            },
          }),
        };
      }
      return {
        recordId: AGENT_RECORD_ID,
        name: "agent",
        status: "PENDING_APPROVAL",
      };
    });

    await expect(
      updateAgentBinding(
        { appId: APP_RECORD_ID, agentId: AGENT_RECORD_ID, status: "READY" },
        "user-123",
        makeEvent({
          appId: APP_RECORD_ID,
          agentId: AGENT_RECORD_ID,
          status: "READY",
        }),
      ),
    ).rejects.toThrow("approval_absent:PENDING_APPROVAL");

    expect(updateResourceMock).not.toHaveBeenCalled();
  });

  test("shadow + PENDING_APPROVAL registry record proceeds and warns", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("shadow");
    resolveRecordIdMock.mockResolvedValue(AGENT_RECORD_ID);
    getResourceMock.mockImplementation(async (type: string, id: string) => {
      if (id === APP_RECORD_ID) {
        return {
          recordId: APP_RECORD_ID,
          name: "Test App",
          status: "DRAFT",
          customDescriptorContent: JSON.stringify({
            appId: APP_RECORD_ID,
            manifest: {
              orgId: "org-1",
              createdBy: "user-123",
              agentBindings: [{ agentId: AGENT_RECORD_ID, status: "DESIGN" }],
            },
          }),
        };
      }
      return {
        recordId: AGENT_RECORD_ID,
        name: "agent",
        status: "PENDING_APPROVAL",
      };
    });
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const result = await updateAgentBinding(
      { appId: APP_RECORD_ID, agentId: AGENT_RECORD_ID, status: "READY" },
      "user-123",
      makeEvent({
        appId: APP_RECORD_ID,
        agentId: AGENT_RECORD_ID,
        status: "READY",
      }),
    );

    expect(result).toBeDefined();
    expect(updateResourceMock).toHaveBeenCalledTimes(1);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("would_block"),
      ),
    ).toBe(true);
  });

  test("APPROVED registry record proceeds in strict mode without warning", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    resolveRecordIdMock.mockResolvedValue(AGENT_RECORD_ID);
    getResourceMock.mockImplementation(async (type: string, id: string) => {
      if (id === APP_RECORD_ID) {
        return {
          recordId: APP_RECORD_ID,
          name: "Test App",
          status: "DRAFT",
          customDescriptorContent: JSON.stringify({
            appId: APP_RECORD_ID,
            manifest: {
              orgId: "org-1",
              createdBy: "user-123",
              agentBindings: [{ agentId: AGENT_RECORD_ID, status: "DESIGN" }],
            },
          }),
        };
      }
      return { recordId: AGENT_RECORD_ID, name: "agent", status: "APPROVED" };
    });
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const result = await updateAgentBinding(
      { appId: APP_RECORD_ID, agentId: AGENT_RECORD_ID, status: "READY" },
      "user-123",
      makeEvent({
        appId: APP_RECORD_ID,
        agentId: AGENT_RECORD_ID,
        status: "READY",
      }),
    );

    expect(result).toBeDefined();
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("would_block"),
      ),
    ).toBe(false);
  });
});

describe("updateAgentBinding — record-approval dispatch gate (legacy-catalog fallback path)", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    resolveRecordIdMock.mockReset();
    getResourceMock.mockReset();
    updateResourceMock.mockReset();
    mockGetGovernanceEnforce.mockReset();
    updateResourceMock.mockImplementation(
      async (
        _type: unknown,
        id: unknown,
        input: { customMetadata?: string },
      ) => ({
        recordId: id,
        name: "Test App",
        status: "DRAFT",
        customDescriptorContent: input.customMetadata,
      }),
    );
    seedAppWithBinding(LEGACY_AGENT_NAME);
    resolveRecordIdMock.mockRejectedValue(new Error("not found"));
    getResourceMock.mockImplementation(async (_type: string, _id: string) => ({
      recordId: APP_RECORD_ID,
      name: "Test App",
      status: "DRAFT",
      customDescriptorContent: JSON.stringify({
        appId: APP_RECORD_ID,
        manifest: {
          orgId: "org-1",
          createdBy: "user-123",
          agentBindings: [{ agentId: LEGACY_AGENT_NAME, status: "DESIGN" }],
        },
      }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("strict + legacy row missing registryStatus throws approval_absent_missing_status, no bind write", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    ddbMock.on(GetCommand).resolves({
      Item: { agentId: LEGACY_AGENT_NAME, state: "active" },
    });

    await expect(
      updateAgentBinding(
        { appId: APP_RECORD_ID, agentId: LEGACY_AGENT_NAME, status: "READY" },
        "user-123",
        makeEvent({
          appId: APP_RECORD_ID,
          agentId: LEGACY_AGENT_NAME,
          status: "READY",
        }),
      ),
    ).rejects.toThrow("approval_absent_missing_status");

    expect(updateResourceMock).not.toHaveBeenCalled();
  });

  test("strict + legacy row registryStatus=APPROVED proceeds", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("strict");
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: LEGACY_AGENT_NAME,
        state: "active",
        registryStatus: "APPROVED",
      },
    });

    const result = await updateAgentBinding(
      { appId: APP_RECORD_ID, agentId: LEGACY_AGENT_NAME, status: "READY" },
      "user-123",
      makeEvent({
        appId: APP_RECORD_ID,
        agentId: LEGACY_AGENT_NAME,
        status: "READY",
      }),
    );

    expect(result).toBeDefined();
    expect(updateResourceMock).toHaveBeenCalledTimes(1);
  });

  test("shadow + legacy row registryStatus=DRAFT proceeds and warns", async () => {
    mockGetGovernanceEnforce.mockResolvedValue("shadow");
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: LEGACY_AGENT_NAME,
        state: "active",
        registryStatus: "DRAFT",
      },
    });
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const result = await updateAgentBinding(
      { appId: APP_RECORD_ID, agentId: LEGACY_AGENT_NAME, status: "READY" },
      "user-123",
      makeEvent({
        appId: APP_RECORD_ID,
        agentId: LEGACY_AGENT_NAME,
        status: "READY",
      }),
    );

    expect(result).toBeDefined();
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("would_block"),
      ),
    ).toBe(true);
  });
});
