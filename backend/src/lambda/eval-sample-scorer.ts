/**
 * eval-sample-scorer (Phase 2 §2.4/§2.5) — single writer of the
 * EvalProdSamples table.
 *
 * Consumes two event shapes:
 *  - `governance.eval.sample.captured` (from eval-sampling-selector.ts):
 *    reads the sanitized artifact, runs the pure `scoreProdSample`
 *    (deterministic dims only), SETs the EvalProdSamples row, and — since
 *    groundedness_faithfulness always lands PENDING for a prod sample
 *    (design §2.4: no per-case mustNotHallucinate flag to gate on) —
 *    emits `governance.eval.case.judge.requested` pointing at the SAME
 *    sanitized artifactRef the selector wrote, reusing the frozen
 *    judge.requested/judged contract verbatim.
 *  - `governance.eval.case.judged` (from the arbiter judge handler, same
 *    frozen contract): patches the row's PENDING faithfulness dimension
 *    to SCORED/UNKNOWN. Rejects (logs + drops) an event missing any of
 *    the three required reproducibility-stamp fields, same discipline as
 *    eval-case-scorer.ts's applyJudgedResult.
 *
 * Prod-sample requests reuse evalRunId/caseId as carrier fields on the
 * judge.requested/judged contract (no separate prod-specific contract is
 * introduced — the contract is FROZEN, design §2.5) by setting both to
 * the sample's own runId. This is the only way to route a prod-sample
 * judge request through the existing judge handler + existing consumer
 * dispatch without changing either.
 *
 * Single-writer invariant: the judge handler never writes
 * EvalProdSamples directly — this Lambda is the only writer.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { emitGovernanceEvent } from "../utils/notifier-base";
import { sanitizeUntrustedJson } from "../utils/sanitize-untrusted-json";
import { readSanitizedArtifact } from "./utils/eval-prod-scoring-io";
import {
  scoreProdSample,
  type ProdDimensionScore,
} from "./utils/eval-prod-scoring";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_PROD_SAMPLES_TABLE = process.env.EVAL_PROD_SAMPLES_TABLE!;

export interface SampleCapturedDetail {
  sampleId: string;
  orgId: string;
  agentId: string;
  runId: string;
  kind: "execution" | "conversation";
  artifactRef: string;
  dimensions: string[];
}

const FAITHFULNESS_RUBRIC =
  "Evaluate whether the response avoids hallucinating claims not supported by the available context. Score 0..1.";

/** Bucket key for AgentDimTimeIndex — hourly, UTC (design §2.4). */
function timeBucket(capturedAt: string): string {
  return capturedAt.slice(0, 13); // "YYYY-MM-DDTHH"
}

/**
 * Scores one captured prod sample end-to-end and SETs its row. Never
 * throws: any failure (artifact unreadable, write error) is logged and
 * the sample is dropped from scoring (the durably-written S3 artifact is
 * untouched — a future backfill/redelivery can retry).
 */
export async function scoreProdSampleEvent(
  detail: SampleCapturedDetail,
): Promise<void> {
  const artifact = await readSanitizedArtifact(detail.artifactRef);
  if (!artifact) {
    console.error(
      "eval-sample-scorer: sanitized artifact unreadable — dropping sample",
      { runId: detail.runId, orgId: detail.orgId },
    );
    return;
  }

  const scoreVector = scoreProdSample(artifact);
  const capturedAt = new Date().toISOString();

  try {
    await docClient.send(
      new PutCommand({
        TableName: EVAL_PROD_SAMPLES_TABLE,
        Item: {
          PK: `ORG#${detail.orgId}`,
          SK: `${capturedAt}#${detail.sampleId}`,
          sampleId: detail.sampleId,
          orgId: detail.orgId,
          agentId: detail.agentId,
          runId: detail.runId,
          kind: detail.kind,
          artifactRef: detail.artifactRef,
          scoreVector: JSON.stringify(scoreVector),
          capturedAt,
          GSI1PK: `AGENT#${detail.agentId}`,
          GSI1SK: `${timeBucket(capturedAt)}#${detail.sampleId}`,
        },
      }),
    );
  } catch (err: unknown) {
    console.error("eval-sample-scorer: write failed — dropping sample", {
      runId: detail.runId,
      orgId: detail.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const pendingJudgeDims = scoreVector.filter(
    (d): d is ProdDimensionScore & { dimension: "groundedness_faithfulness" } =>
      d.status === "PENDING" && d.basis === "JUDGE",
  );

  if (pendingJudgeDims.length > 0) {
    try {
      await emitGovernanceEvent("governance.eval.case.judge.requested", {
        evalRunId: detail.runId,
        caseId: detail.sampleId,
        orgId: detail.orgId,
        artifactRef: detail.artifactRef,
        judgeDimensions: [
          {
            dimension: "groundedness_faithfulness",
            rubric: FAITHFULNESS_RUBRIC,
          },
        ],
        judgeSlot: "judge",
      });
    } catch (err: unknown) {
      console.error(
        "eval-sample-scorer: emit governance.eval.case.judge.requested failed",
        {
          runId: detail.runId,
          orgId: detail.orgId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

export interface ProdJudgedDetail {
  evalRunId: string;
  caseId: string;
  orgId: string;
  dimension: "task_success" | "groundedness_faithfulness";
  status: "SCORED" | "UNKNOWN";
  verdict?: { kind: "score"; score: number };
  judgeModelId: string;
  judgeModelVersion: string;
  judgePromptHash: string;
}

const REQUIRED_STAMP_FIELDS: Array<keyof ProdJudgedDetail> = [
  "judgeModelId",
  "judgeModelVersion",
  "judgePromptHash",
];

/**
 * Applies a judged result to the matching EvalProdSamples row. Rejects
 * (logs + drops, never partially writes) an event missing any required
 * stamp field — same discipline as eval-case-scorer.ts's
 * applyJudgedResult. The event detail is untrusted cross-service input
 * (the judge is a different codebase/language) — every string field is
 * run through sanitizeUntrustedJson before being persisted (M2, same
 * discipline as eval-case-scorer.ts::applyJudgedResult).
 *
 * B1 fix (taskId 316427f2, CRITICAL): EvalProdSamplesTable is keyed
 * (PK, SK) with SK embedding capturedAt — {orgId, evalRunId} are NOT the
 * table's key attributes, so a Get on them does not match the schema.
 * The judged event's `caseId` is the row's `sampleId` (the "prod-sample
 * carrier convention", EVENTBRIDGE_CATALOG.md), so the row is located via
 * a Query on the sparse `SampleIdIndex` GSI — never a Scan, and never
 * fabricating capturedAt to reconstruct SK. EvalSampleJudgedRule routes
 * EVERY governance.eval.case.judged here, including normal eval-suite
 * judged events whose caseId is not a sampleId in this table at all — a
 * zero-result Query is a genuine, error-free no-op for that case (unlike
 * the previous Get, which threw ValidationException on every such
 * event).
 */
export async function applyProdJudgedResult(
  detail: ProdJudgedDetail,
): Promise<void> {
  const missing = REQUIRED_STAMP_FIELDS.filter((f) => !detail[f]);
  if (missing.length > 0) {
    console.error(
      "eval-sample-scorer: governance.eval.case.judged missing required stamp field(s) — dropping event",
      { runId: detail.evalRunId, sampleId: detail.caseId, missing },
    );
    return;
  }

  const sanitized = sanitizeUntrustedJson(detail)
    .value as unknown as ProdJudgedDetail;

  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_PROD_SAMPLES_TABLE,
      IndexName: "SampleIdIndex",
      KeyConditionExpression: "sampleId = :sampleId",
      ExpressionAttributeValues: { ":sampleId": sanitized.caseId },
      Limit: 1,
    }),
  );
  const row = res.Items?.[0] as
    | {
        PK: string;
        SK: string;
        orgId: string;
        runId: string;
        scoreVector?: string;
      }
    | undefined;

  if (!row || !row.scoreVector) {
    console.error(
      "eval-sample-scorer: prod-sample row (or scoreVector) not found for judged event — dropping (no-op, not an error)",
      { runId: sanitized.evalRunId, sampleId: sanitized.caseId },
    );
    return;
  }

  let existing: ProdDimensionScore[];
  try {
    existing = JSON.parse(row.scoreVector) as ProdDimensionScore[];
  } catch {
    console.error(
      "eval-sample-scorer: existing scoreVector is not valid JSON — dropping judged event",
      { runId: sanitized.evalRunId, sampleId: sanitized.caseId },
    );
    return;
  }

  const patched = existing.map((d): ProdDimensionScore => {
    if (d.dimension !== sanitized.dimension) return d;
    const base: ProdDimensionScore = {
      dimension: d.dimension as ProdDimensionScore["dimension"],
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
      TableName: EVAL_PROD_SAMPLES_TABLE,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: "SET scoreVector = :scoreVector",
      ExpressionAttributeValues: { ":scoreVector": JSON.stringify(patched) },
    }),
  );
}

export const handler = async (event: {
  "detail-type"?: string;
  detail?: SampleCapturedDetail | ProdJudgedDetail;
}): Promise<void> => {
  const detailType = event["detail-type"];
  if (detailType === "governance.eval.sample.captured") {
    await scoreProdSampleEvent(event.detail as SampleCapturedDetail);
    return;
  }
  if (detailType === "governance.eval.case.judged") {
    // Only handled here when the event correlates to a prod sample (the
    // caseId===sampleId carrier convention, design §2.5). A real eval-case
    // judged event is routed to eval-case-scorer.ts via its own separate
    // EventBridge rule target — both consumers receive every
    // governance.eval.case.judged delivery and each independently no-ops
    // via a GSI-Query miss (SampleIdIndex on caseId, never a Get on the
    // wrong key schema) if the row it owns does not exist, rather than
    // crashing on a mismatch.
    await applyProdJudgedResult(event.detail as ProdJudgedDetail);
    return;
  }
  console.error("eval-sample-scorer: unrecognized detail-type — no-op", {
    detailType,
  });
};
