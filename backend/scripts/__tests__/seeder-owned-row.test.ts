/**
 * Tests for backend/scripts/lib/seeder-owned-row.ts shared module.
 */
import {
  isSeederOwnedRow,
  mergeOnlySeederRow,
  type SeederContext,
} from "../lib/seeder-owned-row";
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

  // Pointer-based detection (condition 2)
  it("returns true for damaged row lacking createdBy but referenced by a pointer", () => {
    const ctx: SeederContext = {
      pointerTargetIds: new Set(["mjaKkVyqoFGN"]),
    };
    // Row has NO createdBy but its agentId is in the pointer set
    expect(
      isSeederOwnedRow({ agentId: "mjaKkVyqoFGN", projectionVersion: 1 }, ctx),
    ).toBe(true);
  });

  it("returns true for damaged row with toolId referenced by a pointer", () => {
    const ctx: SeederContext = {
      pointerTargetIds: new Set(["tool123"]),
    };
    expect(
      isSeederOwnedRow({ toolId: "tool123", projectionVersion: 1 }, ctx),
    ).toBe(true);
  });

  it("returns false when agentId is NOT in pointer set", () => {
    const ctx: SeederContext = {
      pointerTargetIds: new Set(["other-id"]),
    };
    expect(
      isSeederOwnedRow({ agentId: "mjaKkVyqoFGN", projectionVersion: 1 }, ctx),
    ).toBe(false);
  });

  it("returns false when pointer set is empty", () => {
    const ctx: SeederContext = {
      pointerTargetIds: new Set(),
    };
    expect(
      isSeederOwnedRow({ agentId: "mjaKkVyqoFGN", projectionVersion: 1 }, ctx),
    ).toBe(false);
  });

  // Name-based detection (condition 3)
  it("returns true when row name is in seededNames", () => {
    const ctx: SeederContext = {
      seededNames: new Set(["demo-echo-agent"]),
    };
    expect(
      isSeederOwnedRow(
        { agentId: "mjaKkVyqoFGN", name: "demo-echo-agent" },
        ctx,
      ),
    ).toBe(true);
  });

  it("returns false when row name is NOT in seededNames", () => {
    const ctx: SeederContext = {
      seededNames: new Set(["other-agent"]),
    };
    expect(
      isSeederOwnedRow(
        { agentId: "mjaKkVyqoFGN", name: "demo-echo-agent" },
        ctx,
      ),
    ).toBe(false);
  });

  // No context
  it("returns false for damaged row when no context is provided", () => {
    expect(
      isSeederOwnedRow({ agentId: "mjaKkVyqoFGN", projectionVersion: 1 }),
    ).toBe(false);
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

  it("never touches config even when source has a string config (damaged row)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    // Source carries a string config (as found on the damaged live row
    // mjaKkVyqoFGN) — mergeOnlySeederRow must NOT include it in the
    // UpdateExpression.
    await mergeOnlySeederRow(
      realClient,
      "test-table",
      { agentId: "mjaKkVyqoFGN" },
      {
        registryStatus: "APPROVED",
        state: "active",
        config: '{"description":"Demo agent"}' as unknown as string,
      } as unknown as Parameters<typeof mergeOnlySeederRow>[3],
      false,
    );

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const expr = calls[0].args[0].input.UpdateExpression as string;
    // config must never appear — it is excluded from MERGE_FIELDS
    expect(expr).not.toContain("#config");
    expect(expr).not.toContain(":config");
  });
});
