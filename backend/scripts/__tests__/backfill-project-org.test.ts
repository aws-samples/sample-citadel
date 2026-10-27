/**
 * Tests for backfill-project-org.ts
 *
 * Covers:
 *   - dry-run writes nothing
 *   - apply stamps only rows with absent/empty organization
 *   - rows with existing organization are skipped
 *   - ConditionalCheckFailedException treated as already-scoped
 *   - genuine errors tracked in failed count
 *   - pagination via LastEvaluatedKey
 *   - items without id are skipped
 */
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { runBackfillProjectOrg, parseArgs } from "../backfill-project-org";

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe("backfill-project-org", () => {
  beforeEach(() => {
    dynamoMock.reset();
  });

  describe("parseArgs", () => {
    it("parses --org and --table correctly", () => {
      const result = parseArgs(["--org", "Acme", "--table", "my-projects"]);
      expect(result).toEqual({
        org: "Acme",
        table: "my-projects",
        dryRun: true,
      });
    });

    it("--apply sets dryRun to false", () => {
      const result = parseArgs(["--org", "Acme", "--table", "tbl", "--apply"]);
      expect(result.dryRun).toBe(false);
    });

    it("--dry-run explicitly sets dryRun to true", () => {
      const result = parseArgs([
        "--org",
        "Acme",
        "--table",
        "tbl",
        "--apply",
        "--dry-run",
      ]);
      expect(result.dryRun).toBe(true);
    });
  });

  describe("dry-run mode", () => {
    it("scans but writes nothing", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { id: "proj-1" },
          { id: "proj-2", organization: null },
          { id: "proj-3", organization: "" },
        ],
      });

      const counters = await runBackfillProjectOrg("Acme", "tbl", true);

      expect(counters.scanned).toBe(3);
      expect(counters.updated).toBe(3);
      expect(counters.failed).toBe(0);
      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("apply mode", () => {
    it("stamps only rows with absent/empty/null organization", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { id: "proj-missing" },
          { id: "proj-null", organization: null },
          { id: "proj-empty", organization: "" },
          { id: "proj-scoped", organization: "ExistingOrg" },
        ],
      });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillProjectOrg("Acme", "tbl", false);

      expect(counters.scanned).toBe(4);
      expect(counters.updated).toBe(3);
      expect(counters.skipped).toBe(1);
      expect(counters.failed).toBe(0);

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(3);

      const updatedIds = updateCalls.map(
        (c) => (c.args[0].input.Key as { id: string }).id,
      );
      expect(updatedIds.sort()).toEqual([
        "proj-empty",
        "proj-missing",
        "proj-null",
      ]);

      // Verify the stamped value
      for (const call of updateCalls) {
        const vals = call.args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >;
        expect(vals[":org"]).toBe("Acme");
      }
    });

    it("paginates through LastEvaluatedKey", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [{ id: "proj-p1" }],
          LastEvaluatedKey: { id: "proj-p1" },
        })
        .resolvesOnce({
          Items: [{ id: "proj-p2" }],
        });
      dynamoMock.on(UpdateCommand).resolves({});

      const counters = await runBackfillProjectOrg("Acme", "tbl", false);

      expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(2);
      expect(counters.updated).toBe(2);
    });

    it("treats ConditionalCheckFailedException as already-scoped", async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [{ id: "proj-race" }] });
      const conflict = new Error("The conditional request failed");
      conflict.name = "ConditionalCheckFailedException";
      dynamoMock.on(UpdateCommand).rejects(conflict);

      const counters = await runBackfillProjectOrg("Acme", "tbl", false);

      expect(counters.updated).toBe(0);
      expect(counters.skipped).toBe(1);
      expect(counters.failed).toBe(0);
    });

    it("tracks genuine errors in failed count", async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [{ id: "proj-broken" }] });
      dynamoMock
        .on(UpdateCommand)
        .rejects(new Error("ProvisionedThroughputExceededException"));

      const counters = await runBackfillProjectOrg("Acme", "tbl", false);

      expect(counters.updated).toBe(0);
      expect(counters.failed).toBe(1);
    });

    it("skips items without an id", async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [{ notAnId: "x" }] });

      const counters = await runBackfillProjectOrg("Acme", "tbl", false);

      expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(counters.skipped).toBe(1);
    });
  });
});
