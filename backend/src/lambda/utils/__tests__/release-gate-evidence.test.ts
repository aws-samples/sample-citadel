/**
 * release-gate-evidence.test.ts — evidence-resolution adapter unit tests.
 *
 * Red-Green-Refactor: written before release-gate-evidence.ts exists.
 *
 * Mocks only the DynamoDB client underneath the real store/reader
 * exports (mirrors environment-release-pointer-resolver.test.ts's
 * convention) — never mocks resolveReleaseGateEvidence's own
 * collaborators directly, so the real read/org-check/compareRuns wiring
 * stays load-bearing for these tests too.
 *
 * Fail-closed discipline under test: every unreadable/partial/cross-org
 * condition must resolve to `{ ok: false, reason, detail }` — never throw
 * past the caller, never silently produce a passing ReleaseGateInputs.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type {
  AgentRelease,
  EnvironmentReleasePointer,
  EvalRun,
  EvalRunCaseResult,
  EvalSuite,
} from "../../../types";
import type { DimensionScore } from "../eval-scoring";
import { DEFAULT_PROMOTION_POLICY } from "../release-gate";

process.env.AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import { resolveReleaseGateEvidence } from "../release-gate-evidence";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const AGENT_TARGET_ID = "agent-1";
const ENVIRONMENT = "production";

function candidateRelease(overrides: Partial<AgentRelease> = {}): AgentRelease {
  return {
    releaseId: "release-candidate",
    orgId: ORG,
    agentTargetId: AGENT_TARGET_ID,
    semver: "1.1.0",
    agentConfig: { sourceId: "rec-1", content: "{}", digest: "d" },
    promptVersions: {},
    execSpecId: "spec-1",
    execSpecVersion: 1,
    modelConfigSnapshots: [],
    toolConfigs: [],
    policySnapshot: {
      enforcementMode: "strict",
      ruleSetVersion: "1",
      authorityUnitGrantIds: [],
    },
    evalEvidence: {
      evalRunId: "run-candidate",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 1,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "architect-1",
    gitSha: "abc123",
    region: "us-east-1",
    runId: "runid-1",
    ...overrides,
  };
}

function baselineRelease(overrides: Partial<AgentRelease> = {}): AgentRelease {
  return candidateRelease({
    releaseId: "release-baseline",
    semver: "1.0.0",
    evalEvidence: {
      evalRunId: "run-baseline",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 1,
    },
    ...overrides,
  });
}

function scoreVector(overrides: Partial<DimensionScore> = {}): DimensionScore {
  return {
    dimension: "task_success",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "boolean", pass: true },
    detail: "",
    ...overrides,
  };
}

function evalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    evalRunId: "run-candidate",
    orgId: ORG,
    suiteId: "suite-1",
    suiteVersion: 1,
    agentTargetId: AGENT_TARGET_ID,
    agentTargetVersion: "1.1.0",
    status: "COMPLETED",
    caseCount: 1,
    pendingCases: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    startedBy: "tester",
    completedAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function evalSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    suiteId: "suite-1",
    orgId: ORG,
    agentTargetId: AGENT_TARGET_ID,
    name: "Suite",
    description: "",
    semver: "1.0.0",
    status: "FROZEN",
    version: 1,
    references: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "tester",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function caseResult(
  overrides: Partial<EvalRunCaseResult> = {},
): EvalRunCaseResult {
  return {
    evalRunId: "run-candidate",
    caseId: "case-1",
    orgId: ORG,
    caseKind: "task",
    targetAdapter: "execution",
    status: "COMPLETED",
    scoreVector: JSON.stringify([scoreVector()]),
    scorerVersion: "v1",
    ...overrides,
  };
}

function pointer(
  overrides: Partial<EnvironmentReleasePointer> = {},
): EnvironmentReleasePointer {
  return {
    orgId: ORG,
    agentTargetId: AGENT_TARGET_ID,
    environment: ENVIRONMENT,
    releaseId: "release-baseline",
    previousReleaseId: null,
    promotedAt: "2026-01-01T00:00:00.000Z",
    promotedBy: "architect-1",
    version: 1,
    ...overrides,
  };
}

/** Wires up the "full happy path" set of mocked reads: pointer -> baseline
 * release -> baseline run/suite/cases, plus candidate run/suite/cases. */
function mockFullHappyPath() {
  ddbMock
    .on(GetCommand, {
      TableName: "citadel-environment-release-pointers-test",
    })
    .resolves({ Item: pointer() });
  ddbMock
    .on(GetCommand, {
      TableName: "citadel-agent-releases-test",
      Key: { releaseId: "release-baseline" },
    })
    .resolves({ Item: baselineRelease() });
  ddbMock
    .on(GetCommand, {
      TableName: "citadel-eval-runs-test",
      Key: { evalRunId: "run-candidate" },
    })
    .resolves({ Item: evalRun() });
  ddbMock
    .on(GetCommand, {
      TableName: "citadel-eval-runs-test",
      Key: { evalRunId: "run-baseline" },
    })
    .resolves({
      Item: evalRun({
        evalRunId: "run-baseline",
        agentTargetVersion: "1.0.0",
      }),
    });
  ddbMock
    .on(GetCommand, { TableName: "citadel-eval-suites-test" })
    .resolves({ Item: evalSuite() });
  ddbMock
    .on(QueryCommand, {
      TableName: "citadel-eval-run-case-results-test",
      ExpressionAttributeValues: { ":rid": "run-candidate" },
    })
    .resolves({ Items: [caseResult()] });
  ddbMock
    .on(QueryCommand, {
      TableName: "citadel-eval-run-case-results-test",
      ExpressionAttributeValues: { ":rid": "run-baseline" },
    })
    .resolves({
      Items: [caseResult({ evalRunId: "run-baseline" })],
    });
}

beforeEach(() => {
  ddbMock.reset();
});

describe("resolveReleaseGateEvidence — candidate resolution", () => {
  test("resolves candidate run, suite, and score aggregates for a happy-path release", async () => {
    mockFullHappyPath();
    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.hasBaseline).toBe(true);
      expect(result.inputs.liveSuite.suiteId).toBe("suite-1");
      expect(result.inputs.candidateAggregates.length).toBeGreaterThan(0);
      expect(result.inputs.pinnedSuiteVersion).toBe(1);
      expect(result.inputs.runCompletedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  test("NON-PASS reason MISSING_EVAL_RUN when the candidate's pinned evalRunId does not resolve", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("MISSING_EVAL_RUN");
    }
  });

  test("NON-PASS reason CROSS_ORG_EVAL_RUN when the candidate's pinned EvalRun belongs to a different org — never returned as evidence", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun({ orgId: OTHER_ORG }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CROSS_ORG_EVAL_RUN");
    }
  });

  test("NON-PASS reason MISSING_EVAL_SUITE when the candidate's suite does not resolve", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("MISSING_EVAL_SUITE");
    }
  });

  test("NON-PASS reason CROSS_ORG_EVAL_SUITE when the candidate's suite belongs to a different org", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite({ orgId: OTHER_ORG }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CROSS_ORG_EVAL_SUITE");
    }
  });

  test("NON-PASS reason CANDIDATE_RUN_NOT_COMPLETED when the pinned EvalRun is not COMPLETED", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun({ status: "RUNNING" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CANDIDATE_RUN_NOT_COMPLETED");
    }
  });

  test("NON-PASS reason UNREADABLE_RECORD when a candidate row is malformed (missing fields the gate needs)", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({
        // completedAt missing entirely — the gate needs it for staleness.
        Item: { ...evalRun(), completedAt: undefined },
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, {
        TableName: "citadel-eval-run-case-results-test",
      })
      .resolves({ Items: [caseResult()] });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("UNREADABLE_RECORD");
    }
  });

  test("NON-PASS reason SDK_ERROR when a candidate read throws, never swallowed into a pass", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .rejects(new Error("ProvisionedThroughputExceededException"));
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("SDK_ERROR");
      expect(result.detail).toContain("ProvisionedThroughputExceededException");
    }
  });
});

describe("resolveReleaseGateEvidence — org scoping on the release itself", () => {
  test("rejects with CROSS_ORG_RELEASE when the release passed in does not belong to callerOrgId", async () => {
    const result = await resolveReleaseGateEvidence(
      candidateRelease({ orgId: OTHER_ORG }),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CROSS_ORG_RELEASE");
    }
    expect(ddbMock.calls().length).toBe(0);
  });
});

describe("resolveReleaseGateEvidence — baseline resolution via environment pointer", () => {
  test("hasBaseline=false (NO_BASELINE case slice 1 already models) when no pointer exists for the agent+environment", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.hasBaseline).toBe(false);
      expect(result.inputs.comparisonVerdict).toBeUndefined();
    }
    // Never a second no-baseline notion: the only way this resolves ok
    // with no baseline is hasBaseline: false, not a distinct status.
  });

  test("follows the pointer to its release and that release's pinned run to build the baseline comparison input", async () => {
    mockFullHappyPath();
    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.hasBaseline).toBe(true);
      expect(result.inputs.comparisonVerdict?.baselineEvalRunId).toBe(
        "run-baseline",
      );
      expect(result.inputs.comparisonVerdict?.candidateEvalRunIds).toEqual([
        "run-candidate",
      ]);
    }
  });

  test("NON-PASS reason CROSS_ORG_POINTER when the pointer resolved belongs to a different org", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: pointer({ orgId: OTHER_ORG }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CROSS_ORG_POINTER");
    }
  });

  test("NON-PASS reason MISSING_BASELINE_RELEASE when the pointer's releaseId does not resolve to a release row", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: pointer() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-baseline" },
      })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("MISSING_BASELINE_RELEASE");
    }
  });

  test("NON-PASS reason CROSS_ORG_BASELINE_RELEASE when the pointer's release belongs to a different org (defense in depth beyond the pointer's own org check)", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: pointer() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-baseline" },
      })
      .resolves({ Item: baselineRelease({ orgId: OTHER_ORG }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CROSS_ORG_BASELINE_RELEASE");
    }
  });

  test("NON-PASS reason MISSING_EVAL_RUN when the baseline release's pinned run does not resolve", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: pointer() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-baseline" },
      })
      .resolves({ Item: baselineRelease() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-baseline" },
      })
      .resolves({ Item: undefined });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, {
        TableName: "citadel-eval-run-case-results-test",
        ExpressionAttributeValues: { ":rid": "run-candidate" },
      })
      .resolves({ Items: [caseResult()] });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("MISSING_EVAL_RUN");
    }
  });

  test("NON-PASS reason SDK_ERROR when the pointer read throws, never swallowed into a pass", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .rejects(new Error("InternalServerError"));
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [caseResult()] });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("SDK_ERROR");
      expect(result.detail).toContain("InternalServerError");
    }
  });
});

describe("resolveReleaseGateEvidence — comparison verdict is produced by compareRuns, never reimplemented", () => {
  test("verdictStatus NOTHING_TO_COMPARE surfaces through inputs.comparisonVerdict when baseline and candidate share no cases", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: pointer() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-releases-test",
        Key: { releaseId: "release-baseline" },
      })
      .resolves({ Item: baselineRelease() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-candidate" },
      })
      .resolves({ Item: evalRun() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-baseline" },
      })
      .resolves({
        Item: evalRun({
          evalRunId: "run-baseline",
          agentTargetVersion: "1.0.0",
        }),
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: evalSuite() });
    ddbMock
      .on(QueryCommand, {
        TableName: "citadel-eval-run-case-results-test",
        ExpressionAttributeValues: { ":rid": "run-candidate" },
      })
      .resolves({ Items: [caseResult({ caseId: "case-candidate-only" })] });
    ddbMock
      .on(QueryCommand, {
        TableName: "citadel-eval-run-case-results-test",
        ExpressionAttributeValues: { ":rid": "run-baseline" },
      })
      .resolves({
        Items: [
          caseResult({
            evalRunId: "run-baseline",
            caseId: "case-baseline-only",
          }),
        ],
      });

    const result = await resolveReleaseGateEvidence(
      candidateRelease(),
      ENVIRONMENT,
      ORG,
      DEFAULT_PROMOTION_POLICY,
      "2026-01-01T02:00:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.comparisonVerdict?.verdictStatus).toBe(
        "NOTHING_TO_COMPARE",
      );
    }
  });
});
