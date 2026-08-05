/**
 * CIT-105 Pass 2 (I/O layer) — eval-comparison-resolver tests.
 *
 * Structural mirror of eval-run-resolver.test.ts's conventions: mocked DDB
 * client, authContext fixtures per role, direct handler-function calls.
 * `compareRuns` itself is NEVER reimplemented/recomputed here — these tests
 * assert on I/O behavior (idempotency, auth, cross-org, fallback scoring,
 * event emission, storage offload) around the pure function, mirroring the
 * design's continuation-plan test list (deferred tests 21-30).
 */
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { v5 as uuidv5 } from "uuid";
import type {
  AuthContext,
  EvalSuite,
  EvalRun,
  EvalRunCaseResult,
  EvalBaseline,
} from "../../types";

process.env.EVAL_BASELINES_TABLE = "citadel-eval-baselines-test";
process.env.EVAL_COMPARISONS_TABLE = "citadel-eval-comparisons-test";
process.env.EVAL_COMPARISON_CONFIG_TABLE =
  "citadel-eval-comparison-config-test";
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

jest.mock("../../utils/notifier-base", () => ({
  emitGovernanceEvent: jest.fn(),
}));
jest.mock("../utils/eval-artifact-store", () => ({
  resolveReplayBucketName: jest.fn(),
}));

import { emitGovernanceEvent } from "../../utils/notifier-base";
import { resolveReplayBucketName } from "../utils/eval-artifact-store";
import {
  designateEvalBaseline,
  computeEvalComparison,
  setEvalComparisonThresholdConfig,
  getEvalBaseline,
  listEvalBaselines,
  getEvalComparisonHydrated,
  listEvalComparisons,
  getEvalComparisonThresholdConfig,
  CrossOrgRowError,
  EVAL_COMPARISON_NAMESPACE,
  handler,
} from "../eval-comparison-resolver";

function authContextFor(role: string): AuthContext {
  return { userId: `user-${role}`, username: role, groups: [], roles: [role] };
}

function completedRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    evalRunId: "run-1",
    orgId: "org-1",
    suiteId: "suite-1",
    suiteVersion: 1,
    agentTargetId: "agent-1",
    agentTargetVersion: "v1",
    status: "COMPLETED",
    caseCount: 1,
    pendingCases: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    startedBy: "architect-1",
    idempotencyKey: "key-1",
    ...overrides,
  };
}

function frozenSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    suiteId: "suite-1",
    orgId: "org-1",
    agentTargetId: "agent-1",
    name: "Suite One",
    description: "",
    semver: "1.0.0",
    status: "FROZEN",
    version: 1,
    references: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "architect-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function scoredCaseResult(
  overrides: Partial<EvalRunCaseResult> = {},
): EvalRunCaseResult {
  return {
    evalRunId: "run-1",
    caseId: "case-1",
    orgId: "org-1",
    caseKind: "EXECUTION",
    targetAdapter: "execution",
    status: "COMPLETED",
    scoreVector: JSON.stringify([
      {
        dimension: "task_success",
        status: "SCORED",
        verdict: { kind: "boolean", pass: true },
        basis: "deterministic",
      },
    ]),
    scorerVersion: "v1",
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  (emitGovernanceEvent as jest.Mock).mockReset();
  (emitGovernanceEvent as jest.Mock).mockResolvedValue(undefined);
  (resolveReplayBucketName as jest.Mock).mockReset();
  (resolveReplayBucketName as jest.Mock).mockResolvedValue(null);
});

// ── Test 21: idempotency ────────────────────────────────────────────────────
describe("computeEvalComparison — idempotency", () => {
  test("same inputs -> attribute_not_exists put succeeds once", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result.comparisonId).toBeDefined();
    const puts = ddbMock.commandCalls(PutCommand, {
      TableName: "citadel-eval-comparisons-test",
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(comparisonId)",
    );
  });

  test("ConditionalCheckFailedException -> returns existing row", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});

    const existingRow = {
      comparisonId: "existing-comparison-id",
      orgId: "org-1",
      suiteId: "suite-1",
    };

    ddbMock
      .on(PutCommand, { TableName: "citadel-eval-comparisons-test" })
      .rejects(
        Object.assign(new Error("conflict"), {
          name: "ConditionalCheckFailedException",
        }),
      );
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({ Item: existingRow });

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result).toEqual(existingRow);
  });
});

// ── Test 22: refuses non-COMPLETED runs ────────────────────────────────────
describe("computeEvalComparison — COMPLETED-only precondition", () => {
  test("rejects when baseline run is not COMPLETED", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({
        Item: completedRun({ evalRunId: "baseline-run", status: "RUNNING" }),
      });

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          candidateEvalRunIds: ["candidate-run"],
          baselineEvalRunId: "baseline-run",
          idempotencyKey: "idem-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*COMPLETED/i);
  });

  test("rejects when a candidate run is not COMPLETED", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({
        Item: completedRun({ evalRunId: "candidate-run", status: "FAILED" }),
      });

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          candidateEvalRunIds: ["candidate-run"],
          baselineEvalRunId: "baseline-run",
          idempotencyKey: "idem-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*COMPLETED/i);
  });
});

// ── Test 23: cross-org rejection ────────────────────────────────────────────
describe("computeEvalComparison — cross-org isolation", () => {
  test("rejects a candidate run belonging to a different org", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({
        Item: completedRun({ evalRunId: "candidate-run", orgId: "org-2" }),
      });

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          candidateEvalRunIds: ["candidate-run"],
          baselineEvalRunId: "baseline-run",
          idempotencyKey: "idem-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("rejects a suite belonging to a different org", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite({ orgId: "org-2" }) });

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          candidateEvalRunIds: ["candidate-run"],
          baselineEvalRunId: "baseline-run",
          idempotencyKey: "idem-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(CrossOrgRowError);
  });
});

// ── Test 24: baseline resolved from EvalBaselines when omitted ─────────────
describe("computeEvalComparison — baseline resolution", () => {
  test("resolves baseline from EvalBaselines when baselineEvalRunId omitted", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({
        Item: {
          orgId: "org-1",
          agentTargetId: "agent-1",
          suiteId: "suite-1",
          baselineEvalRunId: "resolved-baseline-run",
          baselineSuiteVersion: 1,
          baselineAgentTargetVersion: "v0",
          designatedAt: "2026-01-01T00:00:00.000Z",
          designatedBy: "architect-1",
          version: 1,
        } as EvalBaseline,
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "resolved-baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "resolved-baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result.baselineEvalRunId).toBe("resolved-baseline-run");
  });

  test("errors when no baseline designated and none supplied", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({});

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          candidateEvalRunIds: ["candidate-run"],
          idempotencyKey: "idem-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*no baseline designated/i);
  });
});

// ── Test 25: self-sufficient inline scoring fallback ───────────────────────
describe("computeEvalComparison — self-sufficient fallback scoring", () => {
  test("inline-scores a COMPLETED case missing a scoreVector", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });

    // Baseline run has a scoreVector already; candidate is missing one and
    // must be inline-scored.
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .callsFake((input) => {
        if (input.ExpressionAttributeValues[":rid"] === "baseline-run") {
          return Promise.resolve({
            Items: [scoredCaseResult({ evalRunId: "baseline-run" })],
          });
        }
        return Promise.resolve({
          Items: [
            scoredCaseResult({
              evalRunId: "candidate-run",
              scoreVector: undefined,
              scorerVersion: undefined,
            }),
          ],
        });
      });

    ddbMock.on(GetCommand, { TableName: "citadel-eval-cases-test" }).resolves({
      Item: {
        suiteId: "suite-1",
        caseId: "case-1",
        kind: "EXECUTION",
        expectedOutcome: { mode: "CONTAINS", target: "" },
        requiredTools: [],
        forbiddenTools: [],
      },
    });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result.comparisonId).toBeDefined();
    // Inline scoring should have written the missing scoreVector back.
    const updates = ddbMock.commandCalls(UpdateCommand, {
      TableName: "citadel-eval-run-case-results-test",
    });
    expect(updates.length).toBeGreaterThan(0);
  });
});

// ── Test 26: persist-then-emit, emit failure doesn't roll back ────────────
describe("computeEvalComparison — persist then emit", () => {
  test("emits governance.eval.comparison.completed after the durable write", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(emitGovernanceEvent).toHaveBeenCalledWith(
      "governance.eval.comparison.completed",
      expect.objectContaining({ comparisonId: result.comparisonId }),
    );
  });

  test("emit failure does not throw / does not affect the returned row", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});
    (emitGovernanceEvent as jest.Mock).mockRejectedValue(
      new Error("eventbridge down"),
    );

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result.comparisonId).toBeDefined();
  });
});

// ── Test 27: auth — eval:run for compute, eval:approve for designate/set ──
describe("authorization", () => {
  test("computeEvalComparison rejects without eval:run", async () => {
    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          candidateEvalRunIds: ["candidate-run"],
          baselineEvalRunId: "baseline-run",
          idempotencyKey: "idem-1",
        },
        authContextFor("project_manager"),
      ),
    ).rejects.toThrow(/UnauthorizedError.*eval:run/i);
  });

  test("computeEvalComparison allows developer (eval:run)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("developer"),
    );
    expect(result.comparisonId).toBeDefined();
  });

  test("designateEvalBaseline rejects without eval:approve", async () => {
    await expect(
      designateEvalBaseline(
        {
          orgId: "org-1",
          agentTargetId: "agent-1",
          suiteId: "suite-1",
          baselineEvalRunId: "run-1",
        },
        authContextFor("developer"),
      ),
    ).rejects.toThrow(/UnauthorizedError.*eval:approve/i);
  });

  test("designateEvalBaseline allows architect (eval:approve)", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-1" },
      })
      .resolves({ Item: completedRun({ evalRunId: "run-1" }) });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});

    const baseline = await designateEvalBaseline(
      {
        orgId: "org-1",
        agentTargetId: "agent-1",
        suiteId: "suite-1",
        baselineEvalRunId: "run-1",
      },
      authContextFor("architect"),
    );
    expect(baseline.baselineEvalRunId).toBe("run-1");
  });

  test("setEvalComparisonThresholdConfig rejects without eval:approve", async () => {
    await expect(
      setEvalComparisonThresholdConfig(
        "org-1",
        "suite-1",
        { thresholds: { minSampleCount: 5 } },
        authContextFor("developer"),
      ),
    ).rejects.toThrow(/UnauthorizedError.*eval:approve/i);
  });
});

// ── Test 28: designateEvalBaseline optimistic-lock upsert + audit bracket ─
describe("designateEvalBaseline — optimistic lock + audit-before-auth", () => {
  test("audit-before-auth logs bracket a denied attempt", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation();
    await expect(
      designateEvalBaseline(
        {
          orgId: "org-1",
          agentTargetId: "agent-1",
          suiteId: "suite-1",
          baselineEvalRunId: "run-1",
        },
        authContextFor("developer"),
      ),
    ).rejects.toThrow(/UnauthorizedError/);

    const auditCalls = logSpy.mock.calls.filter(
      (c) => (c[0] as { phase?: string })?.phase === "audit",
    );
    const outcomeCalls = logSpy.mock.calls.filter(
      (c) => (c[0] as { phase?: string })?.phase === "audit-outcome",
    );
    expect(auditCalls).toHaveLength(1);
    expect(outcomeCalls).toHaveLength(1);
    expect((outcomeCalls[0][0] as { authResult?: string }).authResult).toBe(
      "DENIED",
    );
    logSpy.mockRestore();
  });

  test("re-designation performs an optimistic version CAS update", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "run-2" },
      })
      .resolves({ Item: completedRun({ evalRunId: "run-2" }) });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({
        Item: {
          orgId: "org-1",
          agentTargetId: "agent-1",
          suiteId: "suite-1",
          baselineEvalRunId: "run-1",
          baselineSuiteVersion: 1,
          baselineAgentTargetVersion: "v0",
          designatedAt: "2026-01-01T00:00:00.000Z",
          designatedBy: "architect-1",
          version: 1,
        } as EvalBaseline,
      });
    ddbMock.on(UpdateCommand).resolves({});

    const baseline = await designateEvalBaseline(
      {
        orgId: "org-1",
        agentTargetId: "agent-1",
        suiteId: "suite-1",
        baselineEvalRunId: "run-2",
      },
      authContextFor("architect"),
    );

    expect(baseline.previousBaselineEvalRunId).toBe("run-1");
    expect(baseline.version).toBe(2);
    const updates = ddbMock.commandCalls(UpdateCommand, {
      TableName: "citadel-eval-baselines-test",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0].input.ConditionExpression).toBe(
      "#version = :currentVersion",
    );
  });
});

// ── Test 29: large per-case detail offloaded to S3 ─────────────────────────
describe("computeEvalComparison — S3 offload for large caseDetail", () => {
  test("offloads caseDetail to S3 when it exceeds the size cap", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });

    // Many cases -> large perCase breakdown that exceeds MAX_JSON_FIELD_BYTES.
    const manyCases = Array.from({ length: 5000 }, (_, i) =>
      scoredCaseResult({ caseId: `case-${i}` }),
    );
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: manyCases });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});
    (resolveReplayBucketName as jest.Mock).mockResolvedValue("replay-bucket");
    s3Mock.on(require("@aws-sdk/client-s3").PutObjectCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result.caseDetailRef).toBe(
      `eval-comparisons/${result.comparisonId}.json`,
    );
    expect(result.caseDetail).toBeUndefined();
    const s3Puts = s3Mock.commandCalls(
      require("@aws-sdk/client-s3").PutObjectCommand,
    );
    expect(s3Puts).toHaveLength(1);
  });

  test("stores caseDetail inline when under the size cap", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: frozenSuite() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "baseline-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "baseline-run" }) });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: "candidate-run" },
      })
      .resolves({ Item: completedRun({ evalRunId: "candidate-run" }) });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [scoredCaseResult()],
      });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await computeEvalComparison(
      {
        orgId: "org-1",
        suiteId: "suite-1",
        candidateEvalRunIds: ["candidate-run"],
        baselineEvalRunId: "baseline-run",
        idempotencyKey: "idem-1",
      },
      authContextFor("architect"),
    );

    expect(result.caseDetail).toBeDefined();
    expect(result.caseDetailRef).toBeUndefined();
  });
});

// ── Handler dispatch + query/list surface ──────────────────────────────────
describe("handler dispatch", () => {
  test("dispatches getEvalBaseline", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({
        Item: { orgId: "org-1", agentTargetId: "agent-1", suiteId: "suite-1" },
      });
    const result = await handler({
      info: { fieldName: "getEvalBaseline" },
      identity: { sub: "u1" },
      arguments: {
        orgId: "org-1",
        agentTargetId: "agent-1",
        suiteId: "suite-1",
      },
    });
    expect(result).toBeDefined();
  });

  test("dispatches listEvalBaselines", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({
        Items: [],
      });
    const result = await handler({
      info: { fieldName: "listEvalBaselines" },
      identity: { sub: "u1" },
      arguments: { orgId: "org-1" },
    });
    expect(result).toEqual([]);
  });

  test("dispatches listEvalComparisons org-only", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Items: [],
      });
    const result = await listEvalComparisons("org-1");
    expect(result).toEqual([]);
  });

  test("dispatches getEvalComparisonThresholdConfig", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({
        Item: {
          orgId: "org-1",
          suiteId: "suite-1",
          thresholds: {},
          version: 1,
        },
      });
    const result = await getEvalComparisonThresholdConfig("org-1", "suite-1");
    expect(result?.orgId).toBe("org-1");
  });

  test("unsupported field throws", async () => {
    await expect(
      handler({
        info: { fieldName: "notARealField" },
        identity: {},
        arguments: {},
      }),
    ).rejects.toThrow(/Unsupported field/);
  });
});

describe("getEvalComparisonHydrated", () => {
  test("hydrates caseDetail from S3 when caseDetailRef is set", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: {
          comparisonId: "cmp-1",
          orgId: "org-1",
          caseDetailRef: "eval-comparisons/cmp-1.json",
        },
      });
    (resolveReplayBucketName as jest.Mock).mockResolvedValue("replay-bucket");
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () => JSON.stringify({ task_success: [] }),
      } as never,
    });

    const result = await getEvalComparisonHydrated("cmp-1");
    expect(result?.caseDetail).toBe(JSON.stringify({ task_success: [] }));
  });

  test("returns row unchanged when caseDetail already inline", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-1", caseDetail: "{}" },
      });
    const result = await getEvalComparisonHydrated("cmp-1");
    expect(result?.caseDetail).toBe("{}");
  });

  test("returns null when comparison not found", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({});
    const result = await getEvalComparisonHydrated("missing");
    expect(result).toBeNull();
  });
});

describe("EVAL_COMPARISON_NAMESPACE", () => {
  test("is a frozen, valid UUID constant", () => {
    expect(EVAL_COMPARISON_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Sanity: deterministic derivation is stable for identical inputs.
    const a = uuidv5("x", EVAL_COMPARISON_NAMESPACE);
    const b = uuidv5("x", EVAL_COMPARISON_NAMESPACE);
    expect(a).toBe(b);
  });
});

// ── Cross-org isolation on READ paths (medium finding fix) ─────────────────
// These read paths must not rely on uuidv5 identifier opacity alone — they
// must apply the SAME assertRowOrg/CrossOrgRowError discipline already used
// on the write/compute paths above (test 23).
describe("read-path cross-org isolation", () => {
  test("getEvalBaseline rejects a row belonging to a different org", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({
        Item: {
          orgId: "org-2",
          agentTargetId: "agent-1",
          suiteId: "suite-1",
          baselineEvalRunId: "run-1",
          version: 1,
        },
      });

    await expect(
      getEvalBaseline("org-1", "agent-1", "suite-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("listEvalBaselines rejects when a returned row belongs to a different org", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-baselines-test" })
      .resolves({
        Items: [
          {
            orgId: "org-2",
            agentTargetId: "agent-1",
            suiteId: "suite-1",
            baselineEvalRunId: "run-1",
            version: 1,
          },
        ],
      });

    await expect(listEvalBaselines("org-1")).rejects.toThrow(CrossOrgRowError);
  });

  // getEvalComparison(comparisonId: ID!) has no orgId GraphQL argument
  // (schema.graphql:88), but the caller's org is still recoverable from the
  // AppSync identity — same precedent as execution-resolver.ts's
  // getExecution(executionId, userId, event), which resolves
  // extractOrgFromEvent(event) and compares it against the fetched row's
  // orgId. getEvalComparisonHydrated now takes the event for that reason.
  test("getEvalComparisonHydrated rejects a row belonging to a different org (identity-derived expectedOrgId)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-2", suiteId: "suite-1" },
      });

    await expect(
      getEvalComparisonHydrated("cmp-1", {
        identity: { "custom:organization": "org-1" },
      }),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("getEvalComparisonHydrated allows a same-org row (identity-derived expectedOrgId)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-1", suiteId: "suite-1" },
      });

    const result = await getEvalComparisonHydrated("cmp-1", {
      identity: { "custom:organization": "org-1" },
    });
    expect(result?.comparisonId).toBe("cmp-1");
  });

  test("getEvalComparisonHydrated allows the row through when no org claim is present (API-key/IAM caller)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-2", suiteId: "suite-1" },
      });

    const result = await getEvalComparisonHydrated("cmp-1", { identity: {} });
    expect(result?.comparisonId).toBe("cmp-1");
  });

  test("handler dispatch rejects cross-org getEvalComparison via the identity claim", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-2", suiteId: "suite-1" },
      });

    await expect(
      handler({
        info: { fieldName: "getEvalComparison" },
        identity: { "custom:organization": "org-1" },
        arguments: { comparisonId: "cmp-1" },
      }),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("listEvalComparisons (suiteId path) applies the orgId predicate on the suite-index query", async () => {
    ddbMock
      .on(QueryCommand, {
        TableName: "citadel-eval-comparisons-test",
        IndexName: "suite-index",
      })
      .resolves({
        // Real DynamoDB applies FilterExpression server-side, so a
        // cross-org row for the same suiteId never reaches the client in
        // the first place — only the org-1 row is returned here.
        Items: [{ comparisonId: "cmp-1", orgId: "org-1", suiteId: "suite-1" }],
      });

    const result = await listEvalComparisons("org-1", "suite-1");
    expect(result).toHaveLength(1);
    expect(result[0].comparisonId).toBe("cmp-1");

    const calls = ddbMock.commandCalls(QueryCommand, {
      TableName: "citadel-eval-comparisons-test",
      IndexName: "suite-index",
    });
    expect(calls[0].args[0].input.FilterExpression).toBe("orgId = :oid");
    expect(
      (
        calls[0].args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >
      )[":oid"],
    ).toBe("org-1");
  });

  test("getEvalComparisonThresholdConfig rejects a row belonging to a different org", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({
        Item: {
          orgId: "org-2",
          suiteId: "suite-1",
          thresholds: {},
          version: 1,
        },
      });

    await expect(
      getEvalComparisonThresholdConfig("org-1", "suite-1"),
    ).rejects.toThrow(CrossOrgRowError);
  });
});
