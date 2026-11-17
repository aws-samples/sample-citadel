/**
 * eval-comparison-scope — tenant isolation + cross-agent/suite guard.
 *
 * Finding (a): getEvalComparisonHydrated skips assertRowOrg when
 * extractOrgFromEvent returns null (no org claim), leaking rows
 * across tenants.
 *
 * Finding (b): computeEvalComparison never validates that baseline
 * and candidate runs belong to the same agentTargetId and suiteId
 * as the input suite, allowing false no-regression evidence from
 * mismatched runs.
 */
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext, EvalSuite, EvalRun } from "../../types";

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
  getEvalComparisonHydrated,
  computeEvalComparison,
} from "../eval-comparison-resolver";

function authCtx(role: string): AuthContext {
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

function scoredCaseResult() {
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

// ── Finding (a): no-org caller must be refused ──────────────────────────────

describe("getEvalComparisonHydrated — fail closed on absent org", () => {
  test("rejects when caller identity has no org claim (empty identity)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-2", suiteId: "suite-1" },
      });

    // A caller with an event but no org claim must NOT see another org's row.
    await expect(
      getEvalComparisonHydrated("cmp-1", { identity: {} }),
    ).rejects.toThrow(/org/i);
  });

  test("rejects when extractOrgFromEvent returns null (IAM/API-key caller)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparisons-test" })
      .resolves({
        Item: { comparisonId: "cmp-1", orgId: "org-1", suiteId: "suite-1" },
      });

    // No identity at all — must refuse, not pass through.
    await expect(
      getEvalComparisonHydrated("cmp-1", { identity: { sub: "u1" } }),
    ).rejects.toThrow(/org/i);
  });
});

// ── Finding (b): cross-agent/suite comparison guard ─────────────────────────

describe("computeEvalComparison — rejects mismatched agentTargetId / suiteId", () => {
  function setupComputeMocks(
    suite: EvalSuite,
    baselineRun: EvalRun,
    candidateRun: EvalRun,
  ) {
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-suites-test" })
      .resolves({ Item: suite });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: baselineRun.evalRunId },
      })
      .resolves({ Item: baselineRun });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-eval-runs-test",
        Key: { evalRunId: candidateRun.evalRunId },
      })
      .resolves({ Item: candidateRun });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({ Items: [scoredCaseResult()] });
    ddbMock
      .on(GetCommand, { TableName: "citadel-eval-comparison-config-test" })
      .resolves({});
    ddbMock.on(PutCommand).resolves({});
  }

  test("rejects baseline run with different agentTargetId than suite", async () => {
    const suite = frozenSuite({ agentTargetId: "agent-1" });
    const baseline = completedRun({
      evalRunId: "baseline-run",
      agentTargetId: "agent-WRONG",
    });
    const candidate = completedRun({
      evalRunId: "candidate-run",
      agentTargetId: "agent-1",
    });
    setupComputeMocks(suite, baseline, candidate);

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          baselineEvalRunId: "baseline-run",
          candidateEvalRunIds: ["candidate-run"],
          idempotencyKey: "k1",
        },
        authCtx("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*agent/i);
  });

  test("rejects candidate run with different agentTargetId than suite", async () => {
    const suite = frozenSuite({ agentTargetId: "agent-1" });
    const baseline = completedRun({
      evalRunId: "baseline-run",
      agentTargetId: "agent-1",
    });
    const candidate = completedRun({
      evalRunId: "candidate-run",
      agentTargetId: "agent-WRONG",
    });
    setupComputeMocks(suite, baseline, candidate);

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          baselineEvalRunId: "baseline-run",
          candidateEvalRunIds: ["candidate-run"],
          idempotencyKey: "k2",
        },
        authCtx("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*agent/i);
  });

  test("rejects baseline run with different suiteId than input", async () => {
    const suite = frozenSuite();
    const baseline = completedRun({
      evalRunId: "baseline-run",
      suiteId: "suite-OTHER",
    });
    const candidate = completedRun({ evalRunId: "candidate-run" });
    setupComputeMocks(suite, baseline, candidate);

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          baselineEvalRunId: "baseline-run",
          candidateEvalRunIds: ["candidate-run"],
          idempotencyKey: "k3",
        },
        authCtx("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*suite/i);
  });

  test("rejects candidate run with different suiteId than input", async () => {
    const suite = frozenSuite();
    const baseline = completedRun({ evalRunId: "baseline-run" });
    const candidate = completedRun({
      evalRunId: "candidate-run",
      suiteId: "suite-OTHER",
    });
    setupComputeMocks(suite, baseline, candidate);

    await expect(
      computeEvalComparison(
        {
          orgId: "org-1",
          suiteId: "suite-1",
          baselineEvalRunId: "baseline-run",
          candidateEvalRunIds: ["candidate-run"],
          idempotencyKey: "k4",
        },
        authCtx("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*suite/i);
  });
});
