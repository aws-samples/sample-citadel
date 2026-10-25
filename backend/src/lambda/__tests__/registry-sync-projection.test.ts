/**
 * Tests for registry-sync.ts projection row builders (CIT-244).
 */
import {
  buildAgentProjectionRow,
  buildToolProjectionRow,
  buildFullToolConfig,
  deserializeCustomMetadata,
  PROJECTION_VERSION,
} from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";

// ---------------------------------------------------------------------------
// Mock AWS clients — registry-sync.ts instantiates DynamoDB + SQS + CW at
// module scope so we must mock before import.
// ---------------------------------------------------------------------------
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: jest.fn().mockReturnValue({}) },
  PutCommand: jest.fn(),
  DeleteCommand: jest.fn(),
  GetCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  ScanCommand: jest.fn(),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn().mockImplementation(() => ({})),
  SendMessageCommand: jest.fn(),
}));
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({})),
  PutMetricDataCommand: jest.fn(),
}));

// Mock RegistryService for resolveGaRecord
jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({})),
  TypeMismatchError: class extends Error {},
}));

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("buildAgentProjectionRow", () => {
  test("produces a row with projectionVersion, projectedAt, citadelKind", () => {
    const record = {
      recordId: "abc123def456",
      name: "test-agent",
      description: '{"name":"test-agent","description":"A test"}',
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: ["worker"],
        icon: "",
        state: "APPROVED",
        orgId: "org-a",
        manifest: { name: "test-agent" },
        decidedBy: "admin-user",
        decidedAt: "2026-10-22T12:00:00.000Z",
        tags: { env: "test" },
      }),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-23T00:00:00.000Z"),
    };

    const row = buildAgentProjectionRow(record as unknown as RegistryRecord);

    expect(row.projectionVersion).toBe(PROJECTION_VERSION);
    expect(row.citadelKind).toBe("agent");
    expect(typeof row.projectedAt).toBe("string");
    expect(row.agentId).toBe("abc123def456");
    expect(row.registryRecordId).toBe("abc123def456");
    expect(row.registryStatus).toBe("APPROVED");
    expect(row.decidedBy).toBe("admin-user");
    expect(row.decidedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(row.orgId).toBe("org-a");
    expect(row.tags).toEqual({ env: "test" });
    expect(row.categories).toEqual(["worker"]);
  });
});

// ---------------------------------------------------------------------------
// LIVE descriptor shape from the escalation_router registry record:
//   descriptors.custom.data = {
//     categories, icon, state,
//     config: { name, filename, schema, version: 1, description },
//     createdBy, orgId
//   }
// config is an OBJECT (not a string), version is a NUMBER.
// ---------------------------------------------------------------------------

const LIVE_TOOL_CONFIG_OBJECT = {
  name: "escalation_router",
  filename: "escalation_router.py",
  schema: {
    type: "object",
    properties: {
      ticketId: { type: "string", description: "Ticket ID" },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    },
    required: ["ticketId", "severity"],
  },
  version: 1,
  description: "Route escalations based on severity and category",
};

/** Registry record mirroring the LIVE escalation_router shape. */
const LIVE_TOOL_RECORD: RegistryRecord = {
  recordId: "rec_escalation_001",
  name: "escalation_router",
  description: "Route escalations based on severity and category",
  status: "APPROVED",
  customDescriptorContent: JSON.stringify({
    categories: ["routing", "support"],
    icon: "escalation",
    state: "active",
    config: LIVE_TOOL_CONFIG_OBJECT,
    createdBy: "user-fab-42",
    orgId: "org-acme",
  }),
  createdAt: new Date("2026-09-15T00:00:00.000Z"),
  updatedAt: new Date("2026-10-20T00:00:00.000Z"),
};

describe("buildToolProjectionRow", () => {
  test("produces a row with projectionVersion, projectedAt, citadelKind", () => {
    const record: RegistryRecord = {
      recordId: "tool123tool45",
      name: "search-tool",
      description: "A search tool",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        citadelKind: "tool",
        categories: ["search"],
        icon: "",
        state: "active",
        orgId: "org-b",
        createdBy: "user-1",
        decidedBy: "admin",
        decidedAt: "2026-10-22T12:00:00.000Z",
        statusReason: "Approved after review",
      }),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-23T00:00:00.000Z"),
    };

    const row = buildToolProjectionRow(record);

    expect(row.projectionVersion).toBe(PROJECTION_VERSION);
    expect(row.citadelKind).toBe("tool");
    expect(typeof row.projectedAt).toBe("string");
    expect(row.toolId).toBe("tool123tool45");
    expect(row.registryStatus).toBe("APPROVED");
    expect(row.orgId).toBe("org-b");
    expect(row.createdBy).toBe("user-1");
    expect(row.decidedBy).toBe("admin");
    expect(row.decidedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(row.statusReason).toBe("Approved after review");
    expect(row.categories).toEqual(["search"]);
  });

  test("LIVE shape: config as an OBJECT (not string) produces full config with name, description, schema, filename, version", () => {
    const row = buildToolProjectionRow(LIVE_TOOL_RECORD);

    expect(typeof row.config).toBe("string");
    const parsed = JSON.parse(row.config);
    expect(parsed.name).toBe("escalation_router");
    expect(parsed.description).toBe(
      "Route escalations based on severity and category",
    );
    expect(parsed.schema).toEqual(LIVE_TOOL_CONFIG_OBJECT.schema);
    expect(parsed.filename).toBe("escalation_router.py");
    expect(parsed.version).toBe(1);

    // Item-level fields
    expect(row.description).toBe(
      "Route escalations based on severity and category",
    );
    expect(row.name).toBe("escalation_router");
    expect(row.orgId).toBe("org-acme");
    expect(row.createdBy).toBe("user-fab-42");
  });

  test("legacy shape: config as a JSON STRING produces full config", () => {
    const legacyRecord: RegistryRecord = {
      recordId: "rec_legacy_001",
      name: "customer-lookup",
      description: "Look up customer by ID or email",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        categories: ["crm"],
        icon: "search",
        state: "active",
        orgId: "org-acme",
        createdBy: "user-fab",
        config: JSON.stringify({
          name: "customer-lookup",
          description: "Look up customer by ID or email",
          schema: {
            type: "object",
            properties: { customerId: { type: "string" } },
            required: ["customerId"],
          },
          filename: "customer_lookup.py",
          version: "1.2.0",
        }),
      }),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    };

    const row = buildToolProjectionRow(legacyRecord);

    expect(typeof row.config).toBe("string");
    const parsed = JSON.parse(row.config);
    expect(parsed.name).toBe("customer-lookup");
    expect(parsed.description).toBe("Look up customer by ID or email");
    expect(parsed.schema).toBeDefined();
    expect(parsed.filename).toBe("customer_lookup.py");
    expect(parsed.version).toBe("1.2.0");
  });

  test("end-to-end: deserializeCustomMetadata → buildToolProjectionRow with LIVE object config", () => {
    // Simulate the exact path registry-sync uses: deserialize the outer
    // customDescriptorContent, then pass the result through
    // buildToolProjectionRow (which internally calls deserializeCustomMetadata
    // again and then buildFullToolConfig with meta.config).
    const outerMeta = deserializeCustomMetadata(
      LIVE_TOOL_RECORD.customDescriptorContent ?? null,
      {
        categories: [] as string[],
        icon: "",
        state: "active" as string,
        config: undefined as unknown,
      },
    );

    // meta.config is an OBJECT after deserializeCustomMetadata (not a string)
    expect(typeof outerMeta.config).toBe("object");
    expect(outerMeta.config).toEqual(LIVE_TOOL_CONFIG_OBJECT);

    // Now run the full projection builder
    const row = buildToolProjectionRow(LIVE_TOOL_RECORD);
    const parsed = JSON.parse(row.config);
    expect(parsed.name).toBe("escalation_router");
    expect(parsed.description).toBe(
      "Route escalations based on severity and category",
    );
    expect(parsed.schema).toEqual(LIVE_TOOL_CONFIG_OBJECT.schema);
    expect(parsed.filename).toBe("escalation_router.py");
    expect(parsed.version).toBe(1);
  });

  test("injects record name/description into config when meta.config is absent", () => {
    const record: RegistryRecord = {
      recordId: "rec_no_meta",
      name: "echo-tool",
      description: "Echo the input back",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        citadelKind: "tool",
        categories: [],
        icon: "",
        state: "active",
        orgId: "org-x",
      }),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    };

    const row = buildToolProjectionRow(record);

    const parsed = JSON.parse(row.config);
    expect(parsed.name).toBe("echo-tool");
    expect(parsed.description).toBe("Echo the input back");
  });
});

describe("buildFullToolConfig", () => {
  test("accepts an already-parsed config object and returns full JSON", () => {
    const configObj = {
      name: "tool-obj",
      description: "Desc from object",
      schema: { type: "object" },
      filename: "tool_obj.py",
      version: 1,
    };
    const result = buildFullToolConfig(
      configObj,
      "fallback desc",
      "fallback-name",
    );
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("tool-obj");
    expect(parsed.description).toBe("Desc from object");
    expect(parsed.schema).toEqual({ type: "object" });
    expect(parsed.filename).toBe("tool_obj.py");
    expect(parsed.version).toBe(1);
  });

  test("accepts a JSON string config (legacy) and returns full JSON", () => {
    const metaConfig = JSON.stringify({
      name: "tool-a",
      description: "Desc A",
      schema: { type: "object" },
    });
    const result = buildFullToolConfig(
      metaConfig,
      "fallback desc",
      "fallback-name",
    );
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("tool-a");
    expect(parsed.description).toBe("Desc A");
    expect(parsed.schema).toEqual({ type: "object" });
  });

  test("injects recordName when meta.config lacks name", () => {
    const metaConfig = JSON.stringify({ description: "D", schema: {} });
    const result = buildFullToolConfig(metaConfig, "rec desc", "my-tool");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("my-tool");
  });

  test("injects recordDescription when meta.config lacks description", () => {
    const metaConfig = JSON.stringify({ name: "t", schema: {} });
    const result = buildFullToolConfig(metaConfig, "the desc", "n");
    const parsed = JSON.parse(result);
    expect(parsed.description).toBe("the desc");
  });

  test("returns name+description from record when meta.config is undefined", () => {
    const result = buildFullToolConfig(undefined, "some desc", "some-tool");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("some-tool");
    expect(parsed.description).toBe("some desc");
  });

  test("warns and falls back when meta.config is a non-JSON string", () => {
    const result = buildFullToolConfig("not-valid-json", "fb desc", "fb-name");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("fb-name");
    expect(parsed.description).toBe("fb desc");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("non-JSON string"),
    );
  });

  test("warns and falls back when meta.config is an unexpected type (number)", () => {
    const result = buildFullToolConfig(42, "fb desc", "fb-name");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("fb-name");
    expect(parsed.description).toBe("fb desc");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("unexpected type"),
    );
  });

  test("object config with numeric version preserves the number", () => {
    const configObj = { name: "v-tool", description: "d", version: 1 };
    const result = buildFullToolConfig(configObj, undefined, undefined);
    const parsed = JSON.parse(result);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.version).toBe("number");
  });
});
