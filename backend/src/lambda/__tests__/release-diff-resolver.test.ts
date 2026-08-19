/**
 * release-diff-resolver.test.ts — releaseDiff(releaseIdA, releaseIdB)
 * query. Mocked DynamoDB client, mirrors release-resolver.test.ts /
 * environment-release-pointer-resolver.test.ts conventions.
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AgentRelease, EvalRun } from "../../types";

process.env.AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  releaseDiff,
  ReleaseNotFoundError,
  CrossOrgReleaseDiffError,
  handler,
} from "../release-diff-resolver";

function release(overrides: Partial<AgentRelease> = {}): AgentRelease {
  return {
    releaseId: "release-a",
    orgId: "org-1",
    agentTargetId: "agent-1",
    semver: "1.0.0",
    agentConfig: { sourceId: "reg-1", content: "v1", digest: "d1" },
    promptVersions: {
      system: { sourceId: "p-system", content: "hello", digest: "dp1" },
    },
    execSpecId: "spec-1",
    execSpecVersion: 1,
    modelConfigSnapshots: [],
    toolConfigs: [],
    policySnapshot: {
      enforcementMode: "shadow",
      ruleSetVersion: "v1",
      authorityUnitGrantIds: [],
    },
    evalEvidence: {
      evalRunId: "run-a",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 1,
    },
    createdAt: "2025-01-01T00:00:00.000Z",
    createdBy: "user-1",
    gitSha: "abc123",
    region: "us-east-1",
    runId: "run-id-1",
    ...overrides,
  } as AgentRelease;
}

function evalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    evalRunId: "run-a",
    orgId: "org-1",
    suiteId: "suite-1",
    suiteVersion: 1,
    agentTargetId: "agent-1",
    agentTargetVersion: "1.0.0",
    status: "COMPLETED",
    caseCount: 10,
    pendingCases: 0,
    startedAt: "2025-01-01T00:00:00.000Z",
    startedBy: "user-1",
    idempotencyKey: "key-1",
    ...overrides,
  } as EvalRun;
}

beforeEach(() => {
  ddbMock.reset();
});

describe("releaseDiff query", () => {
  test("returns changes between two same-org releases", async () => {
    const releaseA = release({ releaseId: "release-a" });
    const releaseB = release({
      releaseId: "release-b",
      execSpecVersion: 2,
      evalEvidence: {
        evalRunId: "run-b",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    });

    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-a" },
      })
      .resolves({ Item: releaseA });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-b" },
      })
      .resolves({ Item: releaseB });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-a" },
      })
      .resolves({ Item: evalRun({ evalRunId: "run-a" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-b" },
      })
      .resolves({ Item: evalRun({ evalRunId: "run-b" }) });

    const result = await releaseDiff("release-a", "release-b", "org-1");

    expect(result.releaseIdA).toBe("release-a");
    expect(result.releaseIdB).toBe("release-b");
    expect(result.changes.some((c) => c.kind === "execSpec")).toBe(true);
    expect(result.changes.some((c) => c.kind === "evalEvidence")).toBe(true);
  });

  test("returns empty changes for a release diffed against itself", async () => {
    const releaseA = release({ releaseId: "release-a" });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-a" },
      })
      .resolves({ Item: releaseA });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-runs-test" })
      .resolves({ Item: undefined });

    const result = await releaseDiff("release-a", "release-a", "org-1");
    expect(result.changes).toEqual([]);
  });

  test("throws ReleaseNotFoundError when a release does not exist", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({ Item: undefined });

    await expect(
      releaseDiff("missing-a", "missing-b", "org-1"),
    ).rejects.toThrow(ReleaseNotFoundError);
  });

  test("throws CrossOrgReleaseDiffError when a release belongs to another org", async () => {
    const releaseA = release({ releaseId: "release-a", orgId: "org-1" });
    const releaseB = release({ releaseId: "release-b", orgId: "org-2" });

    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-a" },
      })
      .resolves({ Item: releaseA });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-b" },
      })
      .resolves({ Item: releaseB });

    await expect(
      releaseDiff("release-a", "release-b", "org-1"),
    ).rejects.toThrow(CrossOrgReleaseDiffError);
  });

  test("resolves score vectors from each side's EvalRun.scoreAggregates and reports movement", async () => {
    const releaseA = release({
      releaseId: "release-a",
      evalEvidence: {
        evalRunId: "run-a",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    });
    const releaseB = release({
      releaseId: "release-b",
      evalEvidence: {
        evalRunId: "run-b",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    });

    const scoreA = JSON.stringify([
      {
        dimension: "task_success",
        scoredCount: 10,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        passedCount: 8,
        passRate: 0.8,
      },
    ]);
    const scoreB = JSON.stringify([
      {
        dimension: "task_success",
        scoredCount: 10,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        passedCount: 9,
        passRate: 0.9,
      },
    ]);

    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-a" },
      })
      .resolves({ Item: releaseA });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-b" },
      })
      .resolves({ Item: releaseB });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-a" },
      })
      .resolves({
        Item: evalRun({ evalRunId: "run-a", scoreAggregates: scoreA }),
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-b" },
      })
      .resolves({
        Item: evalRun({ evalRunId: "run-b", scoreAggregates: scoreB }),
      });

    const result = await releaseDiff("release-a", "release-b", "org-1");
    const scoreVectorChange = result.changes.find(
      (c) => c.kind === "scoreVector",
    );
    expect(scoreVectorChange).toBeDefined();
  });

  test("does not throw when an EvalRun is missing or unscored — omits score-vector movement gracefully", async () => {
    const releaseA = release({ releaseId: "release-a" });
    const releaseB = release({
      releaseId: "release-a-copy",
      agentConfig: releaseA.agentConfig,
    });

    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-a" },
      })
      .resolves({ Item: releaseA });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-a-copy" },
      })
      .resolves({ Item: releaseB });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-runs-test" })
      .resolves({ Item: undefined });

    await expect(
      releaseDiff("release-a", "release-a-copy", "org-1"),
    ).resolves.toBeDefined();
  });
});

describe("releaseDiff-resolver handler dispatch", () => {
  test("Unsupported field throws", async () => {
    await expect(
      handler({
        info: { fieldName: "somethingElse" },
        arguments: {},
        identity: {},
      } as never),
    ).rejects.toThrow("Unsupported field");
  });
});
