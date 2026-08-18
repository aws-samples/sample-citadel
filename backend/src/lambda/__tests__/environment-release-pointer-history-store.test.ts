/**
 * environment-release-pointer-history-store.test.ts — read-only history
 * queries (G6). Mocked DDB client; asserts the KeyCondition shape and the
 * "what ran in PROD on date D" latest-≤-D selection.
 */
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EnvironmentReleasePointerHistoryEntry } from "../../types";

process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE =
  "citadel-environment-release-pointer-history-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  queryEnvironmentReleasePointerHistory,
  environmentReleaseRunningAt,
  historySortKeyPrefix,
} from "../environment-release-pointer-history-store";

function entry(
  overrides: Partial<EnvironmentReleasePointerHistoryEntry> = {},
): EnvironmentReleasePointerHistoryEntry {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "PROD",
    releaseId: "release-1",
    previousReleaseId: null,
    promotedAt: "2026-01-01T00:00:00.000Z",
    promotedBy: "user-1",
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
});

describe("historySortKeyPrefix", () => {
  it("composes the agent#env# prefix used by both writer and reader", () => {
    expect(historySortKeyPrefix("agent-1", "PROD")).toBe("agent-1#PROD#");
  });
});

describe("queryEnvironmentReleasePointerHistory — unbounded", () => {
  it("queries with a begins_with(agent#env#) KeyCondition, ascending", async () => {
    const rows = [entry({ version: 1 }), entry({ version: 2 })];
    ddbMock.on(QueryCommand).resolves({ Items: rows });

    const result = await queryEnvironmentReleasePointerHistory(
      "org-1",
      "agent-1",
      "PROD",
    );

    expect(result).toEqual(rows);
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.TableName).toBe(
      "citadel-environment-release-pointer-history-test",
    );
    expect(input.KeyConditionExpression).toContain(
      "begins_with(historySortKey, :prefix)",
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":oid": "org-1",
      ":prefix": "agent-1#PROD#",
    });
    expect(input.ScanIndexForward).toBe(true);
  });

  it("returns an empty array when nothing has been promoted to that env", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await queryEnvironmentReleasePointerHistory(
      "org-1",
      "agent-1",
      "PROD",
    );
    expect(result).toEqual([]);
  });
});

describe("queryEnvironmentReleasePointerHistory — bounded by `until` (date D)", () => {
  it("uses a BETWEEN range with a high-sentinel upper bound so an exact-D move is included", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await queryEnvironmentReleasePointerHistory(
      "org-1",
      "agent-1",
      "PROD",
      "2026-06-01T00:00:00.000Z",
    );

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toContain(
      "BETWEEN :prefix AND :upper",
    );
    expect(input.ExpressionAttributeValues![":upper"]).toBe(
      "agent-1#PROD#2026-06-01T00:00:00.000Z#\uffff",
    );
  });
});

describe("environmentReleaseRunningAt — what ran in PROD on date D", () => {
  it("returns the greatest (latest) history row at or before D", async () => {
    const older = entry({
      releaseId: "release-old",
      promotedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    const newer = entry({
      releaseId: "release-new",
      promotedAt: "2026-05-01T00:00:00.000Z",
      version: 2,
    });
    // Store returns ascending; the LAST row is the latest ≤ D.
    ddbMock.on(QueryCommand).resolves({ Items: [older, newer] });

    const result = await environmentReleaseRunningAt(
      "org-1",
      "agent-1",
      "PROD",
      "2026-06-01T00:00:00.000Z",
    );

    expect(result).toEqual(newer);
  });

  it("returns null when nothing had been promoted to that env by date D", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await environmentReleaseRunningAt(
      "org-1",
      "agent-1",
      "PROD",
      "2025-01-01T00:00:00.000Z",
    );

    expect(result).toBeNull();
  });
});
