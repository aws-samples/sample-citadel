/**
 * Org-scoping regression tests for tool-config-resolver.ts (finding
 * 13065e38). Reads (getToolConfig/getToolConfigRegistry/list*) were already
 * org-filtered. updateToolConfig/deleteToolConfig (legacy DynamoDB path) and
 * updateToolConfigRegistry/deleteToolConfigRegistry (Registry path) took NO
 * event/identity at all and performed no org reconciliation whatsoever — any
 * authenticated caller of any org could rewrite or destroy another tenant's
 * tool config, including its integrationBindings/dataStoreBindings which
 * scope datastore/integration credentials.
 *
 * Fix: both paths now fetch-then-verify via the shared `assertRowOrg` gate
 * (backend/src/utils/auth-event.ts) BEFORE any DynamoDB PutCommand/
 * DeleteCommand or Registry updateResource/deleteResource call — mirroring
 * datastore-resolver.ts's updateDataStore/deleteDataStore remediation
 * (finding ca76d041).
 *
 * Acceptance (from the task): cross-org caller refused on update and delete
 * with ZERO DynamoDB writes/deletes recorded; same-org succeeds; fail closed
 * on absent identity, unresolvable org, missing row, row without orgId.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

import { handler, _resetRegistryService } from "../tool-config-resolver";
import { CrossOrgAccessError } from "../../utils/auth-event";

const mockCreateResource = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockDeleteResource = jest.fn();
const mockListResources = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSearchResources = jest.fn();
const mockSerializeCustomMetadata = jest.fn((meta: unknown) =>
  JSON.stringify(meta),
);
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null, defaults: Record<string, unknown>) => {
    if (!json) return defaults;
    try {
      return { ...defaults, ...JSON.parse(json) };
    } catch {
      return defaults;
    }
  },
);
const mockToRegistryStatus = jest.fn(() => "APPROVED");
const mockToInternalState = jest.fn(() => "active");
const mockMapToToolConfig = jest.fn((record: Record<string, unknown>) => {
  const meta = record.customDescriptorContent
    ? (() => {
        try {
          return JSON.parse(record.customDescriptorContent as string);
        } catch {
          return {};
        }
      })()
    : ({} as Record<string, unknown>);
  return {
    toolId: record.recordId,
    orgId: meta.orgId ?? "",
    config: record.description || "",
    state: "active",
    categories: [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => "test-registry",
    createResource: mockCreateResource,
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    deleteResource: mockDeleteResource,
    listResources: mockListResources,
    updateResourceStatus: mockUpdateResourceStatus,
    searchResources: mockSearchResources,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    toInternalState: mockToInternalState,
    mapToToolConfig: mockMapToToolConfig,
  })),
}));

const ORG_A = "org-a";
const ORG_B = "org-b";

const eventForOrg = (orgId: string | undefined, admin = false) => ({
  identity: {
    sub: "test-user",
    claims: {
      ...(orgId ? { "custom:organization": orgId } : {}),
      ...(admin ? { "custom:role": "admin", "cognito:groups": ["admin"] } : {}),
    },
  },
});

const makeEvent = (
  fieldName: string,
  args: Record<string, unknown>,
  identity?: Record<string, unknown>,
) => ({
  info: { fieldName },
  arguments: args,
  identity: identity ?? eventForOrg(ORG_A).identity,
});

describe("tool-config-resolver — org scoping (finding 13065e38)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, TOOLS_CONFIG_TABLE: "test-tools-config" };
    dynamoMock.reset();
    jest.clearAllMocks();
    _resetRegistryService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── Legacy DynamoDB path: updateToolConfig ──────────────────────────

  describe("updateToolConfig (legacy DynamoDB path)", () => {
    test("refuses a cross-org caller and performs ZERO DynamoDB writes", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: "t1",
          orgId: ORG_A,
          config: "{}",
          state: "active",
          createdAt: "2025-01-01",
        },
      });

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "t1", config: '{"evil":true}' } },
            eventForOrg(ORG_B).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("same-org caller succeeds", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: "t1",
          orgId: ORG_A,
          config: "{}",
          state: "active",
          createdAt: "2025-01-01",
        },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent(
          "updateToolConfig",
          { input: { toolId: "t1", config: '{"ok":true}' } },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(JSON.parse(result.config)).toEqual({ ok: true });
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    test("admin bypasses the org check", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: "t1",
          orgId: ORG_A,
          config: "{}",
          state: "active",
          createdAt: "2025-01-01",
        },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent(
          "updateToolConfig",
          { input: { toolId: "t1", config: '{"ok":true}' } },
          eventForOrg(ORG_B, true).identity,
        ),
      );

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(result.toolId).toBe("t1");
    });

    test("fails closed when caller has no resolvable org", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: "t1",
          orgId: ORG_A,
          config: "{}",
          state: "active",
          createdAt: "2025-01-01",
        },
      });

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "t1", config: "{}" } },
            { sub: "no-org-user" },
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("fails closed when the row has no orgId (legacy row)", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: "t1",
          config: "{}",
          state: "active",
          createdAt: "2025-01-01",
        },
      });

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "t1", config: "{}" } },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("still throws not-found for a missing row (org gate never reached)", async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "missing" } },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow("Tool config not found");
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // ─── Legacy DynamoDB path: deleteToolConfig ──────────────────────────

  describe("deleteToolConfig (legacy DynamoDB path)", () => {
    test("refuses a cross-org caller and performs ZERO DynamoDB deletes", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });

      await expect(
        handler(
          makeEvent(
            "deleteToolConfig",
            { toolId: "t1" },
            eventForOrg(ORG_B).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    test("same-org caller succeeds", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent(
          "deleteToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result.success).toBe(true);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    test("admin bypasses the org check", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent(
          "deleteToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_B, true).identity,
        ),
      );

      expect(result.success).toBe(true);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    test("fails closed when caller has no resolvable org", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });

      await expect(
        handler(
          makeEvent("deleteToolConfig", { toolId: "t1" }, { sub: "no-org" }),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    test("fails closed when the row has no orgId", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", config: "{}", state: "active" },
      });

      await expect(
        handler(
          makeEvent(
            "deleteToolConfig",
            { toolId: "t1" },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    test("fails closed when the row is missing", async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(
          makeEvent(
            "deleteToolConfig",
            { toolId: "missing" },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });

  // ─── Registry path: updateToolConfigRegistry ─────────────────────────

  describe("updateToolConfigRegistry (Registry path)", () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = "true";
      process.env.REGISTRY_ID = "test-registry";
    });

    test("refuses a cross-org caller and performs ZERO Registry/DynamoDB writes", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "t1", config: '{"evil":true}' } },
            eventForOrg(ORG_B).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);

      expect(mockUpdateResource).not.toHaveBeenCalled();
      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("same-org caller succeeds", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });
      mockUpdateResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
      });

      const result = await handler(
        makeEvent(
          "updateToolConfig",
          { input: { toolId: "t1", config: '{"ok":true}' } },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.toolId).toBe("t1");
    });

    test("admin bypasses the org check", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });
      mockUpdateResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
      });

      const result = await handler(
        makeEvent(
          "updateToolConfig",
          { input: { toolId: "t1", config: "{}" } },
          eventForOrg(ORG_B, true).identity,
        ),
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.toolId).toBe("t1");
    });

    test("fails closed when caller has no resolvable org", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "t1", config: "{}" } },
            { sub: "no-org" },
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("fails closed when the Registry record has no orgId in metadata", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({}),
      });

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "t1", config: "{}" } },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("still throws not-found for a missing record (org gate never reached)", async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(
          makeEvent(
            "updateToolConfig",
            { input: { toolId: "missing" } },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow("Tool config not found");
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });
  });

  // ─── Registry path: deleteToolConfigRegistry ─────────────────────────

  describe("deleteToolConfigRegistry (Registry path)", () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = "true";
      process.env.REGISTRY_ID = "test-registry";
    });

    test("refuses a cross-org caller and performs ZERO Registry deletes", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });

      await expect(
        handler(
          makeEvent(
            "deleteToolConfig",
            { toolId: "t1" },
            eventForOrg(ORG_B).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });

    test("same-org caller succeeds", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await handler(
        makeEvent(
          "deleteToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledWith("tool", "t1");
    });

    test("admin bypasses the org check", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await handler(
        makeEvent(
          "deleteToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_B, true).identity,
        ),
      );

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledWith("tool", "t1");
    });

    test("fails closed when caller has no resolvable org", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
      });

      await expect(
        handler(
          makeEvent("deleteToolConfig", { toolId: "t1" }, { sub: "no-org" }),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });

    test("fails closed when the Registry record has no orgId in metadata", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({}),
      });

      await expect(
        handler(
          makeEvent(
            "deleteToolConfig",
            { toolId: "t1" },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });

    test("fails closed when the record is missing entirely (both Registry and legacy)", async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(
          makeEvent(
            "deleteToolConfig",
            { toolId: "missing" },
            eventForOrg(ORG_A).identity,
          ),
        ),
      ).rejects.toThrow(CrossOrgAccessError);
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });
  });

  // ─── searchToolConfigs: org-filtered (finding ce470ab0, item 2a) ─────

  describe("searchToolConfigs (Registry semantic search, no longer EXEMPT)", () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = "true";
      process.env.REGISTRY_ID = "test-registry";
    });

    test("filters results to the caller's server-derived org", async () => {
      mockSearchResources.mockResolvedValue([
        {
          recordId: "t1",
          name: "Tool1",
          description: "{}",
          status: "APPROVED",
          customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
        },
        {
          recordId: "t2",
          name: "Tool2",
          description: "{}",
          status: "APPROVED",
          customDescriptorContent: JSON.stringify({ orgId: ORG_B }),
        },
      ]);

      const result = await handler(
        makeEvent(
          "searchToolConfigs",
          { query: "test" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe("t1");
    });

    test("admin sees results across every org", async () => {
      mockSearchResources.mockResolvedValue([
        {
          recordId: "t1",
          name: "Tool1",
          description: "{}",
          status: "APPROVED",
          customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
        },
        {
          recordId: "t2",
          name: "Tool2",
          description: "{}",
          status: "APPROVED",
          customDescriptorContent: JSON.stringify({ orgId: ORG_B }),
        },
      ]);

      const result = await handler(
        makeEvent(
          "searchToolConfigs",
          { query: "test" },
          eventForOrg(ORG_A, true).identity,
        ),
      );

      expect(result).toHaveLength(2);
    });

    test("fails closed (empty result) when the caller's own org is unresolvable", async () => {
      mockSearchResources.mockResolvedValue([
        {
          recordId: "t1",
          name: "Tool1",
          description: "{}",
          status: "APPROVED",
          customDescriptorContent: JSON.stringify({ orgId: ORG_A }),
        },
      ]);

      const result = await handler(
        makeEvent("searchToolConfigs", { query: "test" }, { sub: "no-org" }),
      );

      expect(result).toEqual([]);
    });

    test("excludes a matched record whose metadata carries no orgId, even for the org that would otherwise match", async () => {
      mockSearchResources.mockResolvedValue([
        {
          recordId: "t1",
          name: "Tool1",
          description: "{}",
          status: "APPROVED",
          customDescriptorContent: JSON.stringify({}),
        },
      ]);

      const result = await handler(
        makeEvent(
          "searchToolConfigs",
          { query: "test" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result).toEqual([]);
    });
  });

  // ─── Legacy reads: listToolConfigs/getToolConfig org reconciliation
  //     (finding ce470ab0, item 2b) — REGISTRY_ENABLED!='true' ────────────

  describe("listToolConfigs (legacy DynamoDB path, REGISTRY_ENABLED!='true')", () => {
    test("filters out rows belonging to another org", async () => {
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
          { toolId: "t2", orgId: ORG_B, config: "{}", state: "active" },
        ],
      });

      const result = await handler(
        makeEvent("listToolConfigs", {}, eventForOrg(ORG_A).identity),
      );

      expect(result.map((r: { toolId: string }) => r.toolId)).toEqual(["t1"]);
    });

    test("excludes rows with no orgId at all", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ toolId: "t1", config: "{}", state: "active" }],
      });

      const result = await handler(
        makeEvent("listToolConfigs", {}, eventForOrg(ORG_A).identity),
      );

      expect(result).toEqual([]);
    });

    test("admin sees rows across every org", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
          { toolId: "t2", orgId: ORG_B, config: "{}", state: "active" },
        ],
      });

      const result = await handler(
        makeEvent("listToolConfigs", {}, eventForOrg(ORG_A, true).identity),
      );

      expect(result.map((r: { toolId: string }) => r.toolId).sort()).toEqual([
        "t1",
        "t2",
      ]);
    });

    test("fails closed (empty list) when the caller's own org is unresolvable", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ toolId: "t1", orgId: ORG_A, config: "{}", state: "active" }],
      });

      const result = await handler(
        makeEvent("listToolConfigs", {}, { sub: "no-org" }),
      );

      expect(result).toEqual([]);
    });
  });

  describe("getToolConfig (legacy DynamoDB path, REGISTRY_ENABLED!='true')", () => {
    test("returns null (not 403) for a cross-org row", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_B).identity,
        ),
      );

      expect(result).toBeNull();
    });

    test("returns null for a row with no orgId", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", config: "{}", state: "active" },
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result).toBeNull();
    });

    test("same-org caller sees the row", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result?.toolId).toBe("t1");
    });

    test("admin bypasses the org check", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_B, true).identity,
        ),
      );

      expect(result?.toolId).toBe("t1");
    });

    test("fails closed (null) when the caller's own org is unresolvable", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", orgId: ORG_A, config: "{}", state: "active" },
      });

      const result = await handler(
        makeEvent("getToolConfig", { toolId: "t1" }, { sub: "no-org" }),
      );

      expect(result).toBeNull();
    });
  });

  // ─── getToolConfigRegistry: absent orgId is NOT visible to non-admins
  //     (finding ce470ab0, item 2c) ───────────────────────────────────────

  describe("getToolConfigRegistry — absent orgId fails closed", () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = "true";
      process.env.REGISTRY_ID = "test-registry";
    });

    test("a Registry record with no orgId in its metadata is not-found for a non-admin", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({}),
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result).toBeNull();
    });

    test("admin still receives a record with no orgId in its metadata", async () => {
      mockGetResource.mockResolvedValue({
        recordId: "t1",
        name: "Tool1",
        description: "{}",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({}),
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A, true).identity,
        ),
      );

      expect(result?.toolId).toBe("t1");
    });

    test("a DynamoDB-fallback legacy row with no orgId is not-found for a non-admin", async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: "t1", config: "{}", state: "active" },
      });

      const result = await handler(
        makeEvent(
          "getToolConfig",
          { toolId: "t1" },
          eventForOrg(ORG_A).identity,
        ),
      );

      expect(result).toBeNull();
    });
  });
});
