/**
 * eval-run-aggregator.test.ts (CIT-103 Pass A) — consumes
 * governance.eval.run.completed. Self-sufficient (design §2): Queries
 * every case row for the run; for any COMPLETED case missing a
 * deterministic scoreVector, scores it inline (idempotent — same pure
 * scoreCase); then writes per-dimension scoreAggregates onto the
 * EvalRun row via aggregateScoreVectors(). NEVER scores inside the
 * completion-rollup path (that stays eval-run-completion.ts's job) —
 * this is a fully separate consumer.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.COST_LEDGER_TABLE = "citadel-cost-ledger-test";
process.env.SCORER_VERSION = "v1";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ssmMock = mockClient(SSMClient);

import { handler, aggregateEvalRun } from "../eval-run-aggregator";
import { __resetReplayBucketCacheForTests } from "../utils/eval-artifact-store";

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ssmMock.reset();
  __resetReplayBucketCacheForTests();
  ssmMock
    .on(GetParameterCommand)
    .resolves({ Parameter: { Value: "eval-replay-bucket-test" } });
});

function scoredVector() {
  return JSON.stringify([
    {
      dimension: "task_success",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "boolean", pass: true },
      detail: "",
    },
    {
      dimension: "policy_compliance",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "",
    },
    {
      dimension: "tool_accuracy",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "",
    },
    {
      dimension: "latency",
      status: "SCORED",
      basis: "DETERMINISTIC",
      measurement: 500,
      detail: "",
    },
    {
      dimension: "cost",
      status: "UNKNOWN",
      basis: "DETERMINISTIC",
      detail: "",
    },
    {
      dimension: "groundedness_citation",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "",
    },
    {
      dimension: "groundedness_faithfulness",
      status: "NOT_APPLICABLE",
      basis: "DETERMINISTIC",
      detail: "",
    },
  ]);
}

describe("aggregateEvalRun — self-sufficient run aggregation", () => {
  test("writes scoreAggregates onto the EvalRun row from existing scoreVectors", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [
          {
            evalRunId: "run-1",
            caseId: "case-1",
            status: "COMPLETED",
            scoreVector: scoredVector(),
          },
          {
            evalRunId: "run-1",
            caseId: "case-2",
            status: "COMPLETED",
            scoreVector: scoredVector(),
          },
        ],
      });
    ddbMock.on(UpdateCommand).resolves({});

    await aggregateEvalRun("run-1");

    const runUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runUpdate).toBeDefined();
    expect(runUpdate!.args[0].input.UpdateExpression).toContain(
      "scoreAggregates",
    );
    const values = runUpdate!.args[0].input.ExpressionAttributeValues as Record<
      string,
      unknown
    >;
    const aggregates = JSON.parse(values[":scoreAggregates"] as string);
    const taskSuccess = aggregates.find(
      (a: { dimension: string }) => a.dimension === "task_success",
    );
    expect(taskSuccess.passRate).toBe(1);
    expect(taskSuccess.scoredCount).toBe(2);
  });

  test("self-sufficient: scores inline (idempotent) any COMPLETED case missing a scoreVector", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [
          {
            evalRunId: "run-1",
            caseId: "case-unscored",
            orgId: "org-1",
            caseKind: "CONVERSATION",
            targetAdapter: "conversation",
            status: "COMPLETED",
            latencyMs: 700,
            suiteId: "suite-1",
            // scoreVector deliberately absent — race with the per-case scorer.
          },
        ],
      });
    ddbMock.on(GetCommand, { TableName: "citadel-eval-cases-test" }).resolves({
      Item: {
        suiteId: "suite-1",
        caseId: "case-unscored",
        requiredTools: [],
        forbiddenTools: [],
      },
    });
    ddbMock
      .on(QueryCommand, { TableName: "citadel-cost-ledger-test" })
      .resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});

    await aggregateEvalRun("run-1");

    // Inline scoring must SET a scoreVector on the case row (same shape
    // eval-case-scorer.ts writes) before aggregation.
    const caseUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-run-case-results-test" &&
          (c.args[0].input.UpdateExpression as string)?.includes("scoreVector"),
      );
    expect(caseUpdate).toBeDefined();

    const runUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runUpdate).toBeDefined();
  });

  test("does not re-score a COMPLETED case that already has a scoreVector", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [
          {
            evalRunId: "run-1",
            caseId: "case-1",
            status: "COMPLETED",
            scoreVector: scoredVector(),
          },
        ],
      });
    ddbMock.on(UpdateCommand).resolves({});

    await aggregateEvalRun("run-1");

    const caseScoreUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-run-case-results-test" &&
          (c.args[0].input.UpdateExpression as string)?.includes("scoreVector"),
      );
    expect(caseScoreUpdate).toBeUndefined();
  });

  test("ignores non-COMPLETED cases for inline scoring (FAILED/TIMEOUT cases have no artifact to score)", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [
          { evalRunId: "run-1", caseId: "case-failed", status: "FAILED" },
          { evalRunId: "run-1", caseId: "case-timeout", status: "TIMEOUT" },
        ],
      });
    ddbMock.on(UpdateCommand).resolves({});

    await aggregateEvalRun("run-1");

    const caseScoreUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-run-case-results-test" &&
          (c.args[0].input.UpdateExpression as string)?.includes("scoreVector"),
      );
    expect(caseScoreUpdate).toBeUndefined();

    const runUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runUpdate).toBeDefined();
  });

  test("aggregates with zero cases produces a zeroed aggregate array, never throws", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [],
      });
    ddbMock.on(UpdateCommand).resolves({});

    await expect(aggregateEvalRun("run-1")).resolves.not.toThrow();

    const runUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    const values = runUpdate!.args[0].input.ExpressionAttributeValues as Record<
      string,
      unknown
    >;
    const aggregates = JSON.parse(values[":scoreAggregates"] as string);
    expect(aggregates).toHaveLength(7);
  });
});

describe("handler — EventBridge routing", () => {
  test("routes governance.eval.run.completed to aggregateEvalRun", async () => {
    ddbMock
      .on(QueryCommand, { TableName: "citadel-eval-run-case-results-test" })
      .resolves({
        Items: [
          {
            evalRunId: "run-1",
            caseId: "case-1",
            status: "COMPLETED",
            scoreVector: scoredVector(),
          },
        ],
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler({
      "detail-type": "governance.eval.run.completed",
      detail: {
        evalRunId: "run-1",
        suiteId: "suite-1",
        orgId: "org-1",
        caseCounts: { total: 1, completed: 1, failed: 0, timeout: 0 },
        completedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1000,
      },
    });

    const runUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runUpdate).toBeDefined();
  });

  test("unrecognized detail-type is a no-op", async () => {
    await expect(
      handler({ "detail-type": "some.other.event", detail: {} }),
    ).resolves.not.toThrow();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
