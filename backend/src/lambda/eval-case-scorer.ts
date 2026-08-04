/**
 * eval-case-scorer.ts (CIT-103 Pass A) — per-case scoring event Lambda.
 *
 * Consumes `governance.eval.case.completed` (design §2): loads the case
 * row + its EvalCase definition + replay-package artifact (S3, when
 * artifactRef is present) + cost-ledger rows (via eval-scoring-io.ts,
 * shared with eval-run-aggregator.ts's self-sufficient fallback path),
 * maps them into the pure scoreCase() input shapes, and SETs the
 * resulting ScoreVector onto the case row idempotently (SET, not ADD — a
 * redelivery or re-score simply overwrites with identical bytes for
 * deterministic dims, design §5/§6). When any dimension lands PENDING
 * (opted into a judge-basis evaluation), emits
 * `governance.eval.case.judge.requested` for arbiter Python (Pass B) to
 * pick up.
 *
 * Also consumes `governance.eval.case.judged` (Pass B -> Pass A): TS is
 * the SINGLE WRITER of eval tables (design §7) — the judge handler never
 * writes DynamoDB directly. This module validates the required
 * reproducibility stamp (judgeModelId/judgeModelVersion/judgePromptHash)
 * is present before patching the case's PENDING dimension; an event
 * missing any stamp field is logged and DROPPED (never partially
 * applied). The event detail is untrusted cross-service input (Pass B is
 * a different codebase/language) — every string field is run through
 * sanitizeUntrustedJson before being written.
 *
 * Never scores inside the atomic completion-rollup (eval-run-completion.ts)
 * — this Lambda is a separate consumer, decoupled per design §2.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  emitGovernanceEvent,
  type GovernancePayloadMap,
} from "../utils/notifier-base";
import { sanitizeUntrustedJson } from "../utils/sanitize-untrusted-json";
import {
  scoreCase,
  type DimensionName,
  type DimensionScore,
} from "./utils/eval-scoring";
import {
  buildScoringInputs,
  getEvalCaseDefinition,
  getEvalRunCaseRow,
  readCostRows,
  readEvalArtifact,
  rubricFor,
} from "./utils/eval-scoring-io";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;
const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;
const SCORER_VERSION = process.env.SCORER_VERSION || "v1";

/**
 * Scores one eval case end-to-end and SETs its scoreVector. Exported for
 * direct unit testing and for the EventBridge handler's routing.
 */
export async function scoreEvalCase(
  evalRunId: string,
  caseId: string,
  artifactRef: string | undefined,
): Promise<void> {
  const caseRow = await getEvalRunCaseRow(
    EVAL_RUN_CASE_RESULTS_TABLE,
    evalRunId,
    caseId,
  );
  if (!caseRow) {
    console.error("eval-case-scorer: case row not found — skipping", {
      evalRunId,
      caseId,
    });
    return;
  }

  const evalCase = await getEvalCaseDefinition(
    EVAL_CASES_TABLE,
    caseRow.suiteId,
    caseId,
  );
  if (!evalCase) {
    console.error(
      "eval-case-scorer: EvalCase definition not found — skipping",
      {
        evalRunId,
        caseId,
        suiteId: caseRow.suiteId,
      },
    );
    return;
  }

  const resolvedArtifactRef = artifactRef ?? caseRow.artifactRef;
  const envelope = await readEvalArtifact(resolvedArtifactRef);
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
  const scoredAt = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      Key: { evalRunId, caseId },
      UpdateExpression:
        "SET scoreVector = :scoreVector, scoredAt = :scoredAt, scorerVersion = :scorerVersion",
      ExpressionAttributeValues: {
        ":scoreVector": JSON.stringify(scoreVector),
        ":scoredAt": scoredAt,
        ":scorerVersion": SCORER_VERSION,
      },
    }),
  );

  const pendingJudgeDims = scoreVector.filter(
    (
      d,
    ): d is DimensionScore & {
      dimension: "task_success" | "groundedness_faithfulness";
    } => d.status === "PENDING" && d.basis === "JUDGE",
  );

  if (pendingJudgeDims.length > 0) {
    const judgeDimensions = pendingJudgeDims.map((d) => ({
      dimension: d.dimension,
      rubric: rubricFor(d.dimension, evalCaseForScoring),
    }));
    await emitGovernanceEvent("governance.eval.case.judge.requested", {
      evalRunId,
      caseId,
      orgId: caseRow.orgId,
      ...(resolvedArtifactRef ? { artifactRef: resolvedArtifactRef } : {}),
      judgeDimensions,
      judgeSlot: "judge",
    });
  }
}

type JudgedDetail = GovernancePayloadMap["governance.eval.case.judged"];

const REQUIRED_STAMP_FIELDS: Array<keyof JudgedDetail> = [
  "judgeModelId",
  "judgeModelVersion",
  "judgePromptHash",
];

/**
 * Applies a landed governance.eval.case.judged result: patches the
 * matching PENDING dimension in the case's existing scoreVector to
 * SCORED/UNKNOWN. TS is the SINGLE WRITER of eval tables — this is the
 * only code path that ever writes a judge-sourced value into
 * EVAL_RUN_CASE_RESULTS_TABLE (design §7). Rejects (logs + drops, never
 * partially writes) an event missing any required stamp field. The event
 * detail is untrusted cross-service input — every string is sanitized via
 * sanitizeUntrustedJson before being persisted.
 */
export async function applyJudgedResult(detail: JudgedDetail): Promise<void> {
  const missing = REQUIRED_STAMP_FIELDS.filter((f) => !detail[f]);
  if (missing.length > 0) {
    console.error(
      "eval-case-scorer: governance.eval.case.judged missing required stamp field(s) — dropping event",
      {
        evalRunId: detail.evalRunId,
        caseId: detail.caseId,
        dimension: detail.dimension,
        missing,
      },
    );
    return;
  }

  const sanitized = sanitizeUntrustedJson(detail)
    .value as unknown as JudgedDetail;

  const caseRow = await getEvalRunCaseRow(
    EVAL_RUN_CASE_RESULTS_TABLE,
    sanitized.evalRunId,
    sanitized.caseId,
  );
  if (!caseRow || !caseRow.scoreVector) {
    console.error(
      "eval-case-scorer: case row (or scoreVector) not found for judged event — dropping",
      {
        evalRunId: sanitized.evalRunId,
        caseId: sanitized.caseId,
      },
    );
    return;
  }

  let existing: DimensionScore[];
  try {
    existing = JSON.parse(caseRow.scoreVector) as DimensionScore[];
  } catch {
    console.error(
      "eval-case-scorer: existing scoreVector is not valid JSON — dropping judged event",
      {
        evalRunId: sanitized.evalRunId,
        caseId: sanitized.caseId,
      },
    );
    return;
  }

  const patched = existing.map((d): DimensionScore => {
    if (d.dimension !== sanitized.dimension) return d;
    const base: DimensionScore = {
      dimension: d.dimension as DimensionName,
      status: sanitized.status,
      basis: "JUDGE",
      judgeModelId: sanitized.judgeModelId,
      judgeModelVersion: sanitized.judgeModelVersion,
      judgePromptHash: sanitized.judgePromptHash,
      detail: `judge-scored status=${sanitized.status}`,
    };
    if (sanitized.status === "SCORED" && sanitized.verdict) {
      base.verdict = sanitized.verdict;
    }
    return base;
  });

  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      Key: { evalRunId: sanitized.evalRunId, caseId: sanitized.caseId },
      UpdateExpression: "SET scoreVector = :scoreVector, scoredAt = :scoredAt",
      ExpressionAttributeValues: {
        ":scoreVector": JSON.stringify(patched),
        ":scoredAt": new Date().toISOString(),
      },
    }),
  );
}

interface EvalCaseCompletedDetail {
  evalRunId: string;
  caseId: string;
  orgId: string;
  caseKind: "CONVERSATION" | "EXECUTION";
  artifactRef?: string;
}

export const handler = async (event: {
  "detail-type"?: string;
  detail?: EvalCaseCompletedDetail | JudgedDetail;
}): Promise<void> => {
  const detailType = event["detail-type"];
  if (detailType === "governance.eval.case.completed") {
    const detail = event.detail as EvalCaseCompletedDetail;
    await scoreEvalCase(detail.evalRunId, detail.caseId, detail.artifactRef);
    return;
  }
  if (detailType === "governance.eval.case.judged") {
    await applyJudgedResult(event.detail as JudgedDetail);
    return;
  }
  console.error("eval-case-scorer: unrecognized detail-type — no-op", {
    detailType,
  });
};
