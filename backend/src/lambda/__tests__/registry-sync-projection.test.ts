/**
 * Tests for registry-sync.ts projection row builders (CIT-244).
 */
import {
  buildAgentProjectionRow,
  buildToolProjectionRow,
  buildFullToolConfig,
  PROJECTION_VERSION,
} from "../registry-sync";

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

    const row = buildAgentProjectionRow(
      record as unknown as import("../../services/registry-service").RegistryRecord,
    );

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

describe("buildToolProjectionRow", () => {
  test("produces a row with projectionVersion, projectedAt, citadelKind", () => {
    const record = {
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

    const row = buildToolProjectionRow(
      record as unknown as import("../../services/registry-service").RegistryRecord,
    );

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

  test("produces full tool config from registry descriptor custom data", () => {
    // Real-shape registry descriptor: customDescriptorContent.config carries
    // the full tool payload {name, description, schema, filename, version}
    const fullToolConfig = {
      name: "customer-lookup",
      description: "Look up customer by ID or email",
      schema: {
        type: "object",
        properties: {
          customerId: { type: "string", description: "Customer ID" },
          email: { type: "string", description: "Customer email" },
        },
        required: ["customerId"],
      },
      filename: "customer_lookup.py",
      version: "1.2.0",
    };

    const record = {
      recordId: "rec_cust_001",
      name: "customer-lookup",
      description: "Look up customer by ID or email",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        citadelKind: "tool",
        categories: ["crm"],
        icon: "search",
        state: "active",
        orgId: "org-acme",
        createdBy: "user-fab",
        config: JSON.stringify(fullToolConfig),
      }),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
      updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    };

    const row = buildToolProjectionRow(
      record as unknown as import("../../services/registry-service").RegistryRecord,
    );

    // config should be a JSON string carrying the FULL tool config
    expect(typeof row.config).toBe("string");
    const parsed = JSON.parse(row.config);
    expect(parsed.name).toBe("customer-lookup");
    expect(parsed.description).toBe("Look up customer by ID or email");
    expect(parsed.schema).toEqual(fullToolConfig.schema);
    expect(parsed.filename).toBe("customer_lookup.py");
    expect(parsed.version).toBe("1.2.0");

    // item-level fields
    expect(row.description).toBe("Look up customer by ID or email");
    expect(row.name).toBe("customer-lookup");
    expect(row.orgId).toBe("org-acme");
  });

  test("injects record name/description into config when meta.config is absent", () => {
    // Projection row for a tool that has no meta.config — only record-level
    // name + description (e.g. a fabricator-created tool before PR-384)
    const record = {
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

    const row = buildToolProjectionRow(
      record as unknown as import("../../services/registry-service").RegistryRecord,
    );

    const parsed = JSON.parse(row.config);
    expect(parsed.name).toBe("echo-tool");
    expect(parsed.description).toBe("Echo the input back");
  });
});

describe("buildFullToolConfig", () => {
  test("returns full config from meta.config", () => {
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
});
