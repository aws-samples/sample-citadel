/**
 * EvalBaseline / EvalComparison resolver (CIT-105 Pass 2 — I/O layer).
 *
 * Own file + own IAM role (kept-separate doctrine, mirrors eval-run-resolver.ts
 * vs eval-resolver.ts) — distinct tables (EvalBaselinesTable,
 * EvalComparisonsTable, EvalComparisonConfigTable) + distinct AppSync data
 * source. Structural mirror of eval-run-resolver.ts: `handler` switch on
 * fieldName, `authContextFromEvent` + `sanitizeForLog` conventions duplicated
 * here rather than imported (same rationale — kept independent per file).
 *
 * PURE COMPUTE IS NEVER REIMPLEMENTED HERE: `compareRuns` (eval-comparison.ts)
 * is the single source of the comparison algorithm. This file's only job is
 * I/O — load rows, resolve thresholds, call the pure function, persist the
 * result, emit events.
 *
 * Idempotency (design §7): `comparisonId = uuidv5(
 *   "${baselineEvalRunId}:${sorted(candidateEvalRunIds)}:${sorted(scorerVersions)}:${thresholdsHash}:${idempotencyKey}",
 *   EVAL_COMPARISON_NAMESPACE)`. `PutCommand` with
 * `ConditionExpression=attribute_not_exists(comparisonId)`; on
 * `ConditionalCheckFailedException` fetches and returns the EXISTING row
 * (exact startEvalRun pattern) — deterministic pure compare over identical
 * inputs yields a byte-identical verdict, so this is safe.
 *
 * Precondition (design §7): baseline AND every candidate run must be
 * status COMPLETED — never compare a partial run.
 *
 * Self-sufficient fallback (design §5, mirrors eval-run-aggregator.ts): a
 * COMPLETED candidate (or baseline) case missing a scoreVector is
 * inline-scored via eval-scoring-io.ts's buildScoringInputs + scoreCase
 * before the comparison proceeds.
 *
 * Cross-org isolation (design §8, mirrors replay-package-builder.ts's
 * CrossOrgRowError/assertRowOrg discipline): every loaded run/suite row's
 * orgId must equal the caller-resolved orgId, or the request is rejected.
 *
 * S3 offload (design §3, mirrors eval-artifact-store.ts's SSM-resolved
 * replay bucket + `eval-runs/{evalRunId}/{caseId}.json` key convention):
 * the per-case×per-dimension `caseDetail` is stored inline as AWSJSON when
 * under MAX_JSON_FIELD_BYTES, else offloaded to
 * `eval-comparisons/{comparisonId}.json` in the SAME replay bucket, with
 * `caseDetailRef` set instead. Never throws on offload failure — falls back
 * to inline (truncation is preferable to losing the comparison outright is
 * NOT the contract here since these rows are small and bounded per design
 * §3; an offload failure logs and re-attempts inline storage of the full
 * payload, which is the correct behavior since DDB will itself reject an
 * oversized item, surfacing a clear error rather than a silent gap).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { v5 as uuidv5 } from "uuid";
import { createHash } from "crypto";
import { hasPermission } from "../utils/auth";
import { emitGovernanceEvent } from "../utils/notifier-base";
import { resolveReplayBucketName } from "./utils/eval-artifact-store";
import { scoreCase, type DimensionScore } from "./utils/eval-scoring";
import {
  buildScoringInputs,
  getEvalCaseDefinition,
  readCostRows,
  readEvalArtifact,
} from "./utils/eval-scoring-io";
import {
  compareRuns,
  type EvalComparisonRunInput,
  type EvalComparisonCaseRow,
  type EvalComparisonVerdict,
} from "./utils/eval-comparison";
import {
  resolveComparisonThresholds,
  type ComparisonThresholdConfigRow,
  type PartialComparisonThresholds,
} from "./utils/eval-comparison-config";
import type {
  AuthContext,
  EvalBaseline,
  EvalComparisonRow,
  EvalComparisonThresholdConfigRow as EvalComparisonThresholdConfigRowType,
  DesignateEvalBaselineInput,
  ComputeEvalComparisonInput,
  SetEvalComparisonThresholdConfigInput,
  EvalRun,
  EvalRunCaseResult,
  EvalSuite,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const EVAL_BASELINES_TABLE = process.env.EVAL_BASELINES_TABLE!;
const EVAL_COMPARISONS_TABLE = process.env.EVAL_COMPARISONS_TABLE!;
const EVAL_COMPARISON_CONFIG_TABLE = process.env.EVAL_COMPARISON_CONFIG_TABLE!;
const EVAL_SUITES_TABLE = process.env.EVAL_SUITES_TABLE!;
const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;
const EVAL_RUNS_TABLE = process.env.EVAL_RUNS_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;
/** OPTIONAL — unlike the replay bucket (SSM-resolved at runtime,
 * eval-artifact-store.ts), there is no existing cross-stack publication of
 * the cost-ledger table name: it is owned by TelemetryStack, which
 * instantiates AFTER GovernanceStack (home of this resolver) in
 * bin/app.ts — the same ordering constraint eval-artifact-store.ts solves
 * via SSM, not yet extended to the cost ledger. Left unset here (no env
 * var wired in governance-stack.ts); `readCostRows` is skipped gracefully
 * when absent rather than issuing a DynamoDB call against an empty table
 * name. This means self-sufficient inline scoring computes the `cost`
 * dimension as UNKNOWN (no cost rows) for a case whose scoreVector was
 * missing and had to be inline-scored by THIS resolver — the identical
 * dimension is unaffected when eval-run-aggregator.ts's own inline
 * fallback (which DOES have COST_LEDGER_TABLE wired) has already scored
 * the case, since compareRuns only ever consumes a persisted scoreVector.
 * A future pass can close this gap via the same SSM-publish pattern. */
const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE;
const SCORER_VERSION = process.env.SCORER_VERSION || "v1";

/** Sentinel SK for the org-wide default row on EvalComparisonConfigTable
 * (design §3/§4). */
const ORG_DEFAULT_CONFIG_SENTINEL = "__default__";

/** Size cap per eval-resolver.ts's MAX_JSON_FIELD_BYTES precedent — the
 * inline caseDetail field is offloaded to S3 once it exceeds this. */
const MAX_JSON_FIELD_BYTES = 256 * 1024;

/**
 * Fixed namespace UUID for the deterministic comparisonId derivation
 * (uuidv5). A constant, never regenerated — mirrors EVAL_RUN_NAMESPACE's
 * frozen-constant discipline (eval-run-resolver.ts). Generated once via
 * uuidv4() and frozen here.
 */
export const EVAL_COMPARISON_NAMESPACE = "6f1a2c3d-8e4b-4a5f-9c6d-2b3e4f5a6b7c";

interface EvalComparisonResolverArguments {
  input: DesignateEvalBaselineInput &
    ComputeEvalComparisonInput &
    SetEvalComparisonThresholdConfigInput;
  orgId: string;
  agentTargetId: string;
  suiteId: string;
  comparisonId: string;
}

type EvalComparisonResolverEvent =
  GovernanceResolverEvent<EvalComparisonResolverArguments>;

function authContextFromEvent(event: EvalComparisonResolverEvent): AuthContext {
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

function requireEvalApprovePermission(
  authContext: AuthContext,
  action: string,
): void {
  if (!hasPermission(authContext, "eval:approve")) {
    throw new Error(
      `UnauthorizedError: eval:approve permission required to ${action}`,
    );
  }
}

/** Cross-org guard (design §8, mirrors replay-package-builder.ts's
 * CrossOrgRowError/assertRowOrg). Thrown when a loaded row's orgId does
 * not match the caller-resolved orgId. */
export class CrossOrgRowError extends Error {
  constructor(table: string, rowOrgId: string, expectedOrgId: string) {
    super(
      `Cross-org row encountered while computing eval comparison: table=${table} rowOrgId=${rowOrgId} expectedOrgId=${expectedOrgId}`,
    );
    this.name = "CrossOrgRowError";
  }
}

function assertRowOrg(
  table: string,
  row: { orgId?: unknown } | undefined,
  expectedOrgId: string,
): void {
  if (!row) return;
  const rowOrgId = typeof row.orgId === "string" ? row.orgId : undefined;
  if (rowOrgId !== undefined && rowOrgId !== expectedOrgId) {
    throw new CrossOrgRowError(table, rowOrgId, expectedOrgId);
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

// ── EvalBaseline ───────────────────────────────────────────────────────────

function baselineSortKey(agentTargetId: string, suiteId: string): string {
  return `${agentTargetId}#${suiteId}`;
}

export async function getEvalBaseline(
  orgId: string,
  agentTargetId: string,
  suiteId: string,
): Promise<EvalBaseline | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: EVAL_BASELINES_TABLE,
      Key: {
        orgId,
        agentTargetId_suiteId: baselineSortKey(agentTargetId, suiteId),
      },
    }),
  );
  return (res.Item as EvalBaseline | undefined) ?? null;
}

export async function listEvalBaselines(
  orgId: string,
): Promise<EvalBaseline[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_BASELINES_TABLE,
      KeyConditionExpression: "orgId = :oid",
      ExpressionAttributeValues: { ":oid": orgId },
    }),
  );
  return (res.Items as EvalBaseline[] | undefined) ?? [];
}

async function getEvalRun(evalRunId: string): Promise<EvalRun | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_RUNS_TABLE, Key: { evalRunId } }),
  );
  return (res.Item as EvalRun | undefined) ?? null;
}

async function getEvalSuite(suiteId: string): Promise<EvalSuite | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_SUITES_TABLE, Key: { suiteId } }),
  );
  return (res.Item as EvalSuite | undefined) ?? null;
}

function validateDesignateInput(input: DesignateEvalBaselineInput): void {
  if (typeof input?.orgId !== "string" || !input.orgId) {
    throw new Error("ValidationError: orgId is required");
  }
  if (typeof input?.agentTargetId !== "string" || !input.agentTargetId) {
    throw new Error("ValidationError: agentTargetId is required");
  }
  if (typeof input?.suiteId !== "string" || !input.suiteId) {
    throw new Error("ValidationError: suiteId is required");
  }
  if (
    typeof input?.baselineEvalRunId !== "string" ||
    !input.baselineEvalRunId
  ) {
    throw new Error("ValidationError: baselineEvalRunId is required");
  }
}

/**
 * designateEvalBaseline — mutable (orgId, agentTargetId, suiteId) baseline
 * pointer, re-baselined on promotion. AUDIT-BEFORE-AUTH (freezeEvalSuite
 * parity, design §7) + optimistic version CAS upsert (updateSuiteFields
 * pattern) — safe to retry.
 */
export async function designateEvalBaseline(
  input: DesignateEvalBaselineInput,
  authContext: AuthContext,
): Promise<EvalBaseline> {
  validateDesignateInput(input);

  const attemptId = input.baselineEvalRunId;
  const attemptedAt = new Date().toISOString();

  console.log({
    phase: "audit",
    action: "designateEvalBaseline",
    attemptId,
    orgId: input.orgId,
    agentTargetId: input.agentTargetId,
    suiteId: input.suiteId,
    attemptedBy: authContext.userId,
    attemptedAt,
    authResult: "PENDING",
  });

  const authorised = hasPermission(authContext, "eval:approve");

  console.log({
    phase: "audit-outcome",
    action: "designateEvalBaseline",
    attemptId,
    attemptedBy: authContext.userId,
    authResult: authorised ? "ALLOWED" : "DENIED",
  });

  if (!authorised) {
    throw new Error(
      "UnauthorizedError: eval:approve permission required to designate eval baselines",
    );
  }

  const baselineRun = await getEvalRun(input.baselineEvalRunId);
  if (!baselineRun) {
    throw new Error(`EvalRun not found: ${input.baselineEvalRunId}`);
  }
  assertRowOrg(EVAL_RUNS_TABLE, baselineRun, input.orgId);
  if (baselineRun.status !== "COMPLETED") {
    throw new Error(
      `ValidationError: baseline run ${input.baselineEvalRunId} must be COMPLETED (status=${baselineRun.status})`,
    );
  }
  if (baselineRun.suiteId !== input.suiteId) {
    throw new Error(
      `ValidationError: baseline run ${input.baselineEvalRunId} belongs to suite ${baselineRun.suiteId}, not ${input.suiteId}`,
    );
  }

  const existing = await getEvalBaseline(
    input.orgId,
    input.agentTargetId,
    input.suiteId,
  );

  const now = new Date().toISOString();
  const nextVersion = (existing?.version ?? 0) + 1;
  const baseline: EvalBaseline = {
    orgId: input.orgId,
    agentTargetId: input.agentTargetId,
    suiteId: input.suiteId,
    baselineEvalRunId: input.baselineEvalRunId,
    baselineSuiteVersion: baselineRun.suiteVersion,
    baselineAgentTargetVersion: baselineRun.agentTargetVersion,
    previousBaselineEvalRunId: existing?.baselineEvalRunId,
    reason: input.reason,
    designatedAt: now,
    designatedBy: authContext.userId,
    version: nextVersion,
  };

  if (existing) {
    await docClient.send(
      new UpdateCommand({
        TableName: EVAL_BASELINES_TABLE,
        Key: {
          orgId: input.orgId,
          agentTargetId_suiteId: baselineSortKey(
            input.agentTargetId,
            input.suiteId,
          ),
        },
        UpdateExpression:
          "SET baselineEvalRunId = :runId, baselineSuiteVersion = :sv, baselineAgentTargetVersion = :atv, previousBaselineEvalRunId = :prev, #reason = :reason, designatedAt = :at, designatedBy = :by, #version = :newVersion",
        ConditionExpression: "#version = :currentVersion",
        ExpressionAttributeNames: {
          "#version": "version",
          "#reason": "reason",
        },
        ExpressionAttributeValues: {
          ":runId": baseline.baselineEvalRunId,
          ":sv": baseline.baselineSuiteVersion,
          ":atv": baseline.baselineAgentTargetVersion,
          ":prev": baseline.previousBaselineEvalRunId ?? null,
          ":reason": baseline.reason ?? null,
          ":at": baseline.designatedAt,
          ":by": baseline.designatedBy,
          ":newVersion": nextVersion,
          ":currentVersion": existing.version,
        },
      }),
    );
  } else {
    await docClient.send(
      new PutCommand({
        TableName: EVAL_BASELINES_TABLE,
        Item: {
          ...baseline,
          agentTargetId_suiteId: baselineSortKey(
            input.agentTargetId,
            input.suiteId,
          ),
        },
        ConditionExpression: "attribute_not_exists(orgId)",
      }),
    );
  }

  try {
    await emitGovernanceEvent("governance.eval.baseline.designated", {
      orgId: baseline.orgId,
      agentTargetId: baseline.agentTargetId,
      suiteId: baseline.suiteId,
      baselineEvalRunId: baseline.baselineEvalRunId,
      previousBaselineEvalRunId: baseline.previousBaselineEvalRunId,
      designatedBy: baseline.designatedBy,
      at: baseline.designatedAt,
    });
  } catch (err) {
    console.error(
      "eval-comparison-resolver: emit governance.eval.baseline.designated failed",
      err,
    );
  }

  return baseline;
}

// ── EvalComparisonThresholdConfig ──────────────────────────────────────────

export async function getEvalComparisonThresholdConfig(
  orgId: string,
  suiteId: string,
): Promise<EvalComparisonThresholdConfigRowType | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: EVAL_COMPARISON_CONFIG_TABLE,
      Key: { orgId, suiteId },
    }),
  );
  return (res.Item as EvalComparisonThresholdConfigRowType | undefined) ?? null;
}

async function getOrgDefaultThresholdConfig(
  orgId: string,
): Promise<EvalComparisonThresholdConfigRowType | null> {
  return getEvalComparisonThresholdConfig(orgId, ORG_DEFAULT_CONFIG_SENTINEL);
}

/**
 * setEvalComparisonThresholdConfig — admin-authored config upsert.
 * suiteId=ORG_DEFAULT_CONFIG_SENTINEL sets the per-org default row.
 * Optimistic version CAS upsert (updateSuiteFields pattern) — safe to
 * retry. AUDIT-BEFORE-AUTH (freezeEvalSuite parity).
 */
export async function setEvalComparisonThresholdConfig(
  orgId: string,
  suiteId: string,
  input: SetEvalComparisonThresholdConfigInput,
  authContext: AuthContext,
): Promise<EvalComparisonThresholdConfigRowType> {
  const attemptedAt = new Date().toISOString();

  console.log({
    phase: "audit",
    action: "setEvalComparisonThresholdConfig",
    orgId,
    suiteId,
    attemptedBy: authContext.userId,
    attemptedAt,
    authResult: "PENDING",
  });

  const authorised = hasPermission(authContext, "eval:approve");

  console.log({
    phase: "audit-outcome",
    action: "setEvalComparisonThresholdConfig",
    orgId,
    suiteId,
    attemptedBy: authContext.userId,
    authResult: authorised ? "ALLOWED" : "DENIED",
  });

  if (!authorised) {
    throw new Error(
      "UnauthorizedError: eval:approve permission required to set eval comparison threshold config",
    );
  }

  if (!input?.thresholds || typeof input.thresholds !== "object") {
    throw new Error("ValidationError: thresholds is required");
  }

  const existing = await getEvalComparisonThresholdConfig(orgId, suiteId);
  const now = new Date().toISOString();
  const nextVersion = (existing?.version ?? 0) + 1;
  const row: EvalComparisonThresholdConfigRowType = {
    orgId,
    suiteId,
    thresholds: input.thresholds,
    updatedAt: now,
    updatedBy: authContext.userId,
    version: nextVersion,
  };

  await docClient.send(
    new PutCommand({
      TableName: EVAL_COMPARISON_CONFIG_TABLE,
      Item: row,
      ConditionExpression: existing
        ? "#version = :currentVersion"
        : "attribute_not_exists(orgId)",
      ...(existing
        ? {
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":currentVersion": existing.version },
          }
        : {}),
    } as ConstructorParameters<typeof PutCommand>[0]),
  );

  return row;
}

// ── EvalComparison compute ─────────────────────────────────────────────────

async function listEvalRunCaseResults(
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

/**
 * Self-sufficient fallback (design §5, mirrors eval-run-aggregator.ts's
 * scoreMissingCaseInline exactly, via the SAME shared eval-scoring-io.ts
 * helpers so the two paths can never silently diverge). Never throws: any
 * failure is logged and the case is skipped (left without a scoreVector
 * for this comparison pass — compareRuns models that as a legitimate
 * "nothing to compare" case via its own incomparable/unchanged logic).
 */
async function scoreMissingCaseInline(
  caseRow: EvalRunCaseResult,
  suiteId: string,
): Promise<DimensionScore[] | undefined> {
  try {
    const evalCase = await getEvalCaseDefinition(
      EVAL_CASES_TABLE,
      suiteId,
      caseRow.caseId,
    );
    if (!evalCase) {
      console.error(
        "eval-comparison-resolver: EvalCase definition not found for inline scoring — skipping",
        { evalRunId: caseRow.evalRunId, caseId: caseRow.caseId, suiteId },
      );
      return undefined;
    }

    const envelope = await readEvalArtifact(caseRow.artifactRef);
    const costRows = COST_LEDGER_TABLE
      ? await readCostRows(
          COST_LEDGER_TABLE,
          caseRow.executionId,
          caseRow.conversationId,
        )
      : [];
    const { caseRowForScoring, artifact, evalCaseForScoring } =
      buildScoringInputs({ ...caseRow, suiteId }, evalCase, envelope, costRows);
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
      "eval-comparison-resolver: inline fallback scoring failed — case left unscored for this comparison",
      {
        evalRunId: caseRow.evalRunId,
        caseId: caseRow.caseId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}

/** Loads one EvalRun's rows into the pure compareRuns() input shape,
 * self-sufficiently inline-scoring any COMPLETED case missing a
 * scoreVector along the way. */
async function buildComparisonRunInput(
  run: EvalRun,
): Promise<EvalComparisonRunInput> {
  const caseRows = await listEvalRunCaseResults(run.evalRunId);
  const cases: EvalComparisonCaseRow[] = [];
  let latestScorerVersion = SCORER_VERSION;

  for (const caseRow of caseRows) {
    let scoreVector: DimensionScore[] | undefined;
    if (caseRow.scoreVector) {
      try {
        scoreVector = JSON.parse(caseRow.scoreVector) as DimensionScore[];
        if (caseRow.scorerVersion) latestScorerVersion = caseRow.scorerVersion;
      } catch {
        console.error(
          "eval-comparison-resolver: existing scoreVector is not valid JSON — treating as missing",
          { evalRunId: run.evalRunId, caseId: caseRow.caseId },
        );
      }
    }

    if (!scoreVector) {
      if (caseRow.status !== "COMPLETED") {
        // FAILED/TIMEOUT cases have no artifact to score — never
        // fallback-scored; simply absent from this run's comparison input.
        continue;
      }
      scoreVector = await scoreMissingCaseInline(caseRow, run.suiteId);
      if (scoreVector) latestScorerVersion = SCORER_VERSION;
    }

    if (scoreVector) {
      cases.push({ caseId: caseRow.caseId, scoreVector });
    }
  }

  return {
    evalRunId: run.evalRunId,
    agentTargetVersion: run.agentTargetVersion,
    scorerVersion: latestScorerVersion,
    cases,
  };
}

function validateComputeInput(input: ComputeEvalComparisonInput): void {
  if (typeof input?.orgId !== "string" || !input.orgId) {
    throw new Error("ValidationError: orgId is required");
  }
  if (typeof input?.suiteId !== "string" || !input.suiteId) {
    throw new Error("ValidationError: suiteId is required");
  }
  if (
    !Array.isArray(input?.candidateEvalRunIds) ||
    input.candidateEvalRunIds.length === 0
  ) {
    throw new Error(
      "ValidationError: candidateEvalRunIds must be a non-empty array",
    );
  }
  if (typeof input?.idempotencyKey !== "string" || !input.idempotencyKey) {
    throw new Error("ValidationError: idempotencyKey is required");
  }
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deriveComparisonId(
  baselineEvalRunId: string,
  candidateEvalRunIds: string[],
  scorerVersions: string[],
  thresholdsHash: string,
  idempotencyKey: string,
): string {
  const sortedCandidates = [...candidateEvalRunIds].sort();
  const sortedScorers = [...scorerVersions].sort();
  return uuidv5(
    `${baselineEvalRunId}:${sortedCandidates.join(",")}:${sortedScorers.join(",")}:${thresholdsHash}:${idempotencyKey}`,
    EVAL_COMPARISON_NAMESPACE,
  );
}

async function getEvalComparison(
  comparisonId: string,
): Promise<EvalComparisonRow | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: EVAL_COMPARISONS_TABLE,
      Key: { comparisonId },
    }),
  );
  return (res.Item as EvalComparisonRow | undefined) ?? null;
}

export async function listEvalComparisons(
  orgId: string,
  suiteId?: string,
): Promise<EvalComparisonRow[]> {
  if (suiteId) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: EVAL_COMPARISONS_TABLE,
        IndexName: "suite-index",
        KeyConditionExpression: "suiteId = :sid",
        ExpressionAttributeValues: { ":sid": suiteId },
      }),
    );
    return (res.Items as EvalComparisonRow[] | undefined) ?? [];
  }
  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_COMPARISONS_TABLE,
      IndexName: "org-index",
      KeyConditionExpression: "orgId = :oid",
      ExpressionAttributeValues: { ":oid": orgId },
    }),
  );
  return (res.Items as EvalComparisonRow[] | undefined) ?? [];
}

/** Extracts the perCase breakdown for S3/inline offload, and the
 * dimension summaries (everything else) for the always-inline row. */
function splitVerdictForStorage(verdict: EvalComparisonVerdict): {
  dimensionSummaries: EvalComparisonRow["dimensions"];
  caseDetail: Record<
    string,
    EvalComparisonVerdict["dimensions"][number]["perCase"]
  >;
} {
  const dimensionSummaries = verdict.dimensions.map(
    ({ perCase, ...rest }) => rest,
  );
  const caseDetail: Record<
    string,
    EvalComparisonVerdict["dimensions"][number]["perCase"]
  > = {};
  for (const dim of verdict.dimensions) {
    caseDetail[dim.dimension] = dim.perCase;
  }
  return { dimensionSummaries, caseDetail };
}

/**
 * computeEvalComparison — the on-demand mutation (design §5: event-driven
 * auto-comparison is DEFERRED). Loads the baseline (resolved from
 * EvalBaselines when omitted) and candidate cohort, asserts all COMPLETED
 * + same-org, self-sufficiently inline-scores any missing scoreVector,
 * resolves thresholds (layered), calls the PURE compareRuns() (never
 * reimplemented here), persists the verdict (inline or S3-offloaded
 * caseDetail), and emits governance.eval.comparison.completed AFTER the
 * durable write (best-effort — emit failure never rolls back the verdict
 * row).
 */
export async function computeEvalComparison(
  input: ComputeEvalComparisonInput,
  authContext: AuthContext,
): Promise<EvalComparisonRow> {
  requireEvalRunPermission(authContext, "compute eval comparisons");
  validateComputeInput(input);

  const suite = await getEvalSuite(input.suiteId);
  if (!suite) {
    throw new Error(`EvalSuite not found: ${input.suiteId}`);
  }
  assertRowOrg(EVAL_SUITES_TABLE, suite, input.orgId);

  let baselineEvalRunId = input.baselineEvalRunId;
  if (!baselineEvalRunId) {
    const baseline = await getEvalBaseline(
      input.orgId,
      suite.agentTargetId,
      input.suiteId,
    );
    if (!baseline) {
      throw new Error(
        `ValidationError: no baseline designated for (orgId=${input.orgId}, agentTargetId=${suite.agentTargetId}, suiteId=${input.suiteId})`,
      );
    }
    baselineEvalRunId = baseline.baselineEvalRunId;
  }

  const baselineRun = await getEvalRun(baselineEvalRunId);
  if (!baselineRun) {
    throw new Error(`EvalRun not found: ${baselineEvalRunId}`);
  }
  assertRowOrg(EVAL_RUNS_TABLE, baselineRun, input.orgId);
  if (baselineRun.status !== "COMPLETED") {
    throw new Error(
      `ValidationError: baseline run ${baselineEvalRunId} must be COMPLETED (status=${baselineRun.status})`,
    );
  }

  const candidateRuns: EvalRun[] = [];
  for (const runId of input.candidateEvalRunIds) {
    const run = await getEvalRun(runId);
    if (!run) {
      throw new Error(`EvalRun not found: ${runId}`);
    }
    assertRowOrg(EVAL_RUNS_TABLE, run, input.orgId);
    if (run.status !== "COMPLETED") {
      throw new Error(
        `ValidationError: candidate run ${runId} must be COMPLETED (status=${run.status})`,
      );
    }
    candidateRuns.push(run);
  }

  const [baselineInput, ...candidateInputs] = await Promise.all([
    buildComparisonRunInput(baselineRun),
    ...candidateRuns.map((run) => buildComparisonRunInput(run)),
  ]);

  const perSuiteConfig = await getEvalComparisonThresholdConfig(
    input.orgId,
    input.suiteId,
  );
  const perOrgDefaultConfig = await getOrgDefaultThresholdConfig(input.orgId);
  const thresholds = resolveComparisonThresholds({
    overrides: input.thresholdOverride,
    perSuiteConfig: perSuiteConfig as ComparisonThresholdConfigRow | null,
    perOrgDefaultConfig:
      perOrgDefaultConfig as ComparisonThresholdConfigRow | null,
  });

  const scorerVersionsForId = [
    baselineInput.scorerVersion,
    ...candidateInputs.map((c) => c.scorerVersion),
  ];
  const thresholdsHash = sha256Hex(thresholds);
  const comparisonId = deriveComparisonId(
    baselineEvalRunId,
    input.candidateEvalRunIds,
    scorerVersionsForId,
    thresholdsHash,
    input.idempotencyKey,
  );

  const verdict = compareRuns(baselineInput, candidateInputs, thresholds);

  const { dimensionSummaries, caseDetail } = splitVerdictForStorage(verdict);
  const caseDetailJson = JSON.stringify(caseDetail);
  const caseDetailBytes = Buffer.byteLength(caseDetailJson, "utf8");

  const now = new Date().toISOString();
  const row: EvalComparisonRow = {
    comparisonId,
    orgId: input.orgId,
    suiteId: input.suiteId,
    suiteVersion: suite.version,
    agentTargetId: suite.agentTargetId,
    baselineEvalRunId: verdict.baselineEvalRunId,
    baselineAgentTargetVersion: verdict.baselineAgentTargetVersion,
    candidateEvalRunIds: verdict.candidateEvalRunIds,
    candidateAgentTargetVersion: verdict.candidateAgentTargetVersion,
    repeatCount: verdict.repeatCount,
    scorerVersions: verdict.scorerVersions,
    thresholds: verdict.thresholds,
    dimensions: dimensionSummaries,
    anyMaterialRegression: verdict.anyMaterialRegression,
    materiallyRegressedDimensions: verdict.materiallyRegressedDimensions,
    unstableDimensions: verdict.unstableDimensions,
    verdictStatus: verdict.verdictStatus,
    createdAt: now,
    createdBy: authContext.userId,
  };

  if (caseDetailBytes > MAX_JSON_FIELD_BYTES) {
    const offloaded = await offloadCaseDetail(comparisonId, caseDetailJson);
    if (offloaded) {
      row.caseDetailRef = offloaded;
    } else {
      // Offload failed/unavailable — fall back to inline storage. DDB's
      // own 400KiB item cap will surface a clear error if this genuinely
      // doesn't fit, which is preferable to silently dropping case detail.
      row.caseDetail = caseDetailJson;
    }
  } else {
    row.caseDetail = caseDetailJson;
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: EVAL_COMPARISONS_TABLE,
        Item: row,
        ConditionExpression: "attribute_not_exists(comparisonId)",
      }),
    );
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      const existing = await getEvalComparison(comparisonId);
      if (existing) return existing;
    }
    throw err;
  }

  try {
    await emitGovernanceEvent("governance.eval.comparison.completed", {
      orgId: row.orgId,
      suiteId: row.suiteId,
      comparisonId: row.comparisonId,
      baselineEvalRunId: row.baselineEvalRunId,
      candidateEvalRunIds: row.candidateEvalRunIds,
      anyMaterialRegression: row.anyMaterialRegression,
      materiallyRegressedDimensions: row.materiallyRegressedDimensions,
      unstableDimensions: row.unstableDimensions,
      verdictStatus: row.verdictStatus,
      at: row.createdAt,
    });
  } catch (err) {
    console.error(
      "eval-comparison-resolver: emit governance.eval.comparison.completed failed",
      err,
    );
  }

  return row;
}

/**
 * S3 offload for the per-case×per-dimension caseDetail, mirroring
 * eval-artifact-store.ts's materializeEvalCaseArtifact: SSM-resolved
 * replay bucket, `eval-comparisons/{comparisonId}.json` key. Never
 * throws — returns null on any failure (bucket unresolved, S3 write
 * error) so the caller can fall back to inline storage.
 */
async function offloadCaseDetail(
  comparisonId: string,
  caseDetailJson: string,
): Promise<string | null> {
  const bucketName = await resolveReplayBucketName();
  if (!bucketName) {
    return null;
  }
  try {
    const key = `eval-comparisons/${comparisonId}.json`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: caseDetailJson,
        ContentType: "application/json",
      }),
    );
    return key;
  } catch (err) {
    console.error(
      "eval-comparison-resolver: offloadCaseDetail failed — falling back to inline storage",
      { comparisonId, error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

/** Reads the offloaded caseDetail back from S3 for getEvalComparison
 * consumers that need the full breakdown. Never throws — returns null on
 * any failure (bucket unresolved, object missing, read error). */
async function readCaseDetailFromS3(
  caseDetailRef: string,
): Promise<string | null> {
  const bucketName = await resolveReplayBucketName();
  if (!bucketName) return null;
  try {
    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: caseDetailRef }),
    );
    const body = await res.Body?.transformToString();
    return body ?? null;
  } catch (err) {
    console.error("eval-comparison-resolver: readCaseDetailFromS3 failed", {
      caseDetailRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** getEvalComparison with caseDetail hydrated from S3 when offloaded —
 * exported for direct testing; the handler dispatch uses this for the
 * getEvalComparison field so a caller always receives the full row
 * regardless of storage location. */
export async function getEvalComparisonHydrated(
  comparisonId: string,
): Promise<EvalComparisonRow | null> {
  const row = await getEvalComparison(comparisonId);
  if (!row) return null;
  if (row.caseDetailRef && !row.caseDetail) {
    const hydrated = await readCaseDetailFromS3(row.caseDetailRef);
    if (hydrated) {
      return { ...row, caseDetail: hydrated };
    }
  }
  return row;
}

// ── Handler dispatch ────────────────────────────────────────────────────────

export const handler = async (
  event: EvalComparisonResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "designateEvalBaseline":
        return await designateEvalBaseline(
          event.arguments.input as DesignateEvalBaselineInput,
          authContext,
        );
      case "computeEvalComparison":
        return await computeEvalComparison(
          event.arguments.input as ComputeEvalComparisonInput,
          authContext,
        );
      case "setEvalComparisonThresholdConfig":
        return await setEvalComparisonThresholdConfig(
          event.arguments.orgId,
          event.arguments.suiteId,
          event.arguments.input as SetEvalComparisonThresholdConfigInput,
          authContext,
        );
      case "getEvalBaseline":
        return await getEvalBaseline(
          event.arguments.orgId,
          event.arguments.agentTargetId,
          event.arguments.suiteId,
        );
      case "listEvalBaselines":
        return await listEvalBaselines(event.arguments.orgId);
      case "getEvalComparison":
        return await getEvalComparisonHydrated(event.arguments.comparisonId);
      case "listEvalComparisons":
        return await listEvalComparisons(
          event.arguments.orgId,
          event.arguments.suiteId,
        );
      case "getEvalComparisonThresholdConfig":
        return await getEvalComparisonThresholdConfig(
          event.arguments.orgId,
          event.arguments.suiteId,
        );
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("eval-comparison-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
