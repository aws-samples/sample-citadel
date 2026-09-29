/**
 * Unit tests for backend/scripts/backfill-registry-status.ts.
 *
 * Mocks the DynamoDB DocumentClient and RegistryService; no real AWS
 * calls. Covers: legacy-row skip classification, dry-run no-writes,
 * not-found leaves the row untouched, and a successful update sets the
 * three denormalized fields (plus createdAt only when absent).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  isLegacyRow,
  parseArgs,
  runBackfill,
} from "../backfill-registry-status";
import {
  RegistryService,
  RegistryRecord,
} from "../../src/services/registry-service";

const ddbMock = mockClient(DynamoDBDocumentClient);
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

describe("isLegacyRow", () => {
  it("returns true for a slug-keyed item with no registryRecordId and non-recordId-shaped agentId", () => {
    expect(isLegacyRow({ agentId: "my-legacy-agent-slug" })).toBe(true);
  });

  it("returns false when registryRecordId is already present", () => {
    expect(
      isLegacyRow({
        agentId: "my-legacy-agent-slug",
        registryRecordId: "abc123def456",
      }),
    ).toBe(false);
  });

  it("returns false when agentId matches the 12-char recordId shape", () => {
    expect(isLegacyRow({ agentId: "abc123DEF456" })).toBe(false);
  });

  it("treats an empty-string registryRecordId as absent", () => {
    expect(
      isLegacyRow({ agentId: "not-a-recordid", registryRecordId: "" }),
    ).toBe(true);
  });
});

describe("parseArgs", () => {
  it("parses --table and --registry-id, defaulting dryRun to false", () => {
    expect(
      parseArgs(["--table", "agents-dev", "--registry-id", "reg-1"]),
    ).toEqual({
      table: "agents-dev",
      registryId: "reg-1",
      dryRun: false,
    });
  });

  it("sets dryRun true when --dry-run is present", () => {
    expect(
      parseArgs(["--table", "t", "--registry-id", "r", "--dry-run"]),
    ).toEqual({ table: "t", registryId: "r", dryRun: true });
  });

  it("throws when --table is missing", () => {
    expect(() => parseArgs(["--registry-id", "r"])).toThrow(
      "--table <agents table> is required",
    );
  });

  it("throws when --registry-id is missing", () => {
    expect(() => parseArgs(["--table", "t"])).toThrow(
      "--registry-id <id> is required",
    );
  });
});

describe("runBackfill", () => {
  const TABLE = "agents-dev";
  const REGISTRY_ID = "reg-1";

  beforeEach(() => {
    ddbMock.reset();
  });

  function fakeRegistry(
    getResource: (
      type: "agent" | "tool",
      id: string,
    ) => Promise<RegistryRecord | null>,
  ): RegistryService {
    return { getResource } as unknown as RegistryService;
  }

  it("dry-run: performs lookups but issues no UpdateItem writes", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ agentId: "abc123def456" }],
    });
    const registry = fakeRegistry(async () => ({
      recordId: "abc123def456",
      name: "n",
      status: "APPROVED",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    }));

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      true,
      registry,
      docClient,
    );

    expect(summary).toEqual({
      scanned: 1,
      updated: 1,
      skippedLegacy: 0,
      notFound: 0,
      errors: 0,
    });
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
  });

  it("not-found: leaves the item untouched and counts it", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ agentId: "abc123def456" }],
    });
    const registry = fakeRegistry(async () => null);

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      false,
      registry,
      docClient,
    );

    expect(summary).toEqual({
      scanned: 1,
      updated: 0,
      skippedLegacy: 0,
      notFound: 1,
      errors: 0,
    });
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
  });

  it("skips legacy slug-keyed rows without probing the registry", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ agentId: "legacy-slug-name" }],
    });
    const getResource = jest.fn();
    const registry = fakeRegistry(getResource);

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      false,
      registry,
      docClient,
    );

    expect(summary).toEqual({
      scanned: 1,
      updated: 0,
      skippedLegacy: 1,
      notFound: 0,
      errors: 0,
    });
    expect(getResource).not.toHaveBeenCalled();
  });

  it("apply: sets registryStatus, registryRecordId, statusUpdatedAt, and createdAt when absent", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ agentId: "abc123def456" }],
    });
    ddbMock.on(UpdateCommand).resolves({});
    const registry = fakeRegistry(async () => ({
      recordId: "abc123def456",
      name: "n",
      status: "APPROVED",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    }));

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      false,
      registry,
      docClient,
    );

    expect(summary.updated).toBe(1);
    expect(summary.errors).toBe(0);
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls.length).toBe(1);
    const input = calls[0].args[0].input;
    expect(input.Key).toEqual({ agentId: "abc123def456" });
    expect(input.ExpressionAttributeValues?.[":status"]).toBe("APPROVED");
    expect(input.ExpressionAttributeValues?.[":recordId"]).toBe("abc123def456");
    expect(input.ExpressionAttributeValues?.[":createdAt"]).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(input.UpdateExpression).toContain("#createdAt = :createdAt");
  });

  it("apply: does not overwrite createdAt when already present on the row", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { agentId: "abc123def456", createdAt: "2020-01-01T00:00:00.000Z" },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    const registry = fakeRegistry(async () => ({
      recordId: "abc123def456",
      name: "n",
      status: "APPROVED",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    }));

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      false,
      registry,
      docClient,
    );

    expect(summary.updated).toBe(1);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues?.[":createdAt"]).toBeUndefined();
    expect(input.UpdateExpression).not.toContain("createdAt");
  });

  it("counts an UpdateItem failure as an error", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ agentId: "abc123def456" }],
    });
    ddbMock
      .on(UpdateCommand)
      .rejects(new Error("ConditionalCheckFailedException"));
    const registry = fakeRegistry(async () => ({
      recordId: "abc123def456",
      name: "n",
      status: "APPROVED",
    }));

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      false,
      registry,
      docClient,
    );

    expect(summary.errors).toBe(1);
    expect(summary.updated).toBe(0);
  });

  it("paginates through multiple Scan pages", async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ agentId: "abc123def456" }],
        LastEvaluatedKey: { agentId: "abc123def456" },
      })
      .resolvesOnce({
        Items: [{ agentId: "def456abc123" }],
      });
    ddbMock.on(UpdateCommand).resolves({});
    const registry = fakeRegistry(async () => ({
      recordId: "x",
      name: "n",
      status: "DRAFT",
    }));

    const summary = await runBackfill(
      TABLE,
      REGISTRY_ID,
      false,
      registry,
      docClient,
    );

    expect(summary.scanned).toBe(2);
    expect(summary.updated).toBe(2);
  });
});
