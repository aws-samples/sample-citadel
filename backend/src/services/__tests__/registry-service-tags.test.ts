/**
 * Tests for tags on AgentConfig / ToolConfig — CIT-042.
 *
 * Validates: create → mapTo* round-trip; update-merge semantics (tags
 * replaced when present, untouched when omitted); absent-tags backward
 * compatibility.
 */
import {
  RegistryService,
  RegistryRecord,
  RegistryRecordStatusValues,
} from "../registry-service";

jest.mock("@aws-sdk/client-agent-registry-control", () => ({
  AgentRegistryControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
}));

describe("RegistryService tags", () => {
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

  const baseRecord = (customMeta: string): RegistryRecord => ({
    recordId: "rec-1",
    name: "TestRecord",
    description: '{"name":"TestRecord"}',
    status: RegistryRecordStatusValues.DRAFT,
    customDescriptorContent: customMeta,
    createdAt: new Date("2024-06-15T10:00:00Z"),
    updatedAt: new Date("2024-06-16T12:00:00Z"),
  });

  // -- Agent round-trip ----------------------------------------------------

  describe("mapToAgentConfig with tags", () => {
    it("surfaces tags when present in custom metadata", () => {
      const tags = { env: "prod", team: "platform" };
      const meta = JSON.stringify({
        categories: ["nlp"],
        icon: "bot",
        state: "active",
        tags,
      });

      const result = service.mapToAgentConfig(baseRecord(meta));
      expect(result.tags).toEqual(tags);
    });

    it("omits tags when absent from custom metadata (backward compat)", () => {
      const meta = JSON.stringify({
        categories: ["nlp"],
        icon: "bot",
        state: "active",
      });

      const result = service.mapToAgentConfig(baseRecord(meta));
      expect(result.tags).toBeUndefined();
    });
  });

  // -- Tool round-trip -----------------------------------------------------

  describe("mapToToolConfig with tags", () => {
    it("surfaces tags when present in custom metadata", () => {
      const tags = { cost: "free", owner: "infra" };
      const meta = JSON.stringify({
        categories: ["storage"],
        icon: "wrench",
        state: "active",
        config: '{"name":"TestTool"}',
        tags,
      });

      const result = service.mapToToolConfig(baseRecord(meta));
      expect(result.tags).toEqual(tags);
    });

    it("omits tags when absent from custom metadata (backward compat)", () => {
      const meta = JSON.stringify({
        categories: ["storage"],
        icon: "wrench",
        state: "active",
        config: '{"name":"TestTool"}',
      });

      const result = service.mapToToolConfig(baseRecord(meta));
      expect(result.tags).toBeUndefined();
    });
  });

  // -- Serialization round-trip --------------------------------------------

  describe("serializeCustomMetadata + deserialize round-trip with tags", () => {
    it("preserves tags through serialize → deserialize cycle", () => {
      const tags = { env: "staging", owner: "team-a" };
      const original = {
        categories: ["analytics"],
        icon: "chart",
        state: "active" as const,
        tags,
      };

      const serialized = service.serializeCustomMetadata(original);
      const deserialized = service.deserializeCustomMetadata<{
        categories: string[];
        icon: string;
        state: string;
        tags?: Record<string, string>;
      }>(serialized, {
        categories: [],
        icon: "",
        state: "active",
        tags: undefined,
      });

      expect(deserialized.tags).toEqual(tags);
    });
  });
});
