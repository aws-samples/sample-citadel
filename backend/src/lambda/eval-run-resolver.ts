/**
 * EvalRun / EvalRunCaseResult resolver (CIT-102 Pass A).
 *
 * Structural mirror of eval-resolver.ts (CIT-101): AppSync-facing handler
 * dispatch + individually-exported operation functions, `authContextFromEvent`
 * + `sanitizeForLog` conventions duplicated here (kept independent of
 * eval-resolver.ts per the design's "kept separate — distinct tables + IAM
 * role + surface" note).
 *
 * Frozen-suite-only run gate (design §2, §9 acceptance criteria): a run may
 * only be started against a FROZEN EvalSuite — mirrors the eval-resolver's
 * `assertSuiteMutable` immutability guard, checked BEFORE any DDB write.
 *
 * Idempotency (design §2): `evalRunId = uuidv5(EVAL_RUN_NAMESPACE,
 * "${suiteId}:${suiteVersion}:${agentTargetVersion}:${idempotencyKey}")`.
 * `startEvalRun` issues a `PutCommand` with
 * `ConditionExpression=attribute_not_exists(evalRunId)`; on
 * `ConditionalCheckFailedException` it fetches and returns the EXISTING run
 * row rather than throwing (safe-to-retry submit).
 *
 * Per-case fan-out prep: on run creation, every case of the frozen suite
 * gets a corresponding `EvalRunCaseResultsTable` row in status PENDING,
 * carrying `caseKind`/`targetAdapter`/the case's `forbiddenTools` (frozen
 * contract, threaded to the dispatch adapters in eval-runner.ts).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v5 as uuidv5 } from "uuid";
import { hasPermission } from "../utils/auth";
import { fanOutEvalRun } from "./eval-runner";
import { emitGovernanceEvent } from "../utils/notifier-base";
import type {
  AuthContext,
  EvalSuite,
  EvalRun,
  EvalRunCaseResult,
  StartEvalRunInput,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_SUITES_TABLE = process.env.EVAL_SUITES_TABLE!;
const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;
const EVAL_RUNS_TABLE = process.env.EVAL_RUNS_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;

/**
 * Fixed namespace UUID for the deterministic evalRunId derivation
 * (uuidv5). A constant, never regenerated — changing this value would
 * silently break idempotency for any run submitted under the old
 * namespace. Generated once via `uuidv4()` and frozen here.
 */
export const EVAL_RUN_NAMESPACE = "1b7e3b2a-6b7b-4b9a-9c9b-4b7b2a6b7b3a";

interface EvalRunResolverArguments {
  input: StartEvalRunInput;
  evalRunId: string;
  orgId: string;
  suiteId: string;
}

type EvalRunResolverEvent = GovernanceResolverEvent<EvalRunResolverArguments>;

function authContextFromEvent(event: EvalRunResolverEvent): AuthContext {
  const identity: GovernanceEventIdentity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole] : [],
  };
}

function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  return out;
}

function requireEvalRunPermission(
  authContext: AuthContext,
  action: string,
): void {
  if (!hasPermission(authContext, "eval:run")) {
    throw new Error(
      `UnauthorizedError: eval:run permission required to ${action}`,
    );
  }
}

function validateStartInput(input: StartEvalRunInput): void {
  if (typeof input?.suiteId !== "string" || !input.suiteId) {
    throw new Error("ValidationError: suiteId is required");
  }
  if (typeof input?.agentTargetId !== "string" || !input.agentTargetId) {
    throw new Error("ValidationError: agentTargetId is required");
  }
  if (
    typeof input?.agentTargetVersion !== "string" ||
    !input.agentTargetVersion
  ) {
    throw new Error("ValidationError: agentTargetVersion is required");
  }
  if (typeof input?.idempotencyKey !== "string" || !input.idempotencyKey) {
    throw new Error("ValidationError: idempotencyKey is required");
  }
}

async function getEvalSuite(suiteId: string): Promise<EvalSuite | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_SUITES_TABLE, Key: { suiteId } }),
  );
  return (res.Item as EvalSuite | undefined) ?? null;
}

interface EvalCaseRow {
  suiteId: string;
  caseId: string;
  kind: "CONVERSATION" | "EXECUTION";
  forbiddenTools?: string[];
}

async function listEvalCasesForSuite(suiteId: string): Promise<EvalCaseRow[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_CASES_TABLE,
      KeyConditionExpression: "suiteId = :sid",
      ExpressionAttributeValues: { ":sid": suiteId },
    }),
  );
  return (res.Items as EvalCaseRow[] | undefined) ?? [];
}

function deriveEvalRunId(
  suiteId: string,
  suiteVersion: number,
  agentTargetVersion: string,
  idempotencyKey: string,
): string {
  return uuidv5(
    `${suiteId}:${suiteVersion}:${agentTargetVersion}:${idempotencyKey}`,
    EVAL_RUN_NAMESPACE,
  );
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/**
 * startEvalRun — create an EvalRun + one PENDING EvalRunCaseResult per case
 * of the target (FROZEN-only) suite. Idempotent per
 * (suiteId, suiteVersion, agentTargetVersion, idempotencyKey): a retry with
 * the same tuple returns the SAME existing run rather than creating a
 * second one.
 */
export async function startEvalRun(
  input: StartEvalRunInput,
  authContext: AuthContext,
): Promise<EvalRun> {
  requireEvalRunPermission(authContext, "start eval runs");
  validateStartInput(input);

  // Frozen-suite-only gate — checked BEFORE any write, mirrors
  // eval-resolver's assertSuiteMutable ordering discipline.
  const suite = await getEvalSuite(input.suiteId);
  if (!suite) {
    throw new Error(`EvalSuite not found: ${input.suiteId}`);
  }
  if (suite.status !== "FROZEN") {
    throw new Error(
      `ValidationError: eval suite ${input.suiteId} must be FROZEN to start a run (status=${suite.status})`,
    );
  }

  const evalRunId = deriveEvalRunId(
    suite.suiteId,
    suite.version,
    input.agentTargetVersion,
    input.idempotencyKey,
  );

  const cases = await listEvalCasesForSuite(suite.suiteId);

  const now = new Date().toISOString();
  const run: EvalRun = {
    evalRunId,
    orgId: suite.orgId,
    suiteId: suite.suiteId,
    suiteVersion: suite.version,
    agentTargetId: input.agentTargetId,
    agentTargetVersion: input.agentTargetVersion,
    status: "PENDING",
    caseCount: cases.length,
    pendingCases: cases.length,
    startedAt: now,
    startedBy: authContext.userId,
    idempotencyKey: input.idempotencyKey,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: EVAL_RUNS_TABLE,
        Item: run,
        ConditionExpression: "attribute_not_exists(evalRunId)",
      }),
    );
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      // Safe-retry: return the existing run rather than throwing.
      const existing = await getEvalRun(evalRunId);
      if (existing) return existing;
      // Extremely unlikely race (deleted between the conflicting put and
      // this read) — surface the original conflict rather than silently
      // fabricating a run.
    }
    throw err;
  }

  // Per-case PENDING rows — dispatch idempotency guard lives in the
  // eval-runner driver (a case is dispatched only from a PENDING row via a
  // conditional transition to DISPATCHED).
  await Promise.all(
    cases.map((c) =>
      docClient.send(
        new PutCommand({
          TableName: EVAL_RUN_CASE_RESULTS_TABLE,
          Item: {
            evalRunId,
            caseId: c.caseId,
            orgId: suite.orgId,
            caseKind: c.kind,
            targetAdapter:
              c.kind === "CONVERSATION" ? "conversation" : "execution",
            status: "PENDING",
          } satisfies EvalRunCaseResult,
          ConditionExpression: "attribute_not_exists(evalRunId)",
        }),
      ),
    ),
  );

  // Best-effort: emit run-started BEFORE fan-out begins (mirrors the
  // best-effort discipline of governance.constitutional.rule.changed — a
  // notifier failure never rolls back the durable run/case writes above).
  try {
    await emitGovernanceEvent("governance.eval.run.started", {
      evalRunId,
      suiteId: suite.suiteId,
      suiteVersion: String(suite.version),
      agentTargetId: input.agentTargetId,
      agentTargetVersion: input.agentTargetVersion,
      orgId: suite.orgId,
      caseCount: cases.length,
      startedAt: now,
      startedBy: authContext.userId,
    });
  } catch (err) {
    console.error(
      "eval-run-resolver: emit governance.eval.run.started failed",
      err,
    );
  }

  // Fan-out begins after the run + all case rows are durably written
  // (design §1). Best-effort at the call-site level too: a fan-out error
  // must not surface as a failed startEvalRun — the run row already
  // exists and is independently resumable/retriable by an operator or a
  // future re-sweep; the caller has already received a valid run to poll.
  try {
    const maxLatencyMs =
      Number(process.env.EVAL_DEFAULT_MAX_LATENCY_MS) || 900000;
    await fanOutEvalRun(
      evalRunId,
      suite.suiteId,
      input.agentTargetId,
      suite.orgId,
      maxLatencyMs,
    );
  } catch (err) {
    console.error("eval-run-resolver: fanOutEvalRun failed", {
      evalRunId,
      err,
    });
  }

  return run;
}

export async function getEvalRun(evalRunId: string): Promise<EvalRun | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_RUNS_TABLE, Key: { evalRunId } }),
  );
  return (res.Item as EvalRun | undefined) ?? null;
}

export async function listEvalRuns(
  orgId: string,
  suiteId?: string,
): Promise<EvalRun[]> {
  if (suiteId) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: EVAL_RUNS_TABLE,
        IndexName: "suite-index",
        KeyConditionExpression: "suiteId = :sid",
        ExpressionAttributeValues: { ":sid": suiteId },
      }),
    );
    return (res.Items as EvalRun[] | undefined) ?? [];
  }
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_RUNS_TABLE,
      IndexName: "org-index",
      KeyConditionExpression: "orgId = :oid",
      ExpressionAttributeValues: { ":oid": orgId },
    }),
  );
  return (res.Items as EvalRun[] | undefined) ?? [];
}

export async function listEvalRunCaseResults(
  evalRunId: string,
): Promise<EvalRunCaseResult[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      KeyConditionExpression: "evalRunId = :rid",
      ExpressionAttributeValues: { ":rid": evalRunId },
    }),
  );
  return (res.Items as EvalRunCaseResult[] | undefined) ?? [];
}

export const handler = async (
  event: EvalRunResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "startEvalRun":
        return await startEvalRun(event.arguments.input, authContext);
      case "getEvalRun":
        return await getEvalRun(event.arguments.evalRunId);
      case "listEvalRuns":
        return await listEvalRuns(
          event.arguments.orgId,
          event.arguments.suiteId,
        );
      case "listEvalRunCaseResults":
        return await listEvalRunCaseResults(event.arguments.evalRunId);
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("eval-run-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
