/**
 * Tests for the denormalized registry-approval fields
 * (registryStatus / registryRecordId / statusUpdatedAt) written onto
 * AGENT_CONFIG_TABLE rows by registry-sync.ts's three writers.
 *
 * Invariant under test (CIT-041 design, Decision 1 + review amendments):
 * every writer sets these fields FROM THE RAW SOURCE STATUS; none ever
 * defaults registryStatus to "APPROVED" — a source with no status signal
 * leaves the attribute UNSET.
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => ({
      getResource: jest.fn(),
    })),
  };
});

import {
  buildAgentCacheRecord,
  handleGaUpsert,
  handleStatusChanged,
} from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";
import {
  REGISTRY_STATUS_FIELD,
  REGISTRY_RECORD_ID_FIELD,
  STATUS_UPDATED_AT_FIELD,
} from "../approval-cache-fields";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function registryRecord(
  overrides: Partial<RegistryRecord> = {},
): RegistryRecord {
  return {
    recordId: "rec-123",
    name: "TestAgent",
    description: "A test agent",
    status: "PENDING_APPROVAL",
    customDescriptorContent: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildAgentCacheRecord (legacy path)
// ---------------------------------------------------------------------------

describe("buildAgentCacheRecord — registry-approval denormalization", () => {
  test("sets registryStatus from the raw status when present in customDescriptorContent", () => {
    const record = buildAgentCacheRecord("agent-1", {
      description: "desc",
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: "",
        state: "DRAFT",
      }),
    });

    expect(record[REGISTRY_STATUS_FIELD]).toBe("DRAFT");
    expect(record[STATUS_UPDATED_AT_FIELD]).toBeDefined();
  });

  test("never defaults registryStatus to APPROVED when the source omits status entirely", () => {
    const record = buildAgentCacheRecord("agent-2", { description: "desc" });

    // The internal `state` field DOES fail open to "active" (existing,
    // unrelated behavior) — but registryStatus must not inherit that.
    expect(record.state).toBe("active");
    expect(record[REGISTRY_STATUS_FIELD]).toBeUndefined();
    expect(record).not.toHaveProperty(REGISTRY_STATUS_FIELD, "APPROVED");
  });

  test("leaves registryStatus unset when customDescriptorContent is malformed JSON", () => {
    const record = buildAgentCacheRecord("agent-3", {
      description: "desc",
      customDescriptorContent: "not json",
    });

    expect(record[REGISTRY_STATUS_FIELD]).toBeUndefined();
  });

  test("registryRecordId is unset on the legacy path (no recordId in the payload)", () => {
    const record = buildAgentCacheRecord("agent-4", {
      description: "desc",
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: "",
        state: "APPROVED",
      }),
    });

    expect(record[REGISTRY_RECORD_ID_FIELD]).toBeUndefined();
  });

  test("statusUpdatedAt is only set when registryStatus is present", () => {
    const withStatus = buildAgentCacheRecord("agent-5", {
      customDescriptorContent: JSON.stringify({ state: "REJECTED" }),
    });
    const withoutStatus = buildAgentCacheRecord("agent-6", {});

    expect(withStatus[STATUS_UPDATED_AT_FIELD]).toBeDefined();
    expect(withoutStatus[STATUS_UPDATED_AT_FIELD]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleGaUpsert
// ---------------------------------------------------------------------------

describe("handleGaUpsert — registry-approval denormalization", () => {
  test("merges registryStatus/registryRecordId/statusUpdatedAt from the resolved record", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleGaUpsert(
      "test-agents-table",
      "agent",
      "agent-1",
      registryRecord({ recordId: "rec-abc", status: "REJECTED" }),
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    expect(input.ExpressionAttributeValues![":registryStatus"]).toBe(
      "REJECTED",
    );
    expect(input.ExpressionAttributeValues![":registryRecordId"]).toBe(
      "rec-abc",
    );
    expect(input.ExpressionAttributeValues![":statusUpdatedAt"]).toBeDefined();
    expect(input.UpdateExpression).toContain("#registryStatus");
  });

  test("writes the raw status, not the mapped internal state", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleGaUpsert(
      "test-agents-table",
      "agent",
      "agent-1",
      registryRecord({ status: "DRAFT" }),
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![":registryStatus"]).toBe("DRAFT");
    // mapped internal state for DRAFT is "maintenance", a different string —
    // proves registryStatus carries the raw value, not the mapping.
    expect(input.ExpressionAttributeValues![":state"]).toBe("maintenance");
  });

  test("SET-only merge semantics: does not include registryStatus in the update when record.status is empty", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleGaUpsert(
      "test-agents-table",
      "agent",
      "agent-1",
      registryRecord({ status: "" }),
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).not.toContain("#registryStatus");
    expect(input.ExpressionAttributeValues).not.toHaveProperty(
      ":registryStatus",
    );
  });
});

// ---------------------------------------------------------------------------
// handleStatusChanged
// ---------------------------------------------------------------------------

describe("handleStatusChanged — registry-approval denormalization", () => {
  test("SETs registryStatus to the raw newStatus alongside #state", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged(
      "test-agents-table",
      "agent",
      "agent-1",
      "REJECTED",
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![":newStatus"]).toBe("REJECTED");
    expect(input.UpdateExpression).toContain("#registryStatus");
    expect(input.UpdateExpression).toContain("#statusUpdatedAt");
  });

  test("writes raw status even when it maps to the same internal state as DRAFT->maintenance", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged("test-agents-table", "agent", "a-1", "DRAFT");

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![":newStatus"]).toBe("DRAFT");
    expect(input.ExpressionAttributeValues![":newState"]).toBe("maintenance");
  });

  test("keeps the existing idempotency ConditionExpression keyed on #state", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged("test-agents-table", "agent", "a-1", "APPROVED");

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain("attribute_exists");
    expect(input.ConditionExpression).toContain("#state <> :newState");
  });
});
