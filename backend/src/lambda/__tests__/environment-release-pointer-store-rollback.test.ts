/**
 * Tests for the auto-rollback additions to the pointer store:
 *  - the sparse ActiveCanaryIndex marker (decision D8) is written inside
 *    the sole writer's atomic Put ONLY when a canary is present, and is
 *    omitted (dropping the row from the index) when the canary is cleared;
 *  - queryActiveCanaries enumerates via the GSI, never a Scan;
 *  - the SECURITY MUST-FIX: performAutoAbortCanary MINTS promotedBy +
 *    transitionType server-side and cannot be influenced by caller input.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  ACTIVE_CANARY_GSI,
  ACTIVE_CANARY_PK,
  ACTIVE_CANARY_PK_ATTR,
  performAutoAbortCanary,
  queryActiveCanaries,
  RELEASE_ROLLBACK_SYSTEM_ACTOR,
  setEnvironmentReleasePointer,
  type PerformAutoAbortCanaryParams,
} from "../environment-release-pointer-store";
import type { CanaryState } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);

function canary(): CanaryState {
  return {
    candidateReleaseId: "rel-candidate",
    percentBasisPoints: 1000,
    stickiness: "conversation",
    salt: "salt-1",
    startedAt: "2026-08-18T00:00:00.000Z",
    startedBy: "user-1",
  };
}

function pointerPutItem() {
  return ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input
    .TransactItems![0].Put!.Item as Record<string, unknown>;
}

beforeEach(() => {
  ddbMock.reset();
  process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE = "test-pointers";
  process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE =
    "test-pointer-history";
});

afterEach(() => {
  delete process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE;
  delete process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE;
});

describe("ActiveCanaryIndex sparse marker", () => {
  it("writes the marker attrs inside the atomic Put when a canary is present", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "staging",
      releaseId: "rel-stable",
      expectedVersion: 3,
      currentReleaseId: "rel-stable",
      promotedBy: "user-1",
      canary: canary(),
      transitionType: "CANARY_START",
    });
    const item = pointerPutItem();
    expect(item[ACTIVE_CANARY_PK_ATTR]).toBe(ACTIVE_CANARY_PK);
    expect(item.activeCanarySk).toBe("org-1#agent-1#staging");
  });

  it("omits the marker attrs when the canary is cleared (drops it from the index)", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "staging",
      releaseId: "rel-stable",
      expectedVersion: 4,
      currentReleaseId: "rel-stable",
      promotedBy: "user-1",
      canary: null,
      transitionType: "CANARY_ABORT",
    });
    const item = pointerPutItem();
    expect(item[ACTIVE_CANARY_PK_ATTR]).toBeUndefined();
    expect(item.activeCanarySk).toBeUndefined();
  });
});

describe("queryActiveCanaries", () => {
  it("enumerates via the ActiveCanaryIndex GSI, never a Scan", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [{ orgId: "org-1", canary: canary() }] });
    const rows = await queryActiveCanaries();
    expect(rows).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe(ACTIVE_CANARY_GSI);
    expect(call.args[0].input.KeyConditionExpression).toContain(
      ACTIVE_CANARY_PK_ATTR,
    );
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });
});

describe("performAutoAbortCanary — server-side mint (SECURITY must-fix)", () => {
  it("mints promotedBy + AUTO_ABORT_CANARY and clears the canary, stable unchanged", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const result = await performAutoAbortCanary({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "staging",
      releaseId: "rel-stable",
      expectedVersion: 5,
    });
    expect(result.promotedBy).toBe(RELEASE_ROLLBACK_SYSTEM_ACTOR);
    expect(result.transitionType).toBe("AUTO_ABORT_CANARY");
    expect(result.releaseId).toBe("rel-stable"); // stable untouched
    expect(result.canary).toBeUndefined(); // canary cleared

    const item = pointerPutItem();
    expect(item.promotedBy).toBe("system:release-rollback-evaluator");
    expect(item.transitionType).toBe("AUTO_ABORT_CANARY");
    // canary cleared → no sparse marker (drops out of the index)
    expect(item[ACTIVE_CANARY_PK_ATTR]).toBeUndefined();
  });

  it("REJECTS/overrides caller-supplied promotedBy and transitionType", async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    // A caller attempts to forge a human principal + a floor-setting
    // transition by casting a wider object. The helper must ignore both.
    const hostile = {
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "staging",
      releaseId: "rel-stable",
      expectedVersion: 6,
      promotedBy: "user-attacker",
      transitionType: "CANARY_PROMOTE",
    } as unknown as PerformAutoAbortCanaryParams;

    const result = await performAutoAbortCanary(hostile);

    expect(result.promotedBy).toBe(RELEASE_ROLLBACK_SYSTEM_ACTOR);
    expect(result.promotedBy).not.toBe("user-attacker");
    expect(result.transitionType).toBe("AUTO_ABORT_CANARY");
    expect(result.transitionType).not.toBe("CANARY_PROMOTE");

    const item = pointerPutItem();
    expect(item.promotedBy).toBe("system:release-rollback-evaluator");
    expect(item.transitionType).toBe("AUTO_ABORT_CANARY");
  });
});
