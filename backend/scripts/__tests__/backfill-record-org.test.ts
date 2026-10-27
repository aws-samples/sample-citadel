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
 * Covers:
 *   - default (no --include-unkinded): only rows with citadelKind + absent orgId picked up
 *   - --include-unkinded: also considers rows lacking citadelKind whose orgId is absent
 *   - decision# keys are ALWAYS skipped (not records)
 *   - 'All Organizations' rows are NEVER touched regardless of flags
 *   - dry-run prints candidates but writes nothing
 *   - apply stamps only targeted rows
 *   - twin inheritance: recordId-keyed candidate inherits orgId from name-keyed twin
 *   - twin inheritance: name-keyed candidate inherits orgId from recordId-keyed twin
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

// Helper: build a default twin-lookup-miss ScanCommand response
const EMPTY_SCAN = { Items: [] };

describe("backfill-record-org", () => {
  beforeEach(() => {
    dynamoMock.reset();
    // Default: twin lookups via GetCommand return nothing (no twin found)
    dynamoMock.on(GetCommand).resolves({ Item: undefined });
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
        // Scan #1: agent table full scan
        .resolvesOnce({
          Items: [
            AGENT_KINDED_ABSENT,
            AGENT_UNKINDED_ABSENT,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
        // Scan #2: twin lookup for AGENT_KINDED_ABSENT (name-keyed, no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: tool table full scan
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
        // Scan #1: agent table full scan
        .resolvesOnce({
          Items: [
            AGENT_KINDED_ABSENT,
            AGENT_UNKINDED_ABSENT,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
        // Scan #2: twin lookup for AGENT_KINDED_ABSENT (name-keyed, no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: twin lookup for AGENT_UNKINDED_ABSENT (name-keyed, no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #4: tool table full scan
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
        })
        // Scan #3: twin lookup for TOOL_UNKINDED_ABSENT (name-keyed, no twin)
        .resolvesOnce(EMPTY_SCAN);

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
        // Scan #2: twin lookup for AGENT_KINDED_ABSENT (no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: tool table
        .resolvesOnce({ Items: [TOOL_KINDED_ABSENT] })
        // Scan #4: twin lookup for TOOL_KINDED_ABSENT (no twin)
        .resolvesOnce(EMPTY_SCAN);

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
        // Scan #1: agent table
        .resolvesOnce({
          Items: [AGENT_KINDED_ABSENT, AGENT_UNKINDED_ABSENT],
        })
        // Scan #2: twin lookup for AGENT_KINDED_ABSENT (no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: twin lookup for AGENT_UNKINDED_ABSENT (no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #4: tool table
        .resolvesOnce({
          Items: [TOOL_KINDED_ABSENT, TOOL_DECISION_KEY, TOOL_UNKINDED_ABSENT],
        })
        // Scan #5: twin lookup for TOOL_KINDED_ABSENT (no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #6: twin lookup for TOOL_UNKINDED_ABSENT (no twin)
        .resolvesOnce(EMPTY_SCAN);
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
    it("recordId-keyed candidate inherits orgId from name-keyed twin via GetCommand", async () => {
      // The recordId-keyed orphan (fabricator) should look up its name-keyed
      // twin via GetCommand(key=fabricator) and find 'All Organizations'.
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — only the recordId-keyed orphan is a candidate
        .resolvesOnce({
          Items: [AGENT_RECORDID_KEYED_ORPHAN, AGENT_NAME_KEYED_TWIN_ALLORGS],
        })
        // Scan #2: tool table
        .resolvesOnce({ Items: [] });
      // GetCommand for twin lookup: return the name-keyed twin
      dynamoMock
        .on(GetCommand)
        .resolves({ Item: AGENT_NAME_KEYED_TWIN_ALLORGS });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Default",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      // The recordId-keyed orphan is the only candidate (twin has orgId, skipped by scan)
      expect(counters.agentProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      // Should inherit 'All Organizations' from the twin, not the flag 'Default'
      const vals = updateCalls[0].args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[":org"]).toBe("All Organizations");
    });

    it("name-keyed candidate inherits orgId from recordId-keyed twin via scan fallback", async () => {
      // The name-keyed orphan (demo-echo-agent) should find its recordId-keyed
      // twin via the ScanCommand fallback (twin not in orphan list).
      dynamoMock
        .on(ScanCommand)
        // Scan #1: agent table — only the name-keyed orphan
        .resolvesOnce({ Items: [AGENT_NAME_KEYED_ORPHAN] })
        // Scan #2: twin lookup for name-keyed candidate — returns the recordId-keyed twin
        .resolvesOnce({ Items: [AGENT_RECORDID_KEYED_TWIN_ALLORGS] })
        // Scan #3: tool table
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
        // Scan #2: twin lookup for name-keyed candidate — no twin found
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: tool table
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
        // Scan #1: agent table
        .resolvesOnce({
          Items: [AGENT_RECORDID_KEYED_ORPHAN, AGENT_NO_TWIN],
        })
        // Scan #2: twin lookup for AGENT_NO_TWIN (name-keyed, no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: tool table
        .resolvesOnce({ Items: [] });
      // GetCommand for recordId-keyed twin lookup → finds twin with All Orgs
      dynamoMock
        .on(GetCommand)
        .resolvesOnce({ Item: AGENT_NAME_KEYED_TWIN_ALLORGS });

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
        // Scan #2: twin lookup for AGENT_NO_TWIN (no twin)
        .resolvesOnce(EMPTY_SCAN)
        // Scan #3: tool table
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
});
