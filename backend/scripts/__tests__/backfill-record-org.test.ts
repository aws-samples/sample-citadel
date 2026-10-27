/**
 * Tests for backfill-record-org.ts --include-empty flag and
 * 'All Organizations' protection.
 *
 * Covers:
 *   - default (no --include-empty): orgId '' rows are NOT picked up
 *   - --include-empty: orgId '' rows ARE picked up
 *   - 'All Organizations' rows are NEVER touched regardless of flags
 *   - dry-run writes nothing
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

// Live-shape projection fixtures
const AGENT_ORPHAN_ABSENT = {
  agentId: "agent-orphan-absent",
  citadelKind: "agent",
  orgUnknown: true,
  name: "OrphanAgent",
};
const AGENT_ORPHAN_EMPTY = {
  agentId: "agent-orphan-empty",
  citadelKind: "agent",
  orgId: "",
  name: "EmptyOrgAgent",
};
const AGENT_ALL_ORGS = {
  agentId: "agent-all-orgs",
  citadelKind: "agent",
  orgId: "All Organizations",
  name: "SystemAgent",
};
const AGENT_SCOPED = {
  agentId: "agent-scoped",
  citadelKind: "agent",
  orgId: "Acme",
  name: "ScopedAgent",
};
const TOOL_ORPHAN_EMPTY = {
  toolId: "tool-orphan-empty",
  citadelKind: "tool",
  orgId: "",
  name: "EmptyOrgTool",
};
const TOOL_ALL_ORGS = {
  toolId: "tool-all-orgs",
  citadelKind: "tool",
  orgId: "All Organizations",
  name: "SystemTool",
};

describe("backfill-record-org", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  describe("parseArgs", () => {
    it("parses --include-empty flag", () => {
      const result = parseArgs([
        "--org",
        "Acme",
        "--registry-id",
        "reg-1",
        "--table-agents",
        "agents",
        "--table-tools",
        "tools",
        "--include-empty",
      ]);
      expect(result.includeEmpty).toBe(true);
    });

    it("includeEmpty defaults to false", () => {
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
      expect(result.includeEmpty).toBe(false);
    });
  });

  describe("default (no --include-empty)", () => {
    it("picks up orgUnknown/absent rows but NOT empty-string rows", async () => {
      // Agents table: one absent, one empty, one 'All Organizations', one scoped
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [
            AGENT_ORPHAN_ABSENT,
            AGENT_ORPHAN_EMPTY,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
        .resolvesOnce({
          Items: [],
        });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        false,
      );

      // Only the absent/orgUnknown agent is picked up.
      // Empty string should NOT be picked up without --include-empty.
      expect(counters.agentProjectionUpdated).toBe(1);
    });

    it("does not touch empty-string tool rows without --include-empty", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({
          Items: [TOOL_ORPHAN_EMPTY, TOOL_ALL_ORGS],
        });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        false,
      );

      expect(counters.toolProjectionUpdated).toBe(0);
    });
  });

  describe("--include-empty", () => {
    it("picks up empty-string agent rows", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [
            AGENT_ORPHAN_ABSENT,
            AGENT_ORPHAN_EMPTY,
            AGENT_ALL_ORGS,
            AGENT_SCOPED,
          ],
        })
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        true,
      );

      // Both absent/orgUnknown and empty-string should be picked up.
      expect(counters.agentProjectionUpdated).toBe(2);
    });

    it("picks up empty-string tool rows", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({
          Items: [TOOL_ORPHAN_EMPTY, TOOL_ALL_ORGS],
        });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        true,
      );

      expect(counters.toolProjectionUpdated).toBe(1);
    });
  });

  describe("All Organizations protection", () => {
    it("never touches agent rows with orgId 'All Organizations'", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [AGENT_ALL_ORGS] })
        .resolvesOnce({ Items: [] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
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
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
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
        .resolvesOnce({ Items: [AGENT_ORPHAN_ABSENT] })
        .resolvesOnce({ Items: [] });

      const counters = await runBackfillRecordOrg(
        "Acme",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        true,
        true,
      );

      expect(counters.agentProjectionUpdated).toBe(1);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("apply stamps targeted rows", () => {
    it("sends UpdateCommands for orphaned rows in apply mode", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({ Items: [AGENT_ORPHAN_ABSENT, AGENT_ORPHAN_EMPTY] })
        .resolvesOnce({ Items: [TOOL_ORPHAN_EMPTY] });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillRecordOrg(
        "Acme",
        "reg-1",
        "agents-tbl",
        "tools-tbl",
        false,
        true,
      );

      // Agent: absent + empty = 2; Tool: empty = 1
      expect(counters.agentProjectionUpdated).toBe(2);
      expect(counters.toolProjectionUpdated).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(3);

      // Verify the stamped value
      for (const call of updateCalls) {
        const vals = call.args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >;
        expect(vals[":org"]).toBe("Acme");
      }
    });
  });
});
