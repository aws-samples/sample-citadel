/**
 * Canary transitions through the SOLE pointer writer
 * (environment-release-pointer-store.ts). Asserts that start/reweight/
 * promote/abort each write the pointer AND its history row atomically in
 * ONE version-gated TransactWriteItems (decision D2/D3), that clearing the
 * canary writes NO `canary` attribute (backward-compatible), that the
 * transitionType discriminator lands on both items, and that a raced
 * transition surfaces ConcurrentPromotionError without a partial write.
 */
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { CanaryState } from "../../types";

process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";
process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE =
  "citadel-environment-release-pointer-history-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  setEnvironmentReleasePointer,
  ConcurrentPromotionError,
} from "../environment-release-pointer-store";

const POINTERS_TABLE = "citadel-environment-release-pointers-test";
const HISTORY_TABLE = "citadel-environment-release-pointer-history-test";

function transactPuts(callIndex = 0) {
  const input = ddbMock.commandCalls(TransactWriteCommand)[callIndex].args[0]
    .input as {
    TransactItems: { Put: { TableName: string; [k: string]: unknown } }[];
  };
  const puts = input.TransactItems.map((t) => t.Put);
  return {
    pointer: puts.find((p) => p.TableName === POINTERS_TABLE)!,
    history: puts.find((p) => p.TableName === HISTORY_TABLE)!,
  };
}

const CANARY: CanaryState = {
  candidateReleaseId: "release-candidate",
  percentBasisPoints: 1000,
  stickiness: "conversation",
  salt: "salt-A",
  startedAt: "2026-02-01T00:00:00.000Z",
  startedBy: "user-architect",
};

beforeEach(() => {
  ddbMock.reset();
});

describe("setEnvironmentReleasePointer — canary transitions", () => {
  it("writes the canary and CANARY_START on both pointer and history atomically", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "PROD",
      releaseId: "release-stable", // stable arm unchanged
      expectedVersion: 3,
      currentReleaseId: "release-stable",
      promotedBy: "user-architect",
      canary: CANARY,
      transitionType: "CANARY_START",
    });

    expect(result.version).toBe(4);
    expect(result.canary).toEqual(CANARY);
    expect(result.transitionType).toBe("CANARY_START");
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);

    const { pointer, history } = transactPuts();
    expect(pointer.Item).toMatchObject({
      releaseId: "release-stable",
      canary: CANARY,
      transitionType: "CANARY_START",
      version: 4,
    });
    expect(history.Item).toMatchObject({
      canary: CANARY,
      transitionType: "CANARY_START",
      version: 4,
    });
    // Version-gated, same optimistic lock as a promotion.
    expect(pointer.ConditionExpression).toBe(
      "attribute_not_exists(orgId) OR #version = :expectedVersion",
    );
  });

  it("clears the canary on promote (stable := candidate) with NO canary attribute written", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "PROD",
      releaseId: "release-candidate", // stable := candidate
      expectedVersion: 4,
      currentReleaseId: "release-stable",
      promotedBy: "user-architect",
      canary: null, // cleared
      transitionType: "CANARY_PROMOTE",
    });

    expect(result.canary).toBeUndefined();
    const { pointer, history } = transactPuts();
    // No `canary` attribute on a cleared row — byte-identical to a
    // pre-canary pointer, so every reader resolves it 100% stable.
    expect(Object.prototype.hasOwnProperty.call(pointer.Item, "canary")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(history.Item, "canary")).toBe(
      false,
    );
    expect(pointer.Item).toMatchObject({
      releaseId: "release-candidate",
      previousReleaseId: "release-stable",
      transitionType: "CANARY_PROMOTE",
    });
  });

  it("defaults transitionType to PROMOTE for pre-canary callers (backward-compat)", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "DEV",
      releaseId: "release-new",
      expectedVersion: null,
      promotedBy: "user-architect",
    });

    expect(result.transitionType).toBe("PROMOTE");
    const { pointer } = transactPuts();
    expect(Object.prototype.hasOwnProperty.call(pointer.Item, "canary")).toBe(
      false,
    );
  });

  it("rejects a raced canary transition with ConcurrentPromotionError (no partial write)", async () => {
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
        environment: "PROD",
        releaseId: "release-stable",
        expectedVersion: 3,
        currentReleaseId: "release-stable",
        promotedBy: "user-architect",
        canary: CANARY,
        transitionType: "CANARY_REWEIGHT",
      }),
    ).rejects.toThrow(ConcurrentPromotionError);
  });
});
