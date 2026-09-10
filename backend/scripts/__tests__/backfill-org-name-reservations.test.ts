/**
 * Tests for backend/scripts/backfill-org-name-reservations.ts (finding
 * 003a9234, mechanism 2).
 *
 * Covers:
 *   - grouping logic (unique vs collision names) is pure and correct
 *   - the backfill is idempotent: re-running finds nothing new to write
 *     for a name already reserved
 *   - a pre-existing duplicate name is REPORTED (non-zero collisions,
 *     non-zero exit code path) and NEVER silently collapsed — no
 *     reservation is written for a colliding name, and no org is picked
 *     as a winner
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  nameReservationKey,
  groupOrgsByName,
  scanOrganizationRows,
  reserveOrgName,
  runBackfill,
  type OrgRow,
} from "../backfill-org-name-reservations";

const ddbMock = mockClient(DynamoDBDocumentClient);

/** Builds a ConditionalCheckFailedException the same way AWS SDK v3 does. */
function conditionalCheckFailed(): Error {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

describe("nameReservationKey", () => {
  test("mirrors organization-resolver.ts's NAME#<name> derivation", () => {
    expect(nameReservationKey("Default")).toBe("NAME#Default");
    expect(nameReservationKey("My Org")).toBe("NAME#My Org");
  });
});

describe("groupOrgsByName", () => {
  test("groups a name held by exactly one org as unique", () => {
    const orgs: OrgRow[] = [
      { orgId: "org-000", name: "Default" },
      { orgId: "org-001", name: "Engineering" },
    ];
    const { unique, collisions } = groupOrgsByName(orgs);
    expect(unique.size).toBe(2);
    expect(unique.get("Default")).toEqual({
      orgId: "org-000",
      name: "Default",
    });
    expect(collisions.size).toBe(0);
  });

  test("groups a name held by 2+ orgs as a collision, not a unique winner", () => {
    const orgs: OrgRow[] = [
      { orgId: "org-000", name: "Default" },
      { orgId: "org-999", name: "Default" },
      { orgId: "org-001", name: "Engineering" },
    ];
    const { unique, collisions } = groupOrgsByName(orgs);
    expect(unique.size).toBe(1);
    expect(unique.has("Default")).toBe(false);
    expect(collisions.size).toBe(1);
    expect(collisions.get("Default")).toEqual([
      { orgId: "org-000", name: "Default" },
      { orgId: "org-999", name: "Default" },
    ]);
  });

  test("handles an empty org list", () => {
    const { unique, collisions } = groupOrgsByName([]);
    expect(unique.size).toBe(0);
    expect(collisions.size).toBe(0);
  });
});

describe("scanOrganizationRows", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  test("excludes NAME# reservation/tombstone rows via attribute_not_exists(itemType)", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { orgId: "org-000", name: "Default" },
        {
          orgId: "NAME#Default",
          itemType: "name_reservation",
          name: "Default",
        },
      ],
    });

    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const rows = await scanOrganizationRows(docClient, "test-orgs");

    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls[0].args[0].input.FilterExpression).toBe(
      "attribute_not_exists(itemType)",
    );
    // Only the mock's static resolves is exercised (no client-side
    // filtering here — production DynamoDB applies the FilterExpression;
    // this test pins the request shape sent to it).
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("paginates via LastEvaluatedKey/ExclusiveStartKey", async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ orgId: "org-000", name: "Default" }],
        LastEvaluatedKey: { orgId: "org-000" },
      })
      .resolvesOnce({
        Items: [{ orgId: "org-001", name: "Engineering" }],
      });

    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const rows = await scanOrganizationRows(docClient, "test-orgs");

    expect(rows).toEqual([
      { orgId: "org-000", name: "Default" },
      { orgId: "org-001", name: "Engineering" },
    ]);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });
});

describe("reserveOrgName", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  test("writes a conditional PutCommand and returns true on success", async () => {
    ddbMock.on(PutCommand).resolves({});
    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

    const wroteNew = await reserveOrgName(docClient, "test-orgs", {
      orgId: "org-000",
      name: "Default",
    });

    expect(wroteNew).toBe(true);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item).toMatchObject({
      orgId: "NAME#Default",
      itemType: "name_reservation",
      name: "Default",
      reservedOrgId: "org-000",
    });
    expect(putCalls[0].args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(orgId)",
    );
  });

  // IDEMPOTENCY: calling twice must be safe. The second call hits the
  // ConditionalCheckFailedException path and returns false rather than
  // throwing.
  test("is idempotent — a pre-existing reservation causes false, not an error", async () => {
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());
    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

    const wroteNew = await reserveOrgName(docClient, "test-orgs", {
      orgId: "org-000",
      name: "Default",
    });

    expect(wroteNew).toBe(false);
  });

  test("propagates a non-conditional error", async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new Error("ProvisionedThroughputExceededException"));
    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

    await expect(
      reserveOrgName(docClient, "test-orgs", {
        orgId: "org-000",
        name: "Default",
      }),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});

describe("runBackfill", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  test("apply mode reserves every unique name and reports zero collisions", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { orgId: "org-000", name: "Default" },
        { orgId: "org-001", name: "Engineering" },
      ],
    });
    ddbMock.on(PutCommand).resolves({});

    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const summary = await runBackfill(docClient, "test-orgs", true);

    expect(summary.scanned).toBe(2);
    expect(summary.uniqueNames).toBe(2);
    expect(summary.reserved).toBe(2);
    expect(summary.alreadyReserved).toBe(0);
    expect(summary.collisions).toEqual([]);
    expect(summary.errors).toBe(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
  });

  // IDEMPOTENCY at the whole-backfill level: re-running when every name is
  // already reserved writes nothing new and reports alreadyReserved, not
  // errors.
  test("is idempotent — re-running when reservations already exist writes nothing new", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ orgId: "org-000", name: "Default" }],
    });
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());

    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const summary = await runBackfill(docClient, "test-orgs", true);

    expect(summary.reserved).toBe(0);
    expect(summary.alreadyReserved).toBe(1);
    expect(summary.errors).toBe(0);
  });

  // THE COLLISION CONTRACT: a pre-existing duplicate name must be REPORTED,
  // not resolved. No PutCommand must ever be issued for the colliding name,
  // and the summary must surface it distinctly from a successful reservation.
  test("reports a pre-existing duplicate name as a collision and does NOT write a reservation for it", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { orgId: "org-000", name: "Default" },
        { orgId: "org-999", name: "Default" },
        { orgId: "org-001", name: "Engineering" },
      ],
    });
    ddbMock.on(PutCommand).resolves({});

    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const summary = await runBackfill(docClient, "test-orgs", true);

    expect(summary.collisions).toEqual([
      { name: "Default", orgIds: ["org-000", "org-999"] },
    ]);
    // Only "Engineering" (the unique name) was reserved.
    expect(summary.reserved).toBe(1);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item).toMatchObject({
      name: "Engineering",
    });
    // No Put was ever attempted for the colliding "Default" name.
    const defaultPut = putCalls.find(
      (c) =>
        (c.args[0].input.Item as Record<string, unknown>).name === "Default",
    );
    expect(defaultPut).toBeUndefined();
  });

  test("dry-run mode never writes and still reports collisions", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { orgId: "org-000", name: "Default" },
        { orgId: "org-999", name: "Default" },
      ],
    });

    const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const summary = await runBackfill(docClient, "test-orgs", false);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(summary.collisions).toEqual([
      { name: "Default", orgIds: ["org-000", "org-999"] },
    ]);
  });
});
