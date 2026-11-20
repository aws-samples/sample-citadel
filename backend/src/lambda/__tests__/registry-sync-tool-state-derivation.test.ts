/**
 * Tests for the TOOL rebuild path state-derivation bug:
 *
 * buildToolProjectionRow must derive `state` exactly like
 * buildAgentProjectionRow does — via deriveProjectedState
 * (toInternalStateFromGaStatus(record.status) first, falling back to
 * custom.state only when record.status is unknown) — so an offline
 * rebuild of a tool produces the same `state` as the live GA path
 * (buildGaMergeFields / handleStatusChanged).
 */
import { buildToolProjectionRow } from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";

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

function buildToolRecord(
  status: string | undefined,
  customState?: string,
): RegistryRecord {
  const custom: Record<string, unknown> = {
    categories: ["search"],
    icon: "",
  };
  if (customState !== undefined) {
    custom.state = customState;
  }
  return {
    recordId: "tool-state-derivation-001",
    name: "sample-tool",
    description: "A sample tool",
    status,
    customDescriptorContent: JSON.stringify(custom),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-23T00:00:00.000Z"),
  } as unknown as RegistryRecord;
}

describe("buildToolProjectionRow — state derivation mirrors agent rebuild path", () => {
  test("DRAFT status with custom.state absent projects state as 'maintenance'", () => {
    const record = buildToolRecord("DRAFT");
    const row = buildToolProjectionRow(record);
    expect(row.state).toBe("maintenance");
  });

  test("DRAFT status with custom.state 'active' still projects state as 'maintenance'", () => {
    const record = buildToolRecord("DRAFT", "active");
    const row = buildToolProjectionRow(record);
    expect(row.state).toBe("maintenance");
  });

  test("APPROVED status projects state as 'active'", () => {
    const record = buildToolRecord("APPROVED", "inactive");
    const row = buildToolProjectionRow(record);
    expect(row.state).toBe("active");
  });

  test("PENDING_APPROVAL status projects state as 'pending'", () => {
    const record = buildToolRecord("PENDING_APPROVAL");
    const row = buildToolProjectionRow(record);
    expect(row.state).toBe("pending");
  });

  test("unknown/unmapped status falls back to custom.state", () => {
    const record = buildToolRecord("SOME_UNKNOWN_STATUS", "inactive");
    const row = buildToolProjectionRow(record);
    expect(row.state).toBe("inactive");
  });

  test("unknown/unmapped status with no custom.state falls back to default 'active'", () => {
    const record = buildToolRecord("SOME_UNKNOWN_STATUS");
    const row = buildToolProjectionRow(record);
    expect(row.state).toBe("active");
  });
});
