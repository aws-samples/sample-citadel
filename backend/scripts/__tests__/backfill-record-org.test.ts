/**
 * Tests for backfill-record-org.ts --include-unkinded flag,
 * 'All Organizations' protection, decision# skip, and dual-key
 * cache twin resolution (PR #369).
 *
 * Live-shape fixtures derived from actual DynamoDB scans:
 *   - citadel-agents-dev: 75 rows — 12 orgId absent, 54 Default, 9 All Organizations
 *   - citadel-tools-dev: 191 rows — 25 absent (all decision# keys), 165 Default, 1 All Organizations
 *   - NO row has orgId '' or NULL
 *
 * Uses a stateful fake table that honours DynamoDB Limit/FilterExpression
 * semantics: Limit caps *evaluated* items BEFORE the filter, so a
 * `Limit: 1` + FilterExpression scan can return 0 matches even when
 * matching rows exist later in the table. The old per-candidate
 * ScanCommand approach with Limit: 1 was broken by this; the fix
 * builds an in-memory index from the full scan.
 *
 * Covers:
 *   - default (no --include-unkinded): only rows with citadelKind + absent orgId picked up
 *   - --include-unkinded: also considers rows lacking citadelKind whose orgId is absent
 *   - decision# keys are ALWAYS skipped (not records)
 *   - 'All Organizations' rows are NEVER touched regardless of flags
 *   - dry-run prints candidates but writes nothing
 *   - apply stamps only targeted rows
 *   - twin inheritance: recordId-keyed candidate inherits orgId from name-keyed twin
 *   - twin inheritance: name-keyed candidate inherits orgId from recordId-keyed twin
 *   - twin found even when twin is not the first row scanned (stateful fake)
 *   - no twin: candidate gets --org flag value
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

jest.mock("../../src/services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: jest.fn().mockResolvedValue(null),
    getClient: jest.fn(),
    getRegistryId: jest.fn().mockReturnValue("reg-1"),
  })),
}));

import { runBackfillRecordOrg, parseArgs } from "../backfill-record-org";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Stateful fake table (lesson: stateful-fakes-for-lifecycle-apis)
//
// Simulates DynamoDB Scan semantics:
//   - Limit applies to items *evaluated* (BEFORE FilterExpression)
//   - ExclusiveStartKey resumes from a position
//   - FilterExpression applied AFTER Limit
// This proves the old Limit:1 + FilterExpression approach was broken.
// ---------------------------------------------------------------------------

type FakeTableRow = Record<string, unknown>;

function buildFakeTableScanHandler(rows: FakeTableRow[], keyAttr: string) {
  // Returns a function that handles ScanCommand input and returns
  // DynamoDB-like responses with correct Limit/Filter semantics.
  return (input: Record<string, unknown>) => {
    const limit = input.Limit as number | undefined;
    const startKey = input.ExclusiveStartKey as
      Record<string, unknown> | undefined;
    const filterExpr = input.FilterExpression as string | undefined;
    const exprNames = (input.ExpressionAttributeNames ?? {}) as Record<
      string,
      string
    >;
    const exprValues = (input.ExpressionAttributeValues ?? {}) as Record<
      string,
      unknown
    >;

    // Find start position
    let startIdx = 0;
    if (startKey) {
      const startKeyVal = startKey[keyAttr] as string;
      startIdx = rows.findIndex((r) => r[keyAttr] === startKeyVal) + 1;
    }

    // Evaluate up to `limit` items (or all remaining)
    const evalCount = limit ?? rows.length - startIdx;
    const evaluated = rows.slice(startIdx, startIdx + evalCount);

    // Apply filter AFTER limit (this is the DynamoDB behaviour)
    let filtered = evaluated;
    if (filterExpr) {
      filtered = evaluated.filter((item) => {
        return evalFilterExpression(
          filterExpr,
          item,
          exprNames,
          exprValues,
          keyAttr,
        );
      });
    }

    // Pagination: if there are more rows past evaluated range
    const nextIdx = startIdx + evalCount;
    const lastKey =
      nextIdx < rows.length
        ? { [keyAttr]: rows[nextIdx - 1][keyAttr] }
        : undefined;

    return {
      Items: filtered,
      LastEvaluatedKey: lastKey,
      Count: filtered.length,
      ScannedCount: evaluated.length,
    };
  };
}

/**
 * Minimal FilterExpression evaluator for "#n = :name AND #k <> :key".
 */
function evalFilterExpression(
  expr: string,
  item: FakeTableRow,
  names: Record<string, string>,
  values: Record<string, unknown>,
  _keyAttr: string,
): boolean {
  // Split on AND
  const clauses = expr.split(/\s+AND\s+/i);
  for (const clause of clauses) {
    const trimmed = clause.trim();
    // Handle "attr = :val"
    const eqMatch = trimmed.match(/^(#\w+)\s*=\s*(:\w+)$/);
    if (eqMatch) {
      const attr = names[eqMatch[1]] ?? eqMatch[1];
      const val = values[eqMatch[2]];
      if (item[attr] !== val) return false;
      continue;
    }
    // Handle "attr <> :val"
    const neqMatch = trimmed.match(/^(#\w+)\s*<>\s*(:\w+)$/);
    if (neqMatch) {
      const attr = names[neqMatch[1]] ?? neqMatch[1];
      const val = values[neqMatch[2]];
      if (item[attr] === val) return false;
      continue;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Live-shape projection fixtures
// ---------------------------------------------------------------------------

// Agent with citadelKind, orgId absent (orgUnknown: true) — picked up by default
const AGENT_KINDED_ABSENT = {
  agentId: "agent-kinded-absent",
  citadelKind: "agent",
  orgUnknown: true,
  name: "OrphanAgent",
  createdAt: "2026-09-15T10:00:00Z",
};

// Agent WITHOUT citadelKind, orgId absent — picked up ONLY with --include-unkinded
const AGENT_UNKINDED_ABSENT = {
  agentId: "agent-unkinded-absent",
  name: "UnkindedAgent",
  createdAt: "2026-09-14T08:00:00Z",
};

// Agent with orgId 'All Organizations' — NEVER touched
const AGENT_ALL_ORGS = {
  agentId: "agent-all-orgs",
  citadelKind: "agent",
  orgId: "All Organizations",
  name: "SystemAgent",
};

// Agent already scoped — not a candidate
const AGENT_SCOPED = {
  agentId: "agent-scoped",
  citadelKind: "agent",
  orgId: "Default",
  name: "ScopedAgent",
};

// Tool with citadelKind, orgId absent — picked up by default
const TOOL_KINDED_ABSENT = {
  toolId: "tool-kinded-absent",
  citadelKind: "tool",
  orgUnknown: true,
  name: "OrphanTool",
  createdAt: "2026-09-15T11:00:00Z",
};

// decision# bookkeeping row — ALWAYS skipped (live: all 25 absent-orgId tool rows are decision#)
const TOOL_DECISION_KEY = {
  toolId: "decision#dec-abc-123",
  name: "Decision Record",
  createdAt: "2026-09-10T00:00:00Z",
};

// Tool with orgId 'All Organizations' — NEVER touched
const TOOL_ALL_ORGS = {
  toolId: "tool-all-orgs",
  citadelKind: "tool",
  orgId: "All Organizations",
  name: "SystemTool",
};

// Tool WITHOUT citadelKind, orgId absent, NOT decision# — only with --include-unkinded
const TOOL_UNKINDED_ABSENT = {
  toolId: "tool-unkinded-absent",
  name: "UnkindedTool",
  createdAt: "2026-09-12T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Dual-key cache twin fixtures (PR #369)
// ---------------------------------------------------------------------------

// RecordId-keyed candidate (UUID-like key, orgId absent)
const AGENT_RECORDID_KEYED_ORPHAN = {
  agentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  name: "fabricator",
  createdAt: "2026-09-15T10:00:00Z",
  // no citadelKind, no orgId
};

// Name-keyed twin with orgId 'All Organizations' (not an orphan — has orgId)
const AGENT_NAME_KEYED_TWIN_ALLORGS = {
  agentId: "fabricator",
  name: "fabricator",
  orgId: "All Organizations",
  createdAt: "2026-09-14T09:00:00Z",
};

// Name-keyed candidate (orgId absent)
const AGENT_NAME_KEYED_ORPHAN = {
  agentId: "demo-echo-agent",
  name: "demo-echo-agent",
  createdAt: "2026-09-14T09:00:00Z",
  // no citadelKind, no orgId
};

// RecordId-keyed twin with orgId 'All Organizations' (not an orphan — has orgId)
const AGENT_RECORDID_KEYED_TWIN_ALLORGS = {
  agentId: "f1a2b3c4-d5e6-7890-abcd-000011112222",
  name: "demo-echo-agent",
  orgId: "All Organizations",
  createdAt: "2026-09-14T08:00:00Z",
};

// Agent with no twin anywhere
const AGENT_NO_TWIN = {
  agentId: "smoke-idempotency-agent",
  name: "smoke-idempotency-agent",
  createdAt: "2026-09-13T12:00:00Z",
  // no citadelKind, no orgId
};

describe("backfill-record-org", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  describe("parseArgs", () => {
    it("parses --include-unkinded flag", () => {
      const result = parseArgs([
        "--org",
        "Acme",
        "--registry-id",
        "reg-1",
        "--table-agents",
        "agents",
        "--table-tools",
        "tools",
        "--include-unkinded",
      ]);
      expect(result.includeUnkinded).toBe(true);
    });

    it("includeUnkinded defaults to false", () => {
      const result = parseArgs([
        "--org",
        "Acme",
        "--registry-id",
        "reg-1",
        "--table-agents",
        "agents",
        "--table-tools",
        "tools",
      ]);
      expect(result.includeUnkinded).toBe(false);
    });
  });

  describe("default (no --include-unkinded)", () => {
    it("picks up kinded rows with absent orgId but NOT unkinded rows", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table full scan (returns ALL rows)
        .resolvesOnce({
          Items: [
            AGENT_KINDED_ABSENT,
            AGENT_UNKINDED_ABSENT,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
        // Scan #2: tool table full scan
        .resolvesOnce({ Items: [] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        false,
      );

      // Only the kinded+absent agent is picked up.
      expect(counters.agentProjectionUpdated).toBe(1);
    });

    it("skips unkinded tool rows and decision# keys without the flag", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table full scan
        .resolvesOnce({ Items: [] })
        // Scan #2: tool table full scan
        .resolvesOnce({
          Items: [TOOL_DECISION_KEY, TOOL_UNKINDED_ABSENT, TOOL_ALL_ORGS],
        });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        false,
      );

      expect(counters.toolProjectionUpdated).toBe(0);
    });
  });

  describe("--include-unkinded", () => {
    it("picks up unkinded agent rows with absent orgId", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table full scan (ALL rows including org'd ones)
        .resolvesOnce({
          Items: [
            AGENT_KINDED_ABSENT,
            AGENT_UNKINDED_ABSENT,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
        // Scan #2: tool table full scan
        .resolvesOnce({ Items: [] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        true,
      );

      // Both kinded+absent and unkinded+absent should be picked up.
      expect(counters.agentProjectionUpdated).toBe(2);
    });

    it("picks up unkinded tool rows but still skips decision# keys", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table full scan
        .resolvesOnce({ Items: [] })
        // Scan #2: tool table full scan
        .resolvesOnce({
          Items: [TOOL_DECISION_KEY, TOOL_UNKINDED_ABSENT, TOOL_ALL_ORGS],
        });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        true,
      );

      // Unkinded tool picked up; decision# and All Organizations skipped.
      expect(counters.toolProjectionUpdated).toBe(1);
    });
  });

  describe("decision# keys always skipped", () => {
    it("never touches decision# tool rows even with --include-unkinded", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table
        .resolvesOnce({ Items: [] })
        // Scan #2: tool table
        .resolvesOnce({ Items: [TOOL_DECISION_KEY] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.toolProjectionUpdated).toBe(0);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it("never touches decision# agent rows even with --include-unkinded", async () => {
      const agentDecisionKey = {
        agentId: "decision#dec-xyz-789",
        name: "Agent Decision",
      };
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table
        .resolvesOnce({ Items: [agentDecisionKey] })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(0);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("All Organizations protection", () => {
    it("never touches agent rows with orgId 'All Organizations'", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table
        .resolvesOnce({ Items: [AGENT_ALL_ORGS] })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(0);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it("never touches tool rows with orgId 'All Organizations'", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table
        .resolvesOnce({ Items: [] })
        // Scan #2: tool table
        .resolvesOnce({ Items: [TOOL_ALL_ORGS] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.toolProjectionUpdated).toBe(0);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("dry-run writes nothing", () => {
    it("reports counts but sends no UpdateCommands", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table
        .resolvesOnce({ Items: [AGENT_KINDED_ABSENT] })
        // Scan #2: tool table
        .resolvesOnce({ Items: [TOOL_KINDED_ABSENT] });

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        false,
      );

      expect(counters.agentProjectionUpdated).toBe(1);
      expect(counters.toolProjectionUpdated).toBe(1);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("apply stamps targeted rows", () => {
    it("sends UpdateCommands for orphaned rows in apply mode", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table (ALL rows)
        .resolvesOnce({
          Items: [AGENT_KINDED_ABSENT, AGENT_UNKINDED_ABSENT],
        })
        // Scan #2: tool table (ALL rows)
        .resolvesOnce({
          Items: [TOOL_KINDED_ABSENT, TOOL_DECISION_KEY, TOOL_UNKINDED_ABSENT],
        });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      // Agent: kinded+absent + unkinded+absent = 2
      // Tool: kinded+absent + unkinded+absent = 2 (decision# skipped)
      expect(counters.agentProjectionUpdated).toBe(2);
      expect(counters.toolProjectionUpdated).toBe(2);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(4);

      // Verify the stamped value (no twins → all get --org flag)
      for (const call of updateCalls) {
        const vals = call.args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >;
        expect(vals[":org"]).toBe("Default");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Dual-key cache twin resolution (PR #369)
  // -------------------------------------------------------------------------

  describe("twin inheritance", () => {
    it("recordId-keyed candidate inherits orgId from name-keyed twin via index", async () => {
      // Full scan returns ALL rows including the twin with orgId set.
      // The index-based approach finds the twin without a separate GetCommand.
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — ALL rows (twin has orgId, is included)
        .resolvesOnce({
          Items: [AGENT_RECORDID_KEYED_ORPHAN, AGENT_NAME_KEYED_TWIN_ALLORGS],
        })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      // The recordId-keyed orphan is the only candidate (twin has orgId)
      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      // Should inherit 'All Organizations' from the twin, not the flag 'Default'
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("All Organizations");

      // No GetCommand fallback needed — resolved from in-memory index
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it("name-keyed candidate inherits orgId from recordId-keyed twin via index", async () => {
      // Both the orphan and its twin are in the full scan.
      // The index finds the twin by name without a separate scan.
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — ALL rows
        .resolvesOnce({
          Items: [AGENT_NAME_KEYED_ORPHAN, AGENT_RECORDID_KEYED_TWIN_ALLORGS],
        })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      // Should inherit 'All Organizations' from the twin
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("All Organizations");
    });

    it("candidate with no twin gets --org flag value", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — orphan with no twin anywhere
        .resolvesOnce({ Items: [AGENT_NO_TWIN] })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      // No twin → stamped with --org flag
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("Default");
    });

    it("dry-run prints resolved orgId and source for each candidate", async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — ALL rows including twins
        .resolvesOnce({
          Items: [
            AGENT_RECORDID_KEYED_ORPHAN,
            AGENT_NAME_KEYED_TWIN_ALLORGS,
            AGENT_NO_TWIN,
          ],
        })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });

      await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        true,
      );

      const dryRunLogs = logSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((s) => s.startsWith("[DRY-RUN]"));

      // recordId-keyed orphan: twin found → source=twin, orgId=All Organizations
      expect(dryRunLogs[0]).toContain("orgId=All Organizations");
      expect(dryRunLogs[0]).toContain("source=twin");

      // no-twin orphan: → source=flag, orgId=Default
      expect(dryRunLogs[1]).toContain("orgId=Default");
      expect(dryRunLogs[1]).toContain("source=flag");

      logSpy.mockRestore();
    });

    it("decision# keys are still excluded even when twins exist", async () => {
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — decision key still skipped
        .resolvesOnce({
          Items: [
            { agentId: "decision#dec-999", name: "DecisionAgent" },
            AGENT_NO_TWIN,
          ],
        })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      // Only the non-decision agent is updated
      expect(counters.agentProjectionUpdated).toBe(1);
      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0].args[0].input.Key).toEqual({
        agentId: "smoke-idempotency-agent",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Stateful fake: proves old Limit:1 + FilterExpression was broken
  // -------------------------------------------------------------------------

  describe("stateful fake — twin found when not the first row scanned", () => {
    it("finds twin even when many non-matching rows precede it in scan order", async () => {
      // Scenario: name-keyed candidate "demo-echo-agent" has a twin
      // (recordId-keyed, with orgId) that appears AFTER several
      // non-matching rows. With the old Limit:1 + FilterExpression
      // approach, the first evaluated row wouldn't match the filter,
      // returning 0 results and falling back to --org flag.
      //
      // The in-memory index approach reads ALL rows and always finds it.

      // These filler rows come BEFORE the twin in scan order.
      const filler1 = {
        agentId: "aaaa-1111",
        name: "filler-one",
        orgId: "Default",
      };
      const filler2 = {
        agentId: "bbbb-2222",
        name: "filler-two",
        orgId: "Default",
      };
      const filler3 = {
        agentId: "cccc-3333",
        name: "filler-three",
        orgId: "Default",
      };

      // The twin we need to find — appears AFTER the fillers
      const twinRow = {
        agentId: "dddd4444-e5f6-7890-abcd-000099998888",
        name: "demo-echo-agent",
        orgId: "All Organizations",
      };

      // The candidate (name-keyed, no orgId)
      const candidate = {
        agentId: "demo-echo-agent",
        name: "demo-echo-agent",
        // no orgId
      };

      // All rows in the table, in scan order.
      // The twin is at position 4, after 3 fillers and the candidate.
      const allRows = [filler1, filler2, candidate, filler3, twinRow];

      // Verify the stateful fake demonstrates the old Limit:1 bug:
      const fakeHandler = buildFakeTableScanHandler(allRows, "agentId");
      const limitedResult = fakeHandler({
        FilterExpression: "#n = :name AND #k <> :key",
        ExpressionAttributeNames: { "#n": "name", "#k": "agentId" },
        ExpressionAttributeValues: {
          ":name": "demo-echo-agent",
          ":key": "demo-echo-agent",
        },
        Limit: 1,
      });
      // Old approach: Limit:1 evaluates ONLY filler1, which doesn't
      // match the filter → 0 results. Twin is missed!
      expect(limitedResult.Items).toHaveLength(0);

      // Now verify the full-scan index approach finds the twin:
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — ALL rows
        .resolvesOnce({ Items: allRows })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      // candidate is the only orphan
      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      // Twin found via index → inherits 'All Organizations'
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("All Organizations");
    });

    it("proves recordId-keyed twin also found from index regardless of scan position", async () => {
      // Scenario: recordId-keyed candidate "fabricator" UUID has a
      // name-keyed twin (agentId=fabricator, with orgId) that appears
      // after several filler rows. The full-scan index finds it.

      const filler1 = {
        agentId: "xx-filler-1",
        name: "other-agent-1",
        orgId: "Default",
      };
      const filler2 = {
        agentId: "xx-filler-2",
        name: "other-agent-2",
        orgId: "Default",
      };

      // The twin (name-keyed, with orgId)
      const twinRow = {
        agentId: "fabricator",
        name: "fabricator",
        orgId: "All Organizations",
      };

      // The candidate (recordId-keyed, no orgId)
      const candidate = {
        agentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        name: "fabricator",
        // no orgId
      };

      const allRows = [filler1, candidate, filler2, twinRow];

      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — ALL rows
        .resolvesOnce({ Items: allRows })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      // Twin found → inherits 'All Organizations'
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("All Organizations");

      // No per-candidate GetCommand or ScanCommand for twin lookup
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it("smoke-idempotency-agent gets flag when no twin exists at any scan position", async () => {
      // No twin in any position → falls back to --org flag.
      const filler1 = {
        agentId: "zz-filler-1",
        name: "unrelated-1",
        orgId: "Default",
      };
      const filler2 = {
        agentId: "zz-filler-2",
        name: "unrelated-2",
        orgId: "Default",
      };

      const candidate = {
        agentId: "smoke-idempotency-agent",
        name: "smoke-idempotency-agent",
        // no orgId
      };

      const allRows = [filler1, candidate, filler2];

      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — ALL rows
        .resolvesOnce({ Items: allRows })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("Default");
    });
  });
});
