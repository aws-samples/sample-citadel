/**
 * environment-release-pointer-store.ts — the SOLE write choke point for
 * EnvironmentReleasePointersTable.
 *
 * Structural mirror of release-store.test.ts's conventions: mocked DDB
 * client, direct function calls against the real (unmocked) store logic.
 *
 * Unlike AgentRelease, this record is deliberately MUTABLE — these tests
 * assert the OPPOSITE property of release-store.test.ts: a second write
 * to the same (orgId, agentTargetId, environment) key succeeds and moves
 * the pointer, but ONLY when its ConditionExpression on the `version`
 * attribute matches what the caller last read. A concurrent promotion
 * racing against a stale read must be rejected by DynamoDB itself, not by
 * application logic re-checking after the fact.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EnvironmentReleasePointer } from "../../types";

process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";
process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE =
  "citadel-environment-release-pointer-history-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  getEnvironmentReleasePointer,
  listEnvironmentReleasePointersForAgent,
  setEnvironmentReleasePointer,
  ConcurrentPromotionError,
} from "../environment-release-pointer-store";

function existingPointer(
  overrides: Partial<EnvironmentReleasePointer> = {},
): EnvironmentReleasePointer {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "STAGING",
    releaseId: "release-old",
    previousReleaseId: null,
    promotedAt: "2026-01-01T00:00:00.000Z",
    promotedBy: "user-architect",
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
});

describe("getEnvironmentReleasePointer", () => {
  test("returns the pointer row when it exists", async () => {
    const pointer = existingPointer();
    ddbMock.on(GetCommand).resolves({ Item: pointer });

    const result = await getEnvironmentReleasePointer(
      "org-1",
      "agent-1",
      "STAGING",
    );

    expect(result).toEqual(pointer);
    const call = ddbMock.commandCalls(GetCommand)[0].args[0].input;
    expect(call.TableName).toBe("citadel-environment-release-pointers-test");
    expect(call.Key).toEqual({
      orgId: "org-1",
      agentTargetId_environment: "agent-1#STAGING",
    });
  });

  test("returns null when no pointer exists yet for that key", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getEnvironmentReleasePointer(
      "org-1",
      "agent-1",
      "PROD",
    );

    expect(result).toBeNull();
  });
});

describe("listEnvironmentReleasePointersForAgent", () => {
  test("queries across every environment for one agent within the org", async () => {
    const staging = existingPointer({ environment: "STAGING" });
    const prod = existingPointer({
      environment: "PROD",
      releaseId: "release-prod",
      version: 3,
    });
    ddbMock.on(QueryCommand).resolves({ Items: [staging, prod] });

    const result = await listEnvironmentReleasePointersForAgent(
      "org-1",
      "agent-1",
    );

    expect(result).toEqual([staging, prod]);
    const call = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(call.TableName).toBe("citadel-environment-release-pointers-test");
    expect(call.KeyConditionExpression).toContain("orgId");
    expect(call.KeyConditionExpression).toContain(
      "begins_with(agentTargetId_environment",
    );
    expect(call.ExpressionAttributeValues).toMatchObject({
      ":oid": "org-1",
      ":prefix": "agent-1#",
    });
  });

  test("returns an empty array when the agent has no pointers yet", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await listEnvironmentReleasePointersForAgent(
      "org-1",
      "agent-2",
    );

    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Transactional write (pointer move + atomic history row) — G6.
// setEnvironmentReleasePointer now issues ONE TransactWriteCommand with
// two Put items: the version-gated pointer Put + the append-only history
// Put. These tests assert on TransactWriteCommand, not PutCommand.
// ─────────────────────────────────────────────────────────────────────

const POINTERS_TABLE = "citadel-environment-release-pointers-test";
const HISTORY_TABLE = "citadel-environment-release-pointer-history-test";

/** Extract the two Put items from the sole TransactWriteCommand call. */
function transactPuts(callIndex = 0) {
  const input = ddbMock.commandCalls(TransactWriteCommand)[callIndex].args[0]
    .input as {
    TransactItems: { Put: { TableName: string; [k: string]: unknown } }[];
  };
  const puts = input.TransactItems.map((t) => t.Put);
  const pointer = puts.find((p) => p.TableName === POINTERS_TABLE)!;
  const history = puts.find((p) => p.TableName === HISTORY_TABLE)!;
  return { pointer, history, puts };
}

describe("setEnvironmentReleasePointer — first promotion (no existing row)", () => {
  test("writes pointer + history atomically at version 1, guarded by attribute_not_exists", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "DEV",
      releaseId: "release-new",
      expectedVersion: null,
      promotedBy: "user-architect",
    });

    expect(result.version).toBe(1);
    expect(result.previousReleaseId).toBeNull();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);

    const { pointer, history } = transactPuts();
    expect(pointer.ConditionExpression).toBe("attribute_not_exists(orgId)");
    expect(pointer.Item).toMatchObject({
      orgId: "org-1",
      agentTargetId_environment: "agent-1#DEV",
      environment: "DEV",
      releaseId: "release-new",
      previousReleaseId: null,
      version: 1,
    });
    // History row lands in the SAME transaction, with the composite SK.
    expect(history.Item).toMatchObject({
      orgId: "org-1",
      environment: "DEV",
      releaseId: "release-new",
      version: 1,
    });
    expect((history.Item as { historySortKey: string }).historySortKey).toMatch(
      /^agent-1#DEV#.*#1$/,
    );
    // History Put is unconditional (SK uniqueness via version).
    expect(history.ConditionExpression).toBeUndefined();
  });
});

describe("setEnvironmentReleasePointer — subsequent promotion (existing row)", () => {
  test("moves the pointer under a version-match condition and appends a v2 history row", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-new",
      expectedVersion: 1,
      currentReleaseId: "release-old",
      promotedBy: "user-architect-2",
    });

    expect(result.version).toBe(2);
    expect(result.previousReleaseId).toBe("release-old");

    const { pointer, history } = transactPuts();
    expect(pointer.ConditionExpression).toBe(
      "attribute_not_exists(orgId) OR #version = :expectedVersion",
    );
    expect(pointer.ExpressionAttributeNames).toEqual({ "#version": "version" });
    expect(pointer.ExpressionAttributeValues).toMatchObject({
      ":expectedVersion": 1,
    });
    expect((history.Item as { historySortKey: string }).historySortKey).toMatch(
      /^agent-1#STAGING#.*#2$/,
    );
    expect(history.Item).toMatchObject({
      previousReleaseId: "release-old",
      version: 2,
    });
  });

  test("throws ConcurrentPromotionError when the transaction is cancelled with a ConditionalCheckFailed reason", async () => {
    const cancelled = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "ConditionalCheckFailed" },
        { Code: "None" },
      ],
    });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);

    await expect(
      setEnvironmentReleasePointer({
        orgId: "org-1",
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-new",
        expectedVersion: 1,
        promotedBy: "user-architect-2",
      }),
    ).rejects.toThrow(ConcurrentPromotionError);
  });

  test("still maps a bare ConditionalCheckFailedException to ConcurrentPromotionError", async () => {
    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(TransactWriteCommand).rejects(conditionalError);

    await expect(
      setEnvironmentReleasePointer({
        orgId: "org-1",
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-new",
        expectedVersion: 1,
        promotedBy: "user-architect-2",
      }),
    ).rejects.toThrow(ConcurrentPromotionError);
  });

  test("propagates any OTHER DynamoDB error unchanged (not wrapped as ConcurrentPromotionError)", async () => {
    const otherError = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    ddbMock.on(TransactWriteCommand).rejects(otherError);

    await expect(
      setEnvironmentReleasePointer({
        orgId: "org-1",
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-new",
        expectedVersion: 1,
        promotedBy: "user-architect-2",
      }),
    ).rejects.toThrow("throttled");
  });

  test("a transaction cancelled for a NON-conditional reason propagates unchanged", async () => {
    const cancelled = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "None" },
        { Code: "ProvisionedThroughputExceeded" },
      ],
    });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);

    await expect(
      setEnvironmentReleasePointer({
        orgId: "org-1",
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-new",
        expectedVersion: 1,
        promotedBy: "user-architect-2",
      }),
    ).rejects.toThrow(/Transaction cancelled/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// MANDATED (design §10, finding d4e76981): two successive chained moves
// over a STATEFUL transactional mock, asserting the version chain AND
// that BOTH history rows land; plus a non-stubbed conditional race that
// proves the version guard BITES (exactly one move + one history row).
// ─────────────────────────────────────────────────────────────────────

interface StatefulStore {
  pointer: Map<string, Record<string, unknown>>;
  history: Record<string, unknown>[];
}

/** Wire the ddbMock to behave like a real transactional DDB for the
 * pointer + history tables: the pointer Put's version condition is
 * evaluated against the live item map; a violation cancels the WHOLE
 * transaction (no history row lands), exactly as DynamoDB would. */
function installStatefulTransactMock(): StatefulStore {
  const store: StatefulStore = { pointer: new Map(), history: [] };

  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    const items = (
      input as {
        TransactItems: {
          Put: {
            TableName: string;
            Item: Record<string, unknown>;
            ConditionExpression?: string;
            ExpressionAttributeValues?: Record<string, unknown>;
          };
        }[];
      }
    ).TransactItems.map((t) => t.Put);

    const pointerPut = items.find((p) => p.TableName === POINTERS_TABLE)!;
    const historyPut = items.find((p) => p.TableName === HISTORY_TABLE)!;

    const key = `${pointerPut.Item.orgId}#${pointerPut.Item.agentTargetId_environment}`;
    const existing = store.pointer.get(key);

    // Evaluate the OR'd condition exactly as the store composed it.
    const cond = pointerPut.ConditionExpression ?? "";
    const expected = pointerPut.ExpressionAttributeValues?.[":expectedVersion"];
    const attributeNotExistsSatisfied = existing === undefined;
    const versionMatchSatisfied =
      expected !== undefined && existing?.version === expected;
    const conditionHolds =
      cond === "" ? true : attributeNotExistsSatisfied || versionMatchSatisfied;

    if (!conditionHolds) {
      const err = Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
      throw err;
    }

    store.pointer.set(key, { ...pointerPut.Item });
    store.history.push({ ...historyPut.Item });
    return {};
  });

  return store;
}

describe("setEnvironmentReleasePointer — chained moves over a stateful transactional mock (finding d4e76981)", () => {
  test("two successive moves bump version 1→2, chain previousReleaseId, and land BOTH history rows", async () => {
    const store = installStatefulTransactMock();

    const first = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-A",
      expectedVersion: null,
      promotedBy: "user-1",
    });
    expect(first.version).toBe(1);
    expect(first.previousReleaseId).toBeNull();

    const second = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-B",
      expectedVersion: first.version,
      currentReleaseId: first.releaseId,
      promotedBy: "user-2",
    });
    expect(second.version).toBe(2);
    expect(second.previousReleaseId).toBe("release-A");

    // Exactly two history rows, in order, with the version chain.
    expect(store.history).toHaveLength(2);
    expect(store.history[0]).toMatchObject({
      releaseId: "release-A",
      version: 1,
    });
    expect(store.history[1]).toMatchObject({
      releaseId: "release-B",
      previousReleaseId: "release-A",
      version: 2,
    });
  });

  test("chains across the ladder DEV=R→STAGING=R→PROD=R, one history row per env", async () => {
    const store = installStatefulTransactMock();

    for (const environment of ["DEV", "STAGING", "PROD"] as const) {
      await setEnvironmentReleasePointer({
        orgId: "org-1",
        agentTargetId: "agent-1",
        environment,
        releaseId: "release-R",
        expectedVersion: null,
        promotedBy: "user-1",
      });
    }

    expect(store.history).toHaveLength(3);
    expect(store.history.map((h) => h.environment)).toEqual([
      "DEV",
      "STAGING",
      "PROD",
    ]);
    expect(store.pointer.size).toBe(3);
  });

  test("a racing stale-version move is rejected — exactly one move + one history row, the loser writes NOTHING", async () => {
    const store = installStatefulTransactMock();

    // Establish v1.
    const v1 = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-A",
      expectedVersion: null,
      promotedBy: "user-1",
    });

    // Two promotions both read v1 and race. The first wins (v1→v2).
    await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-B",
      expectedVersion: v1.version,
      currentReleaseId: v1.releaseId,
      promotedBy: "user-2",
    });

    // The loser also read v1 — its transaction must be cancelled.
    await expect(
      setEnvironmentReleasePointer({
        orgId: "org-1",
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-C",
        expectedVersion: v1.version,
        currentReleaseId: v1.releaseId,
        promotedBy: "user-3",
      }),
    ).rejects.toThrow(ConcurrentPromotionError);

    // Exactly one winning move beyond v1, and NO history row for the
    // loser (release-C never lands anywhere — atomic).
    expect(store.history).toHaveLength(2);
    expect(store.history.map((h) => h.releaseId)).toEqual([
      "release-A",
      "release-B",
    ]);
    expect(store.history.some((h) => h.releaseId === "release-C")).toBe(false);
  });
});
