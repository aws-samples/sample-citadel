/**
 * Tests for backend/scripts/lib/seeder-owned-row.ts shared module.
 */
import { isSeederOwnedRow, mergeOnlySeederRow } from "../lib/seeder-owned-row";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// Create a real DDB client for the mock to wrap
const realClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-east-1" }),
);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  jest.spyOn(console, "log").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("isSeederOwnedRow", () => {
  it("returns true for createdBy=seedConfig + projectionVersion present", () => {
    expect(
      isSeederOwnedRow({ createdBy: "seedConfig", projectionVersion: 1 }),
    ).toBe(true);
  });

  it("returns false when createdBy is not seedConfig", () => {
    expect(
      isSeederOwnedRow({ createdBy: "user@example.com", projectionVersion: 1 }),
    ).toBe(false);
  });

  it("returns false when projectionVersion is missing", () => {
    expect(isSeederOwnedRow({ createdBy: "seedConfig" })).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isSeederOwnedRow({})).toBe(false);
  });

  it("returns true when projectionVersion is 0 (falsy but present)", () => {
    // projectionVersion: 0 is still "present" (not null/undefined)
    expect(
      isSeederOwnedRow({ createdBy: "seedConfig", projectionVersion: 0 }),
    ).toBe(true);
  });
});

describe("mergeOnlySeederRow", () => {
  it("writes only timestamp + status fields, never config or orgId", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await mergeOnlySeederRow(
      realClient,
      "test-table",
      { agentId: "mjaKkVyqoFGN" },
      {
        registryStatus: "APPROVED",
        state: "active",
        registryRecordId: "mjaKkVyqoFGN",
        decidedBy: "admin",
      },
      false,
    );

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0].args[0].input;
    const expr = input.UpdateExpression as string;

    // Must include these
    expect(expr).toContain("#updatedAt");
    expect(expr).toContain("#projectedAt");
    expect(expr).toContain("#registryStatus");
    expect(expr).toContain("#state");
    expect(expr).toContain("#registryRecordId");
    expect(expr).toContain("#decidedBy");

    // Must NOT include these
    expect(expr).not.toContain("#config");
    expect(expr).not.toContain("#orgId");
    expect(expr).not.toContain("#citadelKind");
    expect(expr).not.toContain("#projectionVersion");
    expect(expr).not.toContain("#createdBy");
  });

  it("dry-run logs but does not write", async () => {
    await mergeOnlySeederRow(
      realClient,
      "test-table",
      { agentId: "mjaKkVyqoFGN" },
      { registryStatus: "APPROVED" },
      true, // dry-run
    );

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(0);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("seeder-owned: merge-only"),
    );
  });

  it("skips undefined/null source fields from the SET clause", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await mergeOnlySeederRow(
      realClient,
      "test-table",
      { agentId: "test" },
      {
        registryStatus: "DRAFT",
        // decidedBy is undefined — should not appear in SET
      },
      false,
    );

    const calls = ddbMock.commandCalls(UpdateCommand);
    const expr = calls[0].args[0].input.UpdateExpression as string;
    expect(expr).not.toContain("#decidedBy");
    expect(expr).toContain("#registryStatus");
  });
});
