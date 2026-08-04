/**
 * eval-run-completion (CIT-102 Pass A) — shared atomic completion-rollup
 * helper.
 *
 * Design §2: each terminal case transition does a conditional atomic
 * `UpdateItem ... ADD pendingCases :neg1` on the run row; idempotent via a
 * per-case `completionRecorded` guard flag on the case row so a duplicate
 * completion event (SQS redelivery, EventBridge at-least-once) can't
 * double-decrement. Reaching 0 finalizes the run (status COMPLETED) and
 * emits `governance.eval.run.completed` (execution-outcome counts only —
 * no scores, CIT-103 owns verdicts).
 *
 * Used by both eval-conversation-worker.ts (Adapter B, inline synchronous
 * completion) and eval-runner.ts's execution-completion event handler
 * (Adapter A, async completion via `workflow.completed`/`workflow.failed`).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { emitGovernanceEvent } from "../utils/notifier-base";
import { materializeEvalCaseArtifact } from "./utils/eval-artifact-store";
import type { EvalCaseKindLiteral } from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_RUNS_TABLE = process.env.EVAL_RUNS_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

interface CaseCounts {
  total: number;
  completed: number;
  failed: number;
  timeout: number;
}

async function computeCaseCounts(evalRunId: string): Promise<CaseCounts> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      KeyConditionExpression: "evalRunId = :rid",
      ExpressionAttributeValues: { ":rid": evalRunId },
    }),
  );
  const items = (res.Items as Array<{ status?: string }> | undefined) ?? [];
  const counts: CaseCounts = {
    total: items.length,
    completed: 0,
    failed: 0,
    timeout: 0,
  };
  for (const item of items) {
    if (item.status === "COMPLETED") counts.completed += 1;
    else if (item.status === "FAILED") counts.failed += 1;
    else if (item.status === "TIMEOUT") counts.timeout += 1;
  }
  return counts;
}

interface EvalRunCaseRowForArtifact {
  evalRunId: string;
  caseId: string;
  orgId: string;
  status: string;
  caseKind: EvalCaseKindLiteral;
  executionId?: string;
  conversationId?: string;
}

/**
 * Loads the case row and, if its status is COMPLETED, builds + writes its
 * replay-package artifact and stamps artifactRef/artifactKind onto the row.
 * Every failure mode (missing row, missing source id, bucket unresolved,
 * build/write error) degrades to a no-op — never throws, never blocks the
 * caller's pendingCases decrement.
 */
async function materializeArtifactIfCompleted(
  evalRunId: string,
  caseId: string,
): Promise<void> {
  try {
    const res = await docClient.send(
      new GetCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        Key: { evalRunId, caseId },
      }),
    );
    const caseRow = res.Item as EvalRunCaseRowForArtifact | undefined;
    if (!caseRow || caseRow.status !== "COMPLETED") {
      return;
    }

    const kind =
      caseRow.caseKind === "EXECUTION" ? "execution" : "conversation";
    const sourceId =
      kind === "execution" ? caseRow.executionId : caseRow.conversationId;
    if (!sourceId) {
      console.warn(
        "eval-run-completion: COMPLETED case has no source id for its kind — skipping artifact materialization",
        { evalRunId, caseId, kind },
      );
      return;
    }

    const { artifactRef, artifactKind } = await materializeEvalCaseArtifact(
      evalRunId,
      caseId,
      caseRow.orgId,
      kind,
      sourceId,
    );

    if (!artifactRef) {
      // Graceful degradation already logged inside materializeEvalCaseArtifact.
      return;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        Key: { evalRunId, caseId },
        UpdateExpression: "SET artifactRef = :ref, artifactKind = :kind",
        ExpressionAttributeValues: {
          ":ref": artifactRef,
          ":kind": artifactKind,
        },
      }),
    );
  } catch (err: unknown) {
    console.error(
      "eval-run-completion: materializeArtifactIfCompleted failed — artifactRef left unset",
      {
        evalRunId,
        caseId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Record that a case reached a terminal state. Guards against duplicate
 * completion events via a conditional update on the case row
 * (`attribute_not_exists(completionRecorded)`); a
 * `ConditionalCheckFailedException` here means this case's completion was
 * already recorded, so the function returns without touching the run row
 * at all — no double-decrement.
 *
 * F4 (design §6): for a case whose status is COMPLETED at the time this
 * runs, materializes its replay-package artifact (via the UNCHANGED
 * `assembleReplayPackage` — reused, not rebuilt) to the replay bucket under
 * `eval-runs/{evalRunId}/{caseId}.json`, and sets `artifactRef`/
 * `artifactKind` on the case row. FAILED/TIMEOUT cases are recorded (their
 * pendingCases decrement) but never materialize an artifact — there is no
 * completed execution/conversation to build a replay package from.
 * Artifact materialization NEVER throws (graceful degradation is handled
 * entirely inside materializeEvalCaseArtifact) and never blocks or fails
 * the completion-recording/pendingCases-decrement path.
 */
export async function recordCaseCompletion(
  evalRunId: string,
  caseId: string,
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        Key: { evalRunId, caseId },
        UpdateExpression: "SET completionRecorded = :true",
        ConditionExpression: "attribute_not_exists(completionRecorded)",
        ExpressionAttributeValues: { ":true": true },
      }),
    );
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      // Already recorded — duplicate redelivery, no-op.
      return;
    }
    throw err;
  }

  await materializeArtifactIfCompleted(evalRunId, caseId);

  // CIT-103 Pass A (design §2): additive per-case scoring trigger. Fired
  // for EVERY terminal case (COMPLETED/FAILED/TIMEOUT alike) — the scorer
  // Lambda itself decides what, if anything, is scoreable for a non-
  // COMPLETED case (today: nothing, since there is no artifact). This
  // computes NO scores here — the "no scores, CIT-103 owns verdicts"
  // contract for this function is unchanged. Read the just-fetched case
  // row's caseKind straight off the same GetCommand result
  // materializeArtifactIfCompleted already performed internally is not
  // exposed here, so re-fetch the minimal fields needed for the event
  // payload — a second GetItem, but on the same hot key, kept out of the
  // critical completionRecorded/pendingCases-decrement path below (this
  // emit is purely additive and best-effort, same discipline as the
  // existing governance.eval.run.completed emit).
  try {
    const caseRowRes = await docClient.send(
      new GetCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        Key: { evalRunId, caseId },
      }),
    );
    const caseRowForEvent = caseRowRes.Item as
      | {
          orgId: string;
          caseKind: EvalCaseKindLiteral;
          artifactRef?: string;
        }
      | undefined;
    if (caseRowForEvent) {
      await emitGovernanceEvent("governance.eval.case.completed", {
        evalRunId,
        caseId,
        orgId: caseRowForEvent.orgId,
        caseKind: caseRowForEvent.caseKind,
        ...(caseRowForEvent.artifactRef
          ? { artifactRef: caseRowForEvent.artifactRef }
          : {}),
      });
    }
  } catch (err) {
    // Best-effort — failure never blocks the completion-rollup below
    // (same discipline as the governance.eval.run.completed emit).
    console.error(
      "eval-run-completion: emit governance.eval.case.completed failed",
      {
        evalRunId,
        caseId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  const runUpdateRes = await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUNS_TABLE,
      Key: { evalRunId },
      UpdateExpression: "ADD pendingCases :neg1",
      ExpressionAttributeValues: { ":neg1": -1 },
      ReturnValues: "ALL_NEW",
    }),
  );

  const run = runUpdateRes.Attributes as
    | {
        evalRunId: string;
        orgId: string;
        suiteId: string;
        pendingCases: number;
        startedAt?: string;
      }
    | undefined;

  if (!run || run.pendingCases > 0) {
    return;
  }

  // pendingCases reached zero — finalize the run.
  const now = new Date().toISOString();
  const startedAtMs = run.startedAt
    ? new Date(run.startedAt).getTime()
    : now.length
      ? Date.now()
      : 0;
  const durationMs = Math.max(0, Date.now() - startedAtMs);

  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUNS_TABLE,
      Key: { evalRunId },
      UpdateExpression:
        "SET #status = :completedStatus, completedAt = :completedAt, durationMs = :durationMs",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":completedStatus": "COMPLETED",
        ":completedAt": now,
        ":durationMs": durationMs,
      },
    }),
  );

  const caseCounts = await computeCaseCounts(evalRunId);

  try {
    await emitGovernanceEvent("governance.eval.run.completed", {
      evalRunId: run.evalRunId,
      suiteId: run.suiteId,
      orgId: run.orgId,
      caseCounts,
      completedAt: now,
      durationMs,
    });
  } catch (err) {
    // Best-effort — failure does not roll back the finalized run row
    // (same discipline as governance.constitutional.rule.changed).
    console.error(
      "eval-run-completion: emit governance.eval.run.completed failed",
      err,
    );
  }
}
