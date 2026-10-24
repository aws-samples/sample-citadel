/**
 * Tests for registry-sync.ts projection row builders (CIT-244).
 */
import {
  buildAgentProjectionRow,
  buildToolProjectionRow,
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
});
