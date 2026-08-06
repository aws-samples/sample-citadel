/**
 * eval-run-aggregator.ts (CIT-103 Pass A) — consumes
 * `governance.eval.run.completed` and writes per-dimension
 * `scoreAggregates` onto the EvalRun row.
 *
 * SELF-SUFFICIENT (design §2): the per-case eval-case-scorer.ts path is
 * an optimization, not a guarantee — this aggregator Queries every case
 * row for the run and, for any COMPLETED case missing a deterministic
 * scoreVector (race between this run-completion event and the per-case
 * scorer, or a prior scorer failure), computes it inline via the SAME
 * pure scoreCase() (idempotent — SET, not ADD) before aggregating. A
 * COMPLETED case that already has a scoreVector is never re-scored here.
 * FAILED/TIMEOUT cases are never scored (no artifact exists for them).
 *
 * NEVER a composite single number — aggregateScoreVectors() (design §4)
 * returns one DimensionAggregate per dimension; see
 * eval-no-composite.guard.test.ts.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { scoreCase, type DimensionScore } from "./utils/eval-scoring";
import {
  aggregateScoreVectors,
  type CaseScoreRowForAggregation,
} from "./utils/eval-score-aggregate";
import {
  buildScoringInputs,
  getEvalCaseDefinition,
  readCostRows,
  readEvalArtifact,
  type EvalRunCaseRow,
} from "./utils/eval-scoring-io";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_RUNS_TABLE = process.env.EVAL_RUNS_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;
const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;
const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;
const SCORER_VERSION = process.env.SCORER_VERSION || "v1";

async function listCaseRows(evalRunId: string): Promise<EvalRunCaseRow[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      KeyConditionExpression: "evalRunId = :rid",
      ExpressionAttributeValues: { ":rid": evalRunId },
    }),
  );
  return (res.Items as EvalRunCaseRow[] | undefined) ?? [];
}

/**
 * Inline fallback scoring for one COMPLETED case missing a scoreVector.
 * Mirrors eval-case-scorer.ts's scoreEvalCase mapping exactly (via the
 * shared eval-scoring-io.ts helpers) so the two paths can never silently
 * diverge in how they build scoreCase()'s inputs. Never throws: any
 * failure is logged and the case is skipped for this aggregation pass
 * (it remains missing a scoreVector and will be retried on the next
 * run.completed/case.completed delivery).
 */
async function scoreMissingCaseInline(
  caseRow: EvalRunCaseRow,
): Promise<DimensionScore[] | undefined> {
  try {
    const evalCase = await getEvalCaseDefinition(
      EVAL_CASES_TABLE,
      caseRow.suiteId,
      caseRow.caseId,
    );
    if (!evalCase) {
      console.error(
        "eval-run-aggregator: EvalCase definition not found for inline scoring — skipping",
        {
          evalRunId: caseRow.evalRunId,
          caseId: caseRow.caseId,
          suiteId: caseRow.suiteId,
        },
      );
      return undefined;
    }

    const envelope = await readEvalArtifact(caseRow.artifactRef);
    const costRows = await readCostRows(
      COST_LEDGER_TABLE,
      caseRow.executionId,
      caseRow.conversationId,
    );
    const { caseRowForScoring, artifact, evalCaseForScoring } =
      buildScoringInputs(caseRow, evalCase, envelope, costRows);
    const scoreVector = scoreCase(
      caseRowForScoring,
      artifact,
      evalCaseForScoring,
    );

    await docClient.send(
      new UpdateCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        Key: { evalRunId: caseRow.evalRunId, caseId: caseRow.caseId },
        UpdateExpression:
          "SET scoreVector = :scoreVector, scoredAt = :scoredAt, scorerVersion = :scorerVersion",
        ExpressionAttributeValues: {
          ":scoreVector": JSON.stringify(scoreVector),
          ":scoredAt": new Date().toISOString(),
          ":scorerVersion": SCORER_VERSION,
        },
      }),
    );

    return scoreVector;
  } catch (err) {
    console.error(
      "eval-run-aggregator: inline fallback scoring failed — case left unscored for this pass",
      {
        evalRunId: caseRow.evalRunId,
        caseId: caseRow.caseId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}

/**
 * Aggregates one eval run's per-case ScoreVectors and writes
 * scoreAggregates onto the EvalRun row. Exported for direct unit testing
 * and for the EventBridge handler's routing.
 */
export async function aggregateEvalRun(evalRunId: string): Promise<void> {
  const caseRows = await listCaseRows(evalRunId);

  const aggregationRows: CaseScoreRowForAggregation[] = [];
  for (const caseRow of caseRows) {
    if (caseRow.scoreVector) {
      try {
        aggregationRows.push({
          caseId: caseRow.caseId,
          scoreVector: JSON.parse(caseRow.scoreVector) as DimensionScore[],
        });
      } catch {
        console.error(
          "eval-run-aggregator: existing scoreVector is not valid JSON — treating as missing",
          {
            evalRunId,
            caseId: caseRow.caseId,
          },
        );
      }
      continue;
    }

    if (caseRow.status !== "COMPLETED") {
      // FAILED/TIMEOUT cases have no artifact to score — never
      // fallback-scored; simply absent from this run's aggregation.
      continue;
    }

    const scoreVector = await scoreMissingCaseInline(caseRow);
    if (scoreVector) {
      aggregationRows.push({ caseId: caseRow.caseId, scoreVector });
    }
  }

  const aggregates = aggregateScoreVectors(aggregationRows);

  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUNS_TABLE,
      Key: { evalRunId },
      UpdateExpression: "SET scoreAggregates = :scoreAggregates",
      ExpressionAttributeValues: {
        ":scoreAggregates": JSON.stringify(aggregates),
      },
    }),
  );
}

interface EvalRunCompletedDetail {
  evalRunId: string;
  suiteId: string;
  orgId: string;
  caseCounts: {
    total: number;
    completed: number;
    failed: number;
    timeout: number;
  };
  completedAt: string;
  durationMs: number;
}

export const handler = async (event: {
  "detail-type"?: string;
  detail?: EvalRunCompletedDetail;
}): Promise<void> => {
  const detailType = event["detail-type"];
  if (detailType === "governance.eval.run.completed") {
    const detail = event.detail as EvalRunCompletedDetail;
    await aggregateEvalRun(detail.evalRunId);
    return;
  }
  console.error("eval-run-aggregator: unrecognized detail-type — no-op", {
    detailType,
  });
};
