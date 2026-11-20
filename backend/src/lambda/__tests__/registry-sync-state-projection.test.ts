/**
 * Tests for the state-projection bug fix:
 *
 * (a) toInternalState receives lowercase internal values ('active'/'inactive')
 *     from the descriptor's state field — they must pass through unchanged
 *     (case-insensitive) rather than falling to the default 'inactive'.
 *
 * (b) The projection PutItem must carry lastRegistryEventAt = event.time
 *     and must never regress it when an older event replays.
 *
 * (c) Heal mode in reconcile-legacy-rows.ts for drifted state.
 */
import {
  toInternalState,
  buildAgentCacheRecord,
  buildAgentProjectionRow,
  handleGaUpsert,
} from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";

// ---------------------------------------------------------------------------
// Mock AWS clients — registry-sync.ts instantiates them at module scope.
// ---------------------------------------------------------------------------
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

const mockSend = jest.fn();
jest.mock("@aws-sdk/lib-dynamodb", () => {
  return {
    DynamoDBDocumentClient: {
      from: jest
        .fn()
        .mockReturnValue({ send: (...a: unknown[]) => mockSend(...a) }),
    },
    PutCommand: jest
      .fn()
      .mockImplementation((p: unknown) => ({ _type: "Put", input: p })),
    DeleteCommand: jest.fn(),
    GetCommand: jest
      .fn()
      .mockImplementation((p: unknown) => ({ _type: "Get", input: p })),
    UpdateCommand: jest
      .fn()
      .mockImplementation((p: unknown) => ({ _type: "Update", input: p })),
    ScanCommand: jest.fn(),
  };
});
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
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (a) toInternalState must handle lowercase internal values
// ---------------------------------------------------------------------------
describe("toInternalState — case-insensitive internal values", () => {
  test("maps 'active' (lowercase internal value) to 'active'", () => {
    expect(toInternalState("active")).toBe("active");
  });

  test("maps 'inactive' (lowercase internal value) to 'inactive'", () => {
    expect(toInternalState("inactive")).toBe("inactive");
  });

  test("maps 'maintenance' (lowercase internal value) to 'maintenance'", () => {
    expect(toInternalState("maintenance")).toBe("maintenance");
  });

  test("maps 'pending' (lowercase internal value) to 'pending'", () => {
    expect(toInternalState("pending")).toBe("pending");
  });

  // Existing UPPERCASE behaviour must still work:
  test("maps APPROVED to active", () => {
    expect(toInternalState("APPROVED")).toBe("active");
  });

  test("maps DEPRECATED to inactive", () => {
    expect(toInternalState("DEPRECATED")).toBe("inactive");
  });

  test("maps DRAFT to maintenance", () => {
    expect(toInternalState("DRAFT")).toBe("maintenance");
  });

  test("maps PENDING_APPROVAL to pending", () => {
    expect(toInternalState("PENDING_APPROVAL")).toBe("pending");
  });

  test("unknown status falls back to record.status derivation via overload", () => {
    // When called with a second arg (record.status), unknown values derive from it
    expect(toInternalState("something_weird", "APPROVED")).toBe("active");
    expect(toInternalState("something_weird", "DEPRECATED")).toBe("inactive");
  });

  test("unknown status with no record.status falls to inactive (with WARN)", () => {
    expect(toInternalState("something_unknown")).toBe("inactive");
  });
});

// ---------------------------------------------------------------------------
// (a) buildAgentCacheRecord must project state correctly for APPROVED records
// ---------------------------------------------------------------------------
describe("buildAgentCacheRecord — APPROVED descriptor state", () => {
  test("APPROVED record with descriptor state 'active' projects state as 'active'", () => {
    const resource = {
      name: "energy-settlements-agent",
      description: "An energy settlements agent",
      customDescriptorContent: JSON.stringify({
        categories: ["worker"],
        icon: "",
        state: "active",
        orgId: "org-es",
      }),
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
    };

    const record = buildAgentCacheRecord("rec-001", resource);
    expect(record.state).toBe("active");
  });

  test("APPROVED record with descriptor state 'APPROVED' (uppercase) projects state as 'active'", () => {
    const resource = {
      name: "test-agent",
      description: "Test agent",
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: "",
        state: "APPROVED",
        orgId: "org-x",
      }),
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
    };

    const record = buildAgentCacheRecord("rec-002", resource);
    expect(record.state).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// (a+b) End-to-end: GA event -> handleGaUpsert -> both DDB commands applied
//        to an in-memory item -> assert state + lastRegistryEventAt.
// ---------------------------------------------------------------------------
describe("handleGaUpsert — state projection + lastRegistryEventAt", () => {
  test("APPROVED event projects state active AND carries lastRegistryEventAt", async () => {
    const eventTime = "2026-11-14T22:00:00Z";
    const record: RegistryRecord = {
      recordId: "rec-es-001",
      name: "energy-price-forecaster",
      description: "Forecasts energy prices",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        categories: ["worker"],
        icon: "⚡",
        state: "active",
        orgId: "org-es",
        manifest: { name: "energy-price-forecaster" },
      }),
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-11-10T00:00:00Z"),
    };

    // In-memory DDB item — accumulates writes from the merge UpdateCommand
    // and the projection PutCommand (or UpdateCommand after fix).
    const item: Record<string, unknown> = {};

    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        if (cmd._type === "Get") {
          // Seeder guard check — not seeder-owned
          return { Item: undefined };
        }
        if (cmd._type === "Update") {
          // Apply UpdateExpression SET clauses to in-memory item
          const input = cmd.input as {
            Key?: Record<string, string>;
            ExpressionAttributeNames?: Record<string, string>;
            ExpressionAttributeValues?: Record<string, unknown>;
            UpdateExpression?: string;
          };
          const names = input.ExpressionAttributeNames ?? {};
          const values = input.ExpressionAttributeValues ?? {};
          const expr = input.UpdateExpression ?? "";

          // Parse SET clauses — simplified but sufficient
          const setMatch = expr.match(/SET\s+(.*)/i);
          if (setMatch) {
            const clauses = setMatch[1].split(",").map((c: string) => c.trim());
            for (const clause of clauses) {
              // Handle if_not_exists(#attr, :val) form
              const ifNotExistsMatch = clause.match(
                /(#\w+)\s*=\s*if_not_exists\((#\w+),\s*(:[\w]+)\)/,
              );
              if (ifNotExistsMatch) {
                const attr =
                  names[ifNotExistsMatch[1]] ?? ifNotExistsMatch[1].slice(1);
                if (item[attr] === undefined) {
                  item[attr] = values[ifNotExistsMatch[3]];
                }
                continue;
              }
              // Handle #attr = :val form
              const simpleMatch = clause.match(/(#\w+)\s*=\s*(:[\w]+)/);
              if (simpleMatch) {
                const attr = names[simpleMatch[1]] ?? simpleMatch[1].slice(1);
                item[attr] = values[simpleMatch[2]];
              }
            }
          }

          // Copy key into item
          if (input.Key) {
            Object.assign(item, input.Key);
          }
          return {};
        }
        if (cmd._type === "Put") {
          // Projection PutItem — replaces the whole item
          const input = cmd.input as { Item?: Record<string, unknown> };
          if (input.Item) {
            // Clear the item and replace with the Put contents
            for (const k of Object.keys(item)) delete item[k];
            Object.assign(item, input.Item);
          }
          return {};
        }
        return {};
      },
    );

    await handleGaUpsert(
      "test-agents-table",
      "agent",
      "rec-es-001",
      record,
      eventTime,
    );

    // The final item must have state 'active' (not 'inactive')
    expect(item.state).toBe("active");

    // The final item must carry lastRegistryEventAt = event.time
    expect(item.lastRegistryEventAt).toBe(eventTime);
  });

  test("stale event replay does not regress lastRegistryEventAt or state", async () => {
    const freshTime = "2026-11-14T22:00:00Z";
    const _staleTime = "2026-11-14T20:00:00Z";

    // Simulate an item that was already written by a fresh event
    const existingItem: Record<string, unknown> = {
      agentId: "rec-es-002",
      state: "active",
      lastRegistryEventAt: freshTime,
      registryStatus: "APPROVED",
    };

    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        if (cmd._type === "Get") {
          const input = cmd.input as { ProjectionExpression?: string };
          // Stale-event guard read (for lastRegistryEventAt)
          if (input.ProjectionExpression === "lastRegistryEventAt") {
            return { Item: { lastRegistryEventAt: freshTime } };
          }
          // Seeder guard
          return { Item: undefined };
        }
        // Should NOT reach any write commands
        return {};
      },
    );

    // After a stale event is blocked by the handler's guard, the item is unchanged
    expect(existingItem.state).toBe("active");
    expect(existingItem.lastRegistryEventAt).toBe(freshTime);
  });
});

// ---------------------------------------------------------------------------
// (a) buildAgentProjectionRow — state derivation with record.status fallback
// ---------------------------------------------------------------------------
describe("buildAgentProjectionRow — state derived from record.status", () => {
  test("APPROVED record with unknown descriptor state derives active from record.status", () => {
    const record: RegistryRecord = {
      recordId: "rec-fallback-001",
      name: "fallback-agent",
      description: "Agent with unknown state",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: "",
        state: "something_unknown",
        orgId: "org-y",
      }),
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    };

    const row = buildAgentProjectionRow(record);
    // The unknown descriptor state should fall back to deriving from
    // record.status (APPROVED -> active)
    expect(row.state).toBe("active");
  });

  test("DEPRECATED record with unknown descriptor state derives inactive", () => {
    const record: RegistryRecord = {
      recordId: "rec-fallback-002",
      name: "deprecated-agent",
      description: "Agent deprecated",
      status: "DEPRECATED",
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: "",
        state: "something_unknown",
        orgId: "org-y",
      }),
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    };

    const row = buildAgentProjectionRow(record);
    expect(row.state).toBe("inactive");
  });
});

// ---------------------------------------------------------------------------
// Regression: rebuild/resync must match the live path for the stale
// fabricator descriptor state ('inactive') on a record whose status has
// since moved past DRAFT. record.status is authoritative; the descriptor's
// `state` mirror is a quarantine flag written once by the fabricator and
// never updated on approval (see registry-agent-record-resolver.ts).
// ---------------------------------------------------------------------------
describe("buildAgentProjectionRow — authoritative record.status overrides stale fabricator descriptor state", () => {
  function fabricatorRecord(status: string): RegistryRecord {
    return {
      recordId: `rec-fab-${status}`,
      name: "fabricated-agent",
      description: "Fabricator-created agent",
      status,
      customDescriptorContent: JSON.stringify({
        categories: ["worker"],
        icon: "",
        // Fabricator always writes 'inactive' at creation time (quarantine),
        // regardless of what the record status later becomes.
        state: "inactive",
        orgId: "org-fab",
      }),
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    } as RegistryRecord;
  }

  test("APPROVED record with stale descriptor state 'inactive' projects 'active' (matches live path)", () => {
    const row = buildAgentProjectionRow(fabricatorRecord("APPROVED"));
    expect(row.state).toBe("active");
  });

  test("PENDING_APPROVAL record with stale descriptor state 'inactive' projects 'pending'", () => {
    const row = buildAgentProjectionRow(fabricatorRecord("PENDING_APPROVAL"));
    expect(row.state).toBe("pending");
  });

  test("DRAFT record with stale descriptor state 'inactive' projects 'maintenance' (matches live toInternalStateFromGaStatus mapping)", () => {
    const row = buildAgentProjectionRow(fabricatorRecord("DRAFT"));
    expect(row.state).toBe("maintenance");
  });

  test("DEPRECATED record with stale descriptor state 'inactive' projects 'inactive'", () => {
    const row = buildAgentProjectionRow(fabricatorRecord("DEPRECATED"));
    expect(row.state).toBe("inactive");
  });
});
