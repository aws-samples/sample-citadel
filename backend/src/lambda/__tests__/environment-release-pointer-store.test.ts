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
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EnvironmentReleasePointer } from "../../types";

process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";

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

describe("setEnvironmentReleasePointer — first promotion (no existing row)", () => {
  test("Puts a new row at version 1 with previousReleaseId null, guarded by attribute_not_exists", async () => {
    ddbMock.on(PutCommand).resolves({});

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
    expect(result.releaseId).toBe("release-new");

    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.TableName).toBe("citadel-environment-release-pointers-test");
    expect(call.ConditionExpression).toBe("attribute_not_exists(orgId)");
    expect(call.Item).toMatchObject({
      orgId: "org-1",
      agentTargetId_environment: "agent-1#DEV",
      environment: "DEV",
      releaseId: "release-new",
      previousReleaseId: null,
      version: 1,
      promotedBy: "user-architect",
    });
  });
});

describe("setEnvironmentReleasePointer — subsequent promotion (existing row)", () => {
  test("moves the pointer, retaining the prior releaseId as previousReleaseId, bumping version, guarded by a version-match ConditionExpression", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-new",
      expectedVersion: 1,
      promotedBy: "user-architect-2",
    });

    expect(result.version).toBe(2);
    expect(result.previousReleaseId).toBe(null);
    expect(result.releaseId).toBe("release-new");

    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.ConditionExpression).toBe(
      "attribute_not_exists(orgId) OR #version = :expectedVersion",
    );
    expect(call.ExpressionAttributeNames).toEqual({ "#version": "version" });
    expect(call.ExpressionAttributeValues).toMatchObject({
      ":expectedVersion": 1,
    });
  });

  test("carries the CALLER-SUPPLIED prior releaseId forward as previousReleaseId when moving from a known current release", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setEnvironmentReleasePointer({
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING",
      releaseId: "release-new",
      expectedVersion: 1,
      currentReleaseId: "release-old",
      promotedBy: "user-architect-2",
    });

    expect(result.previousReleaseId).toBe("release-old");
    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.Item).toMatchObject({ previousReleaseId: "release-old" });
  });

  test("throws ConcurrentPromotionError (not a generic error) when the ConditionExpression fails — two concurrent promotions must not silently lose one", async () => {
    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(PutCommand).rejects(conditionalError);

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
    ddbMock.on(PutCommand).rejects(otherError);

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
});
