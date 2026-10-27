/**
 * Tests for backfill-record-org.ts --include-unkinded flag,
 * 'All Organizations' protection, and decision# skip.
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
 */
import {
  DynamoDBDocumentClient,
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
        .resolvesOnce({
          Items: [
            AGENT_KINDED_ABSENT,
            AGENT_UNKINDED_ABSENT,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
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
        .resolvesOnce({ Items: [] })
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
        .resolvesOnce({
          Items: [
            AGENT_KINDED_ABSENT,
            AGENT_UNKINDED_ABSENT,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
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
        .resolvesOnce({ Items: [] })
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
        .resolvesOnce({ Items: [] })
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
        .resolvesOnce({ Items: [agentDecisionKey] })
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
        .resolvesOnce({ Items: [AGENT_ALL_ORGS] })
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
        .resolvesOnce({ Items: [] })
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
        .resolvesOnce({ Items: [AGENT_KINDED_ABSENT] })
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
        .resolvesOnce({
          Items: [AGENT_KINDED_ABSENT, AGENT_UNKINDED_ABSENT],
        })
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

      // Verify the stamped value
      for (const call of updateCalls) {
        const vals = call.args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >;
        expect(vals[":org"]).toBe("Default");
      }
    });
  });
});
