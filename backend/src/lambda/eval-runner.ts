/**
 * eval-runner (CIT-102 Pass A) — dedicated event-driven eval-run driver.
 *
 * Design §1: NOT stepRunner-DAG reuse, NOT Step Functions. Fan-out is a
 * dedicated SQS `EvalDispatchQueue`; bounded concurrency comes from the
 * queue's consumer Lambda event-source-mapping `maxConcurrency` (CDK-side,
 * governance-stack.ts), not a hand-rolled semaphore here.
 *
 * FROZEN CONTRACT (Pass A -> Pass B), verbatim: execution row + dispatch
 * detail additive keys `evalRunId: string`, `evalContext: true`,
 * `forbiddenTools: string[]`.
 *
 * Two dispatch adapters (design §3), mapped from EvalCase.kind:
 *  - Adapter A (EXECUTION): dispatchExecutionCase — writes an execution row
 *    + emits `execution.start.requested`; stepRunner reused UNCHANGED one
 *    level down (arbiter, Pass B territory — this file only emits the
 *    event).
 *  - Adapter B (CONVERSATION): fan-out enqueues to the SQS dispatch queue;
 *    the eval-conversation-worker Lambda (separate file) consumes it.
 *
 * Completion is event-driven: `handleWorkflowCompletion` subscribes to the
 * SAME `workflow.completed`/`workflow.failed` events stepRunner already
 * emits (arbiter/stepRunner/events.py publish_workflow_completed), mapping
 * back to the eval case-result row via `executionId`.
 *
 * `sweepTimeouts` is the periodic (EventBridge scheduled rule) safety net:
 * any DISPATCHED/RUNNING case past its `deadlineAt` is marked TIMEOUT so a
 * stuck target cannot hang a run forever (design §3).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { v4 as uuidv4 } from "uuid";
import { mintRunId, buildDispatchContext } from "../utils/run-id";
import { recordCaseCompletion } from "./eval-run-completion";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});
const sqsClient = new SQSClient({});

const EVAL_RUNS_TABLE = process.env.EVAL_RUNS_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;
const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;
const EXECUTIONS_TABLE = process.env.EXECUTIONS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const EVAL_DISPATCH_QUEUE_URL = process.env.EVAL_DISPATCH_QUEUE_URL!;

interface EvalRunCaseRow {
  evalRunId: string;
  caseId: string;
  caseKind: "CONVERSATION" | "EXECUTION";
  status: string;
}

interface EvalCaseRow {
  suiteId: string;
  caseId: string;
  forbiddenTools?: string[];
  input?: { prompt?: string | null; structuredInput?: string | null };
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

async function listPendingCases(evalRunId: string): Promise<EvalRunCaseRow[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      KeyConditionExpression: "evalRunId = :rid",
      ExpressionAttributeValues: { ":rid": evalRunId },
    }),
  );
  const items = (res.Items as EvalRunCaseRow[] | undefined) ?? [];
  return items.filter((i) => i.status === "PENDING");
}

async function getEvalCase(
  suiteId: string,
  caseId: string,
): Promise<EvalCaseRow | undefined> {
  // EvalCasesTable PK is suiteId, SK caseId (CIT-101). fanOutEvalRun
  // receives suiteId from the eval run row (the parent suite is fixed for
  // the lifetime of a run) and threads it here so the correct composite
  // key is used — this is the actual denied-set lookup that the sandbox
  // block-only enforcement (design §4) depends on downstream in Pass B.
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_CASES_TABLE, Key: { suiteId, caseId } }),
  );
  return res.Item as EvalCaseRow | undefined;
}

/**
 * Attempt to transition a case PENDING -> DISPATCHED. Returns true if this
 * caller won the transition (i.e., should proceed to enqueue/dispatch),
 * false if the case was already past PENDING (redelivery guard — design
 * §2 "a case is dispatched only if its case-result row is PENDING").
 */
async function tryMarkDispatched(
  evalRunId: string,
  caseId: string,
): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        Key: { evalRunId, caseId },
        UpdateExpression: "SET #status = :dispatched, dispatchedAt = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":dispatched": "DISPATCHED",
          ":pending": "PENDING",
          ":now": new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * Fan out every PENDING case of a run to its kind-appropriate dispatch
 * path. CONVERSATION-kind cases are enqueued to the SQS EvalDispatchQueue
 * (bounded concurrency via the consumer Lambda's event-source-mapping
 * maxConcurrency); EXECUTION-kind cases dispatch immediately (they are
 * fully async themselves — the executor emits completion later).
 *
 * `suiteId` (the case's parent suite — fixed for the run's lifetime) and
 * `agentTargetId` (the run's actual dispatch target — a workflowId for
 * EXECUTION-kind cases, an agent config id for CONVERSATION-kind cases)
 * come from the EvalRun row, NOT from the case row: a case's own caseId
 * is never a valid dispatch target.
 */
export async function fanOutEvalRun(
  evalRunId: string,
  suiteId: string,
  agentTargetId: string,
  orgId: string,
  maxLatencyMs: number,
): Promise<void> {
  const pending = await listPendingCases(evalRunId);
  for (const caseRow of pending) {
    const won = await tryMarkDispatched(evalRunId, caseRow.caseId);
    if (!won) continue;

    const evalCase = await getEvalCase(suiteId, caseRow.caseId);
    const forbiddenTools = evalCase?.forbiddenTools ?? [];

    if (caseRow.caseKind === "CONVERSATION") {
      const body = buildDispatchContext({
        runId: mintRunId(),
        evalRunId,
        caseId: caseRow.caseId,
        orgId,
        agentTargetId,
        prompt: evalCase?.input?.prompt ?? "",
        forbiddenTools,
        evalContext: true,
        maxLatencyMs,
      });
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: EVAL_DISPATCH_QUEUE_URL,
          MessageBody: JSON.stringify(body),
        }),
      );
    } else {
      await dispatchExecutionCase({
        evalRunId,
        caseId: caseRow.caseId,
        orgId,
        agentTargetId,
        forbiddenTools,
        evalContext: true,
        maxLatencyMs,
      });
    }
  }
}

export interface ExecutionCaseDispatchInput {
  evalRunId: string;
  caseId: string;
  orgId: string;
  /** workflowId (or the seeded single-node harness workflow id) for the target. */
  agentTargetId: string;
  forbiddenTools: string[];
  evalContext: true;
  maxLatencyMs: number;
}

/**
 * Adapter A: dispatch an EXECUTION-kind eval case. Writes a real
 * EXECUTIONS_TABLE row (mirrors execution-resolver.ts's startExecution)
 * carrying the FROZEN CONTRACT additive keys, then emits
 * `execution.start.requested` so stepRunner runs the DAG UNCHANGED.
 */
export async function dispatchExecutionCase(
  input: ExecutionCaseDispatchInput,
): Promise<void> {
  const executionId = uuidv4();
  const runId = mintRunId();
  const now = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: EXECUTIONS_TABLE,
      Item: {
        executionId,
        workflowId: input.agentTargetId,
        orgId: input.orgId,
        status: "pending",
        currentNode: null,
        nodeResults: {},
        input: null,
        output: null,
        startedAt: now,
        completedAt: null,
        triggeredBy: "eval-runner",
        error: null,
        runId,
        evalRunId: input.evalRunId,
        evalContext: input.evalContext,
        forbiddenTools: input.forbiddenTools,
      },
    }),
  );

  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      Key: { evalRunId: input.evalRunId, caseId: input.caseId },
      UpdateExpression:
        "SET executionId = :executionId, runId = :runId, deadlineAt = :deadlineAt",
      ExpressionAttributeValues: {
        ":executionId": executionId,
        ":runId": runId,
        ":deadlineAt": new Date(Date.now() + input.maxLatencyMs).toISOString(),
      },
    }),
  );

  const dispatchContext = buildDispatchContext({
    runId,
    executionId,
    workflowId: input.agentTargetId,
    evalRunId: input.evalRunId,
    evalContext: input.evalContext,
    forbiddenTools: input.forbiddenTools,
  });

  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "citadel.workflows",
          DetailType: "execution.start.requested",
          Detail: JSON.stringify(dispatchContext),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    }),
  );
}

/**
 * Maps a `workflow.completed`/`workflow.failed` event back to the eval
 * case-result row it belongs to. The event detail itself (arbiter/stepRunner
 * publish_workflow_completed/failed) carries only `executionId`/`workflowId`
 * — no `evalRunId` (arbiter is Pass B, untouched). Instead of requiring the
 * caller to have threaded `evalRunId` onto the event (which would need an
 * arbiter-side change), this handler reads the EXECUTIONS_TABLE row by
 * `executionId` directly: `dispatchExecutionCase` already stamps `evalRunId`
 * onto that row (FROZEN CONTRACT), so the mapping is self-contained on the
 * TS side. A non-eval execution (no `evalRunId` on its row) is a no-op.
 */
export async function handleWorkflowCompletion(
  detail: { executionId: string },
  outcome: "COMPLETED" | "FAILED",
): Promise<void> {
  const execRes = await docClient.send(
    new GetCommand({
      TableName: EXECUTIONS_TABLE,
      Key: { executionId: detail.executionId },
    }),
  );
  const execution = execRes.Item as { evalRunId?: string } | undefined;
  if (!execution?.evalRunId) return;

  const evalRunId = execution.evalRunId;

  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      KeyConditionExpression: "evalRunId = :rid",
      ExpressionAttributeValues: { ":rid": evalRunId },
    }),
  );
  const items =
    (res.Items as
      | Array<{ evalRunId: string; caseId: string; executionId?: string }>
      | undefined) ?? [];
  const match = items.find((i) => i.executionId === detail.executionId);
  if (!match) return;

  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      Key: { evalRunId: match.evalRunId, caseId: match.caseId },
      UpdateExpression: "SET #status = :status, completedAt = :completedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": outcome === "COMPLETED" ? "COMPLETED" : "FAILED",
        ":completedAt": new Date().toISOString(),
      },
    }),
  );

  await recordCaseCompletion(match.evalRunId, match.caseId);
}

interface EvalRunSummary {
  evalRunId: string;
  status: string;
}

/**
 * Lists every run currently in a non-terminal status (PENDING/RUNNING),
 * across all orgs. No status GSI exists (design §5/§9 "no new GSI this
 * pass" stance carried over here) so this uses a status-filtered Scan —
 * consistent with the periodic-scheduled-job precedent already in the
 * codebase (cost-ledger-reconciler.ts), acceptable because EvalRunsTable
 * cardinality is bounded (one row per eval run, not per case) and this
 * runs on an infrequent EventBridge schedule, never per-request.
 */
async function listActiveRuns(): Promise<EvalRunSummary[]> {
  const res = await docClient.send(
    new ScanCommand({
      TableName: EVAL_RUNS_TABLE,
      FilterExpression: "#status IN (:pending, :running)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pending": "PENDING",
        ":running": "RUNNING",
      },
    }),
  );
  return (res.Items as EvalRunSummary[] | undefined) ?? [];
}

/**
 * Periodic safety net (EventBridge scheduled rule -> this Lambda in
 * "sweep" mode): scans every active run's case rows and marks any
 * DISPATCHED/RUNNING case past its `deadlineAt` as TIMEOUT, recording
 * completion. Bounded by active-run count; no Scan of the case-results
 * table itself (each run's cases are a single Query on evalRunId).
 */
export async function sweepTimeouts(): Promise<void> {
  const runs = await listActiveRuns();
  const now = Date.now();

  for (const run of runs) {
    if (run.status !== "RUNNING" && run.status !== "PENDING") continue;

    const casesRes = await docClient.send(
      new QueryCommand({
        TableName: EVAL_RUN_CASE_RESULTS_TABLE,
        KeyConditionExpression: "evalRunId = :rid",
        ExpressionAttributeValues: { ":rid": run.evalRunId },
      }),
    );
    const cases =
      (casesRes.Items as
        | Array<{
            evalRunId: string;
            caseId: string;
            status: string;
            deadlineAt?: string;
          }>
        | undefined) ?? [];

    for (const c of cases) {
      if (c.status !== "DISPATCHED" && c.status !== "RUNNING") continue;
      if (!c.deadlineAt) continue;
      if (new Date(c.deadlineAt).getTime() > now) continue;

      await docClient.send(
        new UpdateCommand({
          TableName: EVAL_RUN_CASE_RESULTS_TABLE,
          Key: { evalRunId: c.evalRunId, caseId: c.caseId },
          UpdateExpression:
            "SET #status = :status, completedAt = :completedAt, timedOut = :true",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "TIMEOUT",
            ":completedAt": new Date().toISOString(),
            ":true": true,
          },
        }),
      );
      await recordCaseCompletion(c.evalRunId, c.caseId);
    }
  }
}

/**
 * Lambda entry point (design §9/§1 F3 fix — this Lambda must be reachable):
 * two invocation shapes, discriminated by EventBridge `detail-type`:
 *  - `workflow.completed` / `workflow.failed` (Source citadel.workflows,
 *    emitted unchanged by arbiter/stepRunner) -> handleWorkflowCompletion.
 *  - EventBridge scheduled rule (`detail-type` absent, a plain scheduled
 *    invocation) -> sweepTimeouts.
 */
export const handler = async (event: {
  "detail-type"?: string;
  detail?: { executionId: string };
}): Promise<void> => {
  const detailType = event["detail-type"];
  if (detailType === "workflow.completed") {
    await handleWorkflowCompletion(event.detail!, "COMPLETED");
    return;
  }
  if (detailType === "workflow.failed") {
    await handleWorkflowCompletion(event.detail!, "FAILED");
    return;
  }
  // No matching detail-type: treat as the scheduled sweep invocation.
  await sweepTimeouts();
};
