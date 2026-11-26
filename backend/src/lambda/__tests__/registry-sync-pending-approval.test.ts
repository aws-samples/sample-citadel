/**
 * TDD tests for the Pending Approval detail-type fix and stale-event guard.
 *
 * (1) VALID_GA_RECORD_DETAIL_TYPES must accept "Registry Record State changed
 *     to Pending Approval" and map it to registryStatus PENDING_APPROVAL.
 * (2) Every registry state name in REGISTRY_STATE_NAMES must have a
 *     corresponding "Registry Record State changed to <State>" entry in
 *     VALID_GA_RECORD_DETAIL_TYPES.
 * (3) The handler must ignore GA events whose `time` is older than the row's
 *     recorded `lastRegistryEventAt` (stale-event guard for safe DLQ redrive).
 * (4) Unknown detail-types must log the detail-type AND the record id.
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { RegistryRecord } from "../../services/registry-service";

const mockGetResource = jest.fn();
jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => ({
      getResource: mockGetResource,
    })),
  };
});

import {
  handler,
  validateEvent,
  isGaRecordDetailType,
  REGISTRY_STATE_NAMES,
  VALID_GA_RECORD_DETAIL_TYPES,
} from "../registry-sync";
import type { RegistryEvent } from "../registry-sync";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  cwMock.reset();
  mockGetResource.mockReset();
  sqsMock.on(SendMessageCommand).resolves({});
  cwMock.on(PutMetricDataCommand).resolves({});
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGaEvent(
  state: string,
  recordId: string,
  time: string,
): unknown {
  return {
    version: "0",
    id: `evt-${recordId}`,
    "detail-type": `Registry Record State changed to ${state}`,
    source: "aws.agent-registry",
    account: "123456789012",
    time,
    region: "us-west-2",
    resources: [
      `arn:aws:agent-registry:us-west-2:123456789012:registry/RegTest000001/record/${recordId}`,
    ],
    detail: {
      registryRecordId: recordId,
      registryId: "RegTest000001",
    },
  };
}

const pendingApprovalRecord: RegistryRecord = {
  recordId: "RecPending001",
  name: "PendingAgent",
  description: "An agent awaiting approval",
  status: "PENDING_APPROVAL",
  customDescriptorContent: JSON.stringify({
    categories: ["worker"],
    icon: "",
    state: "PENDING_APPROVAL",
  }),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:01.000Z"),
};

const approvedRecord: RegistryRecord = {
  recordId: "RecPending001",
  name: "PendingAgent",
  description: "An approved agent",
  status: "APPROVED",
  customDescriptorContent: JSON.stringify({
    categories: ["worker"],
    icon: "",
    state: "APPROVED",
  }),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:02.000Z"),
};

// =========================================================================
// (1) Pending Approval acceptance
// =========================================================================

describe("Pending Approval detail-type", () => {
  test("validateEvent accepts 'Registry Record State changed to Pending Approval'", () => {
    const event = makeGaEvent("Pending Approval", "RecPending001", "2026-01-01T00:00:01Z");
    expect(validateEvent(event as RegistryEvent)).toBeNull();
  });

  test("isGaRecordDetailType returns true for the Pending Approval string", () => {
    expect(
      isGaRecordDetailType("Registry Record State changed to Pending Approval"),
    ).toBe(true);
  });

  test("handler processes Pending Approval event and maps to PENDING_APPROVAL registryStatus", async () => {
    mockGetResource.mockResolvedValueOnce(pendingApprovalRecord);
    // GetCommand for seeder guard — no existing row
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler(
      makeGaEvent("Pending Approval", "RecPending001", "2026-01-01T00:00:01Z") as RegistryEvent,
    );

    expect(mockGetResource).toHaveBeenCalledWith("agent", "RecPending001");
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![":registryStatus"]).toBe(
      "PENDING_APPROVAL",
    );
    expect(input.ExpressionAttributeValues![":state"]).toBe("pending");
  });
});

// =========================================================================
// (2) REGISTRY_STATE_NAMES exhaustiveness
// =========================================================================

describe("REGISTRY_STATE_NAMES exhaustiveness", () => {
  test("every state name has a corresponding GA detail-type entry", () => {
    for (const state of REGISTRY_STATE_NAMES) {
      const detailType = `Registry Record State changed to ${state}`;
      expect(VALID_GA_RECORD_DETAIL_TYPES.has(detailType)).toBe(true);
    }
  });

  test("every GA detail-type entry corresponds to a known state name", () => {
    for (const dt of VALID_GA_RECORD_DETAIL_TYPES) {
      const match = (dt as string).match(
        /^Registry Record State changed to (.+)$/,
      );
      expect(match).not.toBeNull();
      expect(REGISTRY_STATE_NAMES).toContain(match![1]);
    }
  });
});

// =========================================================================
// (3) Stale-event guard (lastRegistryEventAt ordering)
// =========================================================================

describe("stale-event guard", () => {
  test("ignores a Pending Approval event that is older than the row's lastRegistryEventAt", async () => {
    // First: process an Approved event at T=03
    mockGetResource.mockResolvedValueOnce(approvedRecord);
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler(
      makeGaEvent("Approved", "RecPending001", "2026-01-01T00:00:03Z") as RegistryEvent,
    );

    // The UpdateCommand must have set lastRegistryEventAt
    const firstUpdateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(firstUpdateCalls.length).toBeGreaterThanOrEqual(1);
    const firstInput = firstUpdateCalls[0].args[0].input;
    expect(firstInput.ExpressionAttributeValues![":lastRegistryEventAt"]).toBe(
      "2026-01-01T00:00:03Z",
    );

    // Reset mocks for second call
    ddbMock.reset();
    mockGetResource.mockReset();

    // Second: replay an older Pending Approval event at T=01 (from DLQ redrive)
    mockGetResource.mockResolvedValueOnce(pendingApprovalRecord);
    // GetCommand for seeder guard — return row with lastRegistryEventAt from the newer event
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "RecPending001",
        lastRegistryEventAt: "2026-01-01T00:00:03Z",
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(
      makeGaEvent("Pending Approval", "RecPending001", "2026-01-01T00:00:01Z") as RegistryEvent,
    );

    // The stale event should be skipped — no UpdateCommand for merge fields
    const secondUpdateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(secondUpdateCalls).toHaveLength(0);
  });

  test("applies a newer event even when row has lastRegistryEventAt", async () => {
    mockGetResource.mockResolvedValueOnce(approvedRecord);
    // GetCommand returns a row with an older lastRegistryEventAt
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "RecPending001",
        lastRegistryEventAt: "2026-01-01T00:00:01Z",
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler(
      makeGaEvent("Approved", "RecPending001", "2026-01-01T00:00:03Z") as RegistryEvent,
    );

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![":lastRegistryEventAt"]).toBe(
      "2026-01-01T00:00:03Z",
    );
  });

  test("applies event when row has no lastRegistryEventAt (first event)", async () => {
    mockGetResource.mockResolvedValueOnce(pendingApprovalRecord);
    ddbMock.on(GetCommand).resolves({
      Item: { agentId: "RecPending001" },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    await handler(
      makeGaEvent("Pending Approval", "RecPending001", "2026-01-01T00:00:01Z") as RegistryEvent,
    );

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// (4) Malformed event logging includes detail-type AND record id
// =========================================================================

describe("malformed event logging", () => {
  test("unknown detail-type logs both the detail-type and the record id", async () => {
    const errorSpy = jest.spyOn(console, "error");
    const event = {
      version: "0",
      id: "evt-bad",
      "detail-type": "Registry Record State changed to Bogus",
      source: "aws.agent-registry",
      account: "123456789012",
      time: "2026-01-01T00:00:00Z",
      region: "us-west-2",
      detail: {
        registryRecordId: "RecBogus001",
        registryId: "RegTest000001",
      },
    };

    await expect(handler(event as RegistryEvent)).rejects.toThrow(
      "Malformed registry sync event",
    );

    // The console.error call should mention both the detail-type and the record id
    const errorCalls = errorSpy.mock.calls.map((c) => c.join(" "));
    const relevant = errorCalls.find(
      (msg) =>
        msg.includes("Registry Record State changed to Bogus") &&
        msg.includes("RecBogus001"),
    );
    expect(relevant).toBeDefined();
  });
});
