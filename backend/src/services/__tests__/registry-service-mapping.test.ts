/**
 * Unit tests for RegistryService record mapping functions:
 * - mapToAgentConfig: RegistryRecord → AgentConfig
 * - mapToToolConfig: RegistryRecord → ToolConfig
 *
 * Validates: Requirements 3.6, 4.6
 */

import {
  RegistryService,
  RegistryRecord,
  RegistryRecordStatusValues,
  AgentConfig,
  ToolConfig,
} from "../registry-service";

jest.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
}));

describe("RegistryService record mapping", () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- mapToAgentConfig ----------------------------------------------------

  describe("mapToAgentConfig", () => {
    it("maps a full Registry record to AgentConfig", () => {
      const now = new Date("2024-06-15T10:00:00Z");
      const later = new Date("2024-06-16T12:00:00Z");
      const customMeta = JSON.stringify({
        categories: ["nlp", "chat"],
        icon: "bot",
        state: "active",
        appId: "app-1",
        manifest: { name: "TestAgent", version: "1.0" },
      });

      const record: RegistryRecord = {
        recordId: "agent-123",
        name: "TestAgent",
        description: '{"name":"TestAgent","filename":"test.py","schema":"{}"}',
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: customMeta,
        createdAt: now,
        updatedAt: later,
      };

      const result: AgentConfig = service.mapToAgentConfig(record);

      expect(result.agentId).toBe("agent-123");
      expect(result.config).toBe(
        '{"name":"TestAgent","filename":"test.py","schema":"{}"}',
      );
      expect(result.state).toBe("active");
      expect(result.categories).toEqual(["nlp", "chat"]);
      expect(result.createdAt).toBe("2024-06-15T10:00:00.000Z");
      expect(result.updatedAt).toBe("2024-06-16T12:00:00.000Z");
      expect(result.manifest).toEqual({ name: "TestAgent", version: "1.0" });
    });

    it("maps recordId to agentId", () => {
      const record: RegistryRecord = {
        recordId: "my-agent-id",
        name: "Agent",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToAgentConfig(record).agentId).toBe("my-agent-id");
    });

    it("maps description to config", () => {
      const desc = '{"name":"A","filename":"a.py"}';
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        description: desc,
        status: RegistryRecordStatusValues.DRAFT,
      };
      expect(service.mapToAgentConfig(record).config).toBe(desc);
    });

    it("maps APPROVED status to active state", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToAgentConfig(record).state).toBe("active");
    });

    it("maps DEPRECATED status to inactive state", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.DEPRECATED,
      };
      expect(service.mapToAgentConfig(record).state).toBe("inactive");
    });

    it("maps DRAFT status to maintenance state", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.DRAFT,
      };
      expect(service.mapToAgentConfig(record).state).toBe("maintenance");
    });

    it("maps PENDING_APPROVAL status to active state", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.PENDING_APPROVAL,
      };
      expect(service.mapToAgentConfig(record).state).toBe("active");
    });

    it("maps unknown status to inactive with warning", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: "SOME_UNKNOWN_STATUS",
      };
      expect(service.mapToAgentConfig(record).state).toBe("inactive");
      expect(console.warn).toHaveBeenCalled();
    });

    it("uses default categories when custom metadata is missing", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToAgentConfig(record).categories).toEqual([]);
    });

    it("uses default manifest (undefined) when custom metadata is missing", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToAgentConfig(record).manifest).toBeUndefined();
    });

    it("returns '{}' for config when description is undefined (AWSJSON contract)", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToAgentConfig(record).config).toBe("{}");
    });

    it("returns undefined timestamps when dates are missing", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
      };
      const result = service.mapToAgentConfig(record);
      expect(result.createdAt).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
    });

    it("handles malformed custom metadata gracefully", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: "{invalid json",
      };
      const result = service.mapToAgentConfig(record);
      expect(result.categories).toEqual([]);
      expect(result.manifest).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });

    // ── Phase-2a: orgId round-trips through the metadata layer ──
    it("round-trips orgId from customDescriptorContent onto the mapped AgentConfig", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
          orgId: "team-rocket",
        }),
      };
      expect(service.mapToAgentConfig(record).orgId).toBe("team-rocket");
    });

    it("defaults orgId to '' when customDescriptorContent is absent (legacy records)", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToAgentConfig(record).orgId).toBe("");
    });

    it("defaults orgId to '' when customDescriptorContent has no orgId field", () => {
      const record: RegistryRecord = {
        recordId: "a1",
        name: "A",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
        }),
      };
      expect(service.mapToAgentConfig(record).orgId).toBe("");
    });
  });

  // -- mapToToolConfig -----------------------------------------------------

  describe("mapToToolConfig", () => {
    it("maps a full Registry record to ToolConfig", () => {
      const now = new Date("2024-07-01T08:00:00Z");
      const later = new Date("2024-07-02T09:30:00Z");
      const customMeta = JSON.stringify({
        categories: ["data", "api"],
        icon: "wrench",
        state: "active",
        integrationBindings: [
          {
            integrationId: "int-1",
            integrationType: "REST",
            operations: ["read"],
            direction: "INPUT",
          },
        ],
        dataStoreBindings: [
          {
            dataStoreId: "ds-1",
            dataStoreType: "S3",
            operations: ["write"],
            direction: "OUTPUT",
          },
        ],
        appId: "app-2",
      });

      const record: RegistryRecord = {
        recordId: "tool-456",
        name: "DataTool",
        description: '{"name":"DataTool","filename":"data.py","schema":"{}"}',
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: customMeta,
        createdAt: now,
        updatedAt: later,
      };

      const result: ToolConfig = service.mapToToolConfig(record);

      expect(result.toolId).toBe("tool-456");
      expect(result.config).toBe(
        '{"name":"DataTool","filename":"data.py","schema":"{}"}',
      );
      expect(result.state).toBe("active");
      expect(result.categories).toEqual(["data", "api"]);
      expect(result.integrationBindings).toEqual([
        {
          integrationId: "int-1",
          integrationType: "REST",
          operations: ["read"],
          direction: "INPUT",
        },
      ]);
      expect(result.dataStoreBindings).toEqual([
        {
          dataStoreId: "ds-1",
          dataStoreType: "S3",
          operations: ["write"],
          direction: "OUTPUT",
        },
      ]);
      expect(result.createdAt).toBe("2024-07-01T08:00:00.000Z");
      expect(result.updatedAt).toBe("2024-07-02T09:30:00.000Z");
    });

    it("maps recordId to toolId", () => {
      const record: RegistryRecord = {
        recordId: "my-tool-id",
        name: "Tool",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToToolConfig(record).toolId).toBe("my-tool-id");
    });

    it("maps description to config", () => {
      const desc = '{"name":"T","filename":"t.py"}';
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        description: desc,
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToToolConfig(record).config).toBe(desc);
    });

    it("maps status to state correctly", () => {
      const cases: Array<[string, string]> = [
        [RegistryRecordStatusValues.APPROVED, "active"],
        [RegistryRecordStatusValues.DEPRECATED, "inactive"],
        [RegistryRecordStatusValues.DRAFT, "maintenance"],
        [RegistryRecordStatusValues.PENDING_APPROVAL, "active"],
      ];

      for (const [status, expectedState] of cases) {
        const record: RegistryRecord = {
          recordId: "t1",
          name: "T",
          status,
        };
        expect(service.mapToToolConfig(record).state).toBe(expectedState);
      }
    });

    it("returns null for bindings when custom metadata has no bindings", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: JSON.stringify({
          categories: ["test"],
          icon: "",
          state: "active",
        }),
      };
      const result = service.mapToToolConfig(record);
      expect(result.integrationBindings).toBeNull();
      expect(result.dataStoreBindings).toBeNull();
    });

    it("uses default categories when custom metadata is missing", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToToolConfig(record).categories).toEqual([]);
    });

    it("returns '{}' for config when description is undefined (AWSJSON contract)", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToToolConfig(record).config).toBe("{}");
    });

    it("returns undefined timestamps when dates are missing", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
      };
      const result = service.mapToToolConfig(record);
      expect(result.createdAt).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
    });

    it("handles malformed custom metadata gracefully", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: "not-json",
      };
      const result = service.mapToToolConfig(record);
      expect(result.categories).toEqual([]);
      expect(result.integrationBindings).toBeNull();
      expect(result.dataStoreBindings).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it("preserves binding arrays from custom metadata", () => {
      const bindings = {
        categories: [],
        icon: "",
        state: "active",
        integrationBindings: [
          { integrationId: "i1", integrationType: "GraphQL" },
          {
            integrationId: "i2",
            integrationType: "REST",
            operations: ["create", "read"],
            direction: "BIDIRECTIONAL",
          },
        ],
        dataStoreBindings: [
          {
            dataStoreId: "d1",
            dataStoreType: "DynamoDB",
            operations: ["scan"],
          },
        ],
      };
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: JSON.stringify(bindings),
      };
      const result = service.mapToToolConfig(record);
      expect(result.integrationBindings).toEqual(bindings.integrationBindings);
      expect(result.dataStoreBindings).toEqual(bindings.dataStoreBindings);
    });

    // ── Phase-2a: orgId round-trips through the metadata layer ──
    it("round-trips orgId from customDescriptorContent onto the mapped ToolConfig", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
          orgId: "team-rocket",
        }),
      };
      expect(service.mapToToolConfig(record).orgId).toBe("team-rocket");
    });

    it("defaults orgId to '' when customDescriptorContent is absent (legacy records)", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
      };
      expect(service.mapToToolConfig(record).orgId).toBe("");
    });

    it("defaults orgId to '' when customDescriptorContent has no orgId field", () => {
      const record: RegistryRecord = {
        recordId: "t1",
        name: "T",
        status: RegistryRecordStatusValues.APPROVED,
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
        }),
      };
      expect(service.mapToToolConfig(record).orgId).toBe("");
    });
  });
});
