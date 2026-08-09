/**
 * release-gate-evidence.ts — READ-ONLY evidence resolution adapter for
 * the pure gate evaluator (evaluateReleaseGate, release-gate.ts).
 *
 * This module performs NO writes. It never imports a raw DynamoDB write
 * command, or any store write function — only GetCommand/QueryCommand
 * and the one read export release-store.ts already offers (getRelease).
 * Promotion-time wiring status: this resolver is called by
 * validateReleaseGate (environment-release-pointer-resolver.ts), which
 * is itself wired into that file's promoteEnvironmentReleasePointer.
 * The cut-time twin of that seam, release-resolver.ts's own (unrelated,
 * same-named) no-op at :197-199, remains a deliberate no-op — this
 * module is not called from there.
 *
 * Responsibilities, matching the design 1:1:
 *  1. From the release's pinned evidence
 *     (evalEvidence.{evalRunId,evalSuiteId,evalSuiteVersion}), resolve
 *     the candidate EvalRun + its score aggregates (from
 *     EvalRun.scoreAggregates when present, else computed from the
 *     run's own case rows via aggregateScoreVectors — never
 *     re-implemented scoring), plus the live EvalSuite so version,
 *     status, and gateClass can be judged.
 *  2. Resolve the BASELINE by reading the CURRENT environment pointer
 *     for (org, agentTargetId, environment), following it to its
 *     release and that release's pinned run. No pointer -> a first
 *     promotion -> `hasBaseline: false`, the ONE no-baseline case
 *     release-gate.ts already models. There is no second no-baseline
 *     notion anywhere in this module.
 *  3. Produce the comparison verdict by calling the EXISTING compareRuns
 *     (eval-comparison.ts) — never reimplemented here.
 *  4. Org scoping: every record fetched (release, EvalRun, EvalSuite,
 *     pointer) is confirmed to belong to callerOrgId. A mismatch is a
 *     security rejection (a distinct failure reason), never folded into
 *     a generic validation bucket.
 *  5. Unreadable/partial records or a thrown SDK error resolve to
 *     `{ ok: false, reason, detail }` — a machine-readable NON-PASS.
 *     Never a throw that escapes this module, and never a swallow that
 *     reads as success. This is the OPPOSITE of
 *     eval-drift-finding-writer.ts's best-effort log-and-drop catch:
 *     that module treats a write failure as an observability side
 *     channel; this module is a primary decision input, so every
 *     failure is surfaced as data the caller must act on.
 *
 * Choke-point discipline: reads release rows via release-store.ts's
 * exported `getRelease` (the only read export that module offers) —
 * this file never references the agent-releases table's env var name
 * or issues a raw DynamoDB command against that table directly, so the
 * write choke-point guard (release-store-choke-point.guard.test.ts) is
 * untouched.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { getRelease } from "../release-store";
import {
  compareRuns,
  type EvalComparisonCaseRow,
  type EvalComparisonRunInput,
  type EvalComparisonVerdict,
} from "./eval-comparison";
import {
  aggregateScoreVectors,
  type DimensionAggregate,
} from "./eval-score-aggregate";
import type { DimensionScore } from "./eval-scoring";
import type { PromotionPolicy, ReleaseGateInputs } from "./release-gate";
import type {
  AgentRelease,
  EnvironmentLiteral,
  EnvironmentReleasePointer,
  EvalRun,
  EvalRunCaseResult,
  EvalSuite,
} from "../../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function environmentReleasePointersTable(): string {
  return process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE!;
}
function evalRunsTable(): string {
  return process.env.EVAL_RUNS_TABLE!;
}
function evalSuitesTable(): string {
  return process.env.EVAL_SUITES_TABLE!;
}
function evalRunCaseResultsTable(): string {
  return process.env.EVAL_RUN_CASE_RESULTS_TABLE!;
}

const SCORER_VERSION_FALLBACK = "v1";

// ─────────────────────────────────────────────────────────────────────────
// Result shape — every failure is data, never a thrown exception past
// this module's boundary.
// ─────────────────────────────────────────────────────────────────────────

export type EvidenceResolutionFailureReason =
  | "CROSS_ORG_RELEASE"
  | "MISSING_EVAL_RUN"
  | "CROSS_ORG_EVAL_RUN"
  | "CANDIDATE_RUN_NOT_COMPLETED"
  | "MISSING_EVAL_SUITE"
  | "CROSS_ORG_EVAL_SUITE"
  | "CROSS_ORG_POINTER"
  | "MISSING_BASELINE_RELEASE"
  | "CROSS_ORG_BASELINE_RELEASE"
  | "UNREADABLE_RECORD"
  | "SDK_ERROR";

export interface EvidenceResolutionFailure {
  ok: false;
  reason: EvidenceResolutionFailureReason;
  detail: string;
}

export interface EvidenceResolutionSuccess {
  ok: true;
  inputs: ReleaseGateInputs;
}

export type EvidenceResolutionResult =
  EvidenceResolutionSuccess | EvidenceResolutionFailure;

function fail(
  reason: EvidenceResolutionFailureReason,
  detail: string,
): EvidenceResolutionFailure {
  return { ok: false, reason, detail };
}

/** Thrown internally only, to short-circuit resolution from deep call
 * stack positions back up to the single top-level catch. NEVER escapes
 * resolveReleaseGateEvidence — always converted to an
 * EvidenceResolutionFailure before returning. */
class EvidenceResolutionError extends Error {
  constructor(
    public readonly reason: EvidenceResolutionFailureReason,
    detail: string,
  ) {
    super(detail);
    this.name = "EvidenceResolutionError";
  }
}

function raise(reason: EvidenceResolutionFailureReason, detail: string): never {
  throw new EvidenceResolutionError(reason, detail);
}

// ─────────────────────────────────────────────────────────────────────────
// Reads — GetCommand/QueryCommand only, never a write command.
// ─────────────────────────────────────────────────────────────────────────

async function getEnvironmentReleasePointer(
  orgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
): Promise<EnvironmentReleasePointer | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: environmentReleasePointersTable(),
      Key: {
        orgId,
        agentTargetId_environment: `${agentTargetId}#${environment}`,
      },
    }),
  );
  return (res.Item as EnvironmentReleasePointer | undefined) ?? null;
}

async function getEvalRun(evalRunId: string): Promise<EvalRun | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: evalRunsTable(), Key: { evalRunId } }),
  );
  return (res.Item as EvalRun | undefined) ?? null;
}

async function getEvalSuite(suiteId: string): Promise<EvalSuite | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: evalSuitesTable(), Key: { suiteId } }),
  );
  return (res.Item as EvalSuite | undefined) ?? null;
}

async function listEvalRunCaseResults(
  evalRunId: string,
): Promise<EvalRunCaseResult[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: evalRunCaseResultsTable(),
      KeyConditionExpression: "evalRunId = :rid",
      ExpressionAttributeValues: { ":rid": evalRunId },
    }),
  );
  return (res.Items as EvalRunCaseResult[] | undefined) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────
// Resolution — one EvalRun's rows into the pure compareRuns() input
// shape. This does NOT reimplement scoring: a case row's own persisted
// scoreVector is consumed verbatim; a case with no scoreVector simply
// contributes no rows for this slice (it is not this module's job to
// inline-score — that fallback belongs to the eval-run-aggregator/
// eval-comparison-resolver I/O layer, not the promotion gate's read
// path).
// ─────────────────────────────────────────────────────────────────────────

function parseScoreVector(raw: EvalRunCaseResult): DimensionScore[] | null {
  if (!raw.scoreVector) return null;
  try {
    const parsed = JSON.parse(raw.scoreVector);
    if (!Array.isArray(parsed)) return null;
    return parsed as DimensionScore[];
  } catch {
    // Malformed persisted JSON is an unreadable record, not a silent
    // "no evidence" — the caller distinguishes this from a genuinely
    // absent scoreVector via the UNREADABLE_RECORD reason raised by the
    // caller of this function.
    return null;
  }
}

interface ResolvedRunEvidence {
  run: EvalRun;
  comparisonInput: EvalComparisonRunInput;
  aggregates: DimensionAggregate[];
}

/** Resolves one org-scoped EvalRun by id, checks org ownership and
 * COMPLETED status, and builds both the compareRuns() input rows and the
 * DimensionAggregate[] (from EvalRun.scoreAggregates when present, else
 * computed from the same case rows via aggregateScoreVectors — the
 * existing pure aggregator, never reimplemented). Raises a typed
 * EvidenceResolutionError on any missing/cross-org/malformed condition;
 * never returns a partial/best-guess result. */
async function resolveRunEvidence(
  evalRunId: string,
  expectedOrgId: string,
  requireCompleted: boolean,
): Promise<ResolvedRunEvidence> {
  const run = await getEvalRun(evalRunId);
  if (!run) {
    raise("MISSING_EVAL_RUN", `EvalRun not found: ${evalRunId}`);
  }
  if (typeof run.orgId !== "string" || !run.orgId) {
    raise(
      "UNREADABLE_RECORD",
      `EvalRun ${evalRunId} is missing orgId — cannot verify org ownership`,
    );
  }
  if (run.orgId !== expectedOrgId) {
    raise(
      "CROSS_ORG_EVAL_RUN",
      `EvalRun ${evalRunId} belongs to a different org — refusing to use as gate evidence`,
    );
  }
  if (requireCompleted && run.status !== "COMPLETED") {
    raise(
      "CANDIDATE_RUN_NOT_COMPLETED",
      `EvalRun ${evalRunId} must be COMPLETED to be used as gate evidence (status=${run.status})`,
    );
  }
  if (typeof run.completedAt !== "string" || !run.completedAt) {
    raise(
      "UNREADABLE_RECORD",
      `EvalRun ${evalRunId} is missing completedAt — staleness cannot be assessed`,
    );
  }
  if (typeof run.agentTargetVersion !== "string" || !run.agentTargetVersion) {
    raise(
      "UNREADABLE_RECORD",
      `EvalRun ${evalRunId} is missing agentTargetVersion`,
    );
  }

  const caseRows = await listEvalRunCaseResults(evalRunId);
  const cases: EvalComparisonCaseRow[] = [];
  let scorerVersion = SCORER_VERSION_FALLBACK;
  for (const row of caseRows) {
    const scoreVector = parseScoreVector(row);
    if (row.scoreVector && !scoreVector) {
      raise(
        "UNREADABLE_RECORD",
        `EvalRun ${evalRunId} case ${row.caseId} has a malformed scoreVector`,
      );
    }
    if (scoreVector) {
      cases.push({ caseId: row.caseId, scoreVector });
      if (row.scorerVersion) scorerVersion = row.scorerVersion;
    }
  }

  const comparisonInput: EvalComparisonRunInput = {
    evalRunId: run.evalRunId,
    agentTargetVersion: run.agentTargetVersion,
    scorerVersion,
    cases,
  };

  let aggregates: DimensionAggregate[];
  if (run.scoreAggregates) {
    try {
      const parsed = JSON.parse(run.scoreAggregates);
      if (!Array.isArray(parsed)) {
        raise(
          "UNREADABLE_RECORD",
          `EvalRun ${evalRunId} scoreAggregates is not an array`,
        );
      }
      aggregates = parsed as DimensionAggregate[];
    } catch (err) {
      if (err instanceof EvidenceResolutionError) throw err;
      raise(
        "UNREADABLE_RECORD",
        `EvalRun ${evalRunId} scoreAggregates is malformed JSON`,
      );
    }
  } else {
    aggregates = aggregateScoreVectors(cases);
  }

  return { run, comparisonInput, aggregates };
}

/** Resolves the live EvalSuite for one candidate's pinned suiteId,
 * checking org ownership. Raises a typed EvidenceResolutionError on any
 * missing/cross-org condition. */
async function resolveSuiteEvidence(
  suiteId: string,
  expectedOrgId: string,
): Promise<EvalSuite> {
  const suite = await getEvalSuite(suiteId);
  if (!suite) {
    raise("MISSING_EVAL_SUITE", `EvalSuite not found: ${suiteId}`);
  }
  if (typeof suite.orgId !== "string" || !suite.orgId) {
    raise(
      "UNREADABLE_RECORD",
      `EvalSuite ${suiteId} is missing orgId — cannot verify org ownership`,
    );
  }
  if (suite.orgId !== expectedOrgId) {
    raise(
      "CROSS_ORG_EVAL_SUITE",
      `EvalSuite ${suiteId} belongs to a different org — refusing to use as gate evidence`,
    );
  }
  return suite;
}

/** Resolves the current environment pointer's baseline release + its
 * pinned run, org-checked at every hop. Returns null when no pointer
 * exists (the one, sole, no-baseline case) — never a distinct "empty
 * baseline" error shape. */
async function resolveBaselineComparisonInput(
  orgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
): Promise<EvalComparisonRunInput | null> {
  const currentPointer = await getEnvironmentReleasePointer(
    orgId,
    agentTargetId,
    environment,
  );
  if (!currentPointer) {
    return null;
  }
  if (typeof currentPointer.orgId !== "string" || !currentPointer.orgId) {
    raise(
      "UNREADABLE_RECORD",
      `Environment pointer for ${agentTargetId}/${environment} is missing orgId`,
    );
  }
  if (currentPointer.orgId !== orgId) {
    raise(
      "CROSS_ORG_POINTER",
      `Environment pointer for ${agentTargetId}/${environment} belongs to a different org`,
    );
  }
  if (
    typeof currentPointer.releaseId !== "string" ||
    !currentPointer.releaseId
  ) {
    raise(
      "UNREADABLE_RECORD",
      `Environment pointer for ${agentTargetId}/${environment} is missing releaseId`,
    );
  }

  const baselineRelease = await getRelease(currentPointer.releaseId);
  if (!baselineRelease) {
    raise(
      "MISSING_BASELINE_RELEASE",
      `Baseline release ${currentPointer.releaseId} not found`,
    );
  }
  if (baselineRelease.orgId !== orgId) {
    raise(
      "CROSS_ORG_BASELINE_RELEASE",
      `Baseline release ${currentPointer.releaseId} belongs to a different org — defense in depth beyond the pointer's own org check`,
    );
  }
  if (!baselineRelease.evalEvidence?.evalRunId) {
    raise(
      "UNREADABLE_RECORD",
      `Baseline release ${currentPointer.releaseId} is missing evalEvidence.evalRunId`,
    );
  }

  const { comparisonInput } = await resolveRunEvidence(
    baselineRelease.evalEvidence.evalRunId,
    orgId,
    /* requireCompleted */ true,
  );
  return comparisonInput;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolves everything the pure evaluator (release-gate.ts) needs from a
 * candidate AgentRelease: candidate run/suite/aggregates, the baseline
 * (via the current environment pointer, or `hasBaseline: false` when
 * none exists), and the compareRuns() verdict when a baseline exists.
 *
 * Performs NO writes. Never throws — every failure surfaces as
 * `{ ok: false, reason, detail }`.
 */
export async function resolveReleaseGateEvidence(
  release: AgentRelease,
  environment: EnvironmentLiteral,
  callerOrgId: string,
  policy: PromotionPolicy,
  now: string,
): Promise<EvidenceResolutionResult> {
  if (release.orgId !== callerOrgId) {
    return fail(
      "CROSS_ORG_RELEASE",
      `Release ${release.releaseId} belongs to a different org — resolution must never read across orgs`,
    );
  }

  try {
    const candidate = await resolveRunEvidence(
      release.evalEvidence.evalRunId,
      callerOrgId,
      /* requireCompleted */ true,
    );
    const liveSuite = await resolveSuiteEvidence(
      release.evalEvidence.evalSuiteId,
      callerOrgId,
    );

    const baselineComparisonInput = await resolveBaselineComparisonInput(
      callerOrgId,
      release.agentTargetId,
      environment,
    );

    const inputs: ReleaseGateInputs = {
      hasBaseline: baselineComparisonInput !== null,
      comparisonVerdict: baselineComparisonInput
        ? (compareRuns(baselineComparisonInput, [
            candidate.comparisonInput,
          ]) as EvalComparisonVerdict)
        : undefined,
      candidateAggregates: candidate.aggregates,
      pinnedSuiteVersion: release.evalEvidence.evalSuiteVersion,
      liveSuite,
      runCompletedAt: candidate.run.completedAt as string,
      now,
      policy,
    };

    return { ok: true, inputs };
  } catch (err: unknown) {
    if (err instanceof EvidenceResolutionError) {
      return fail(err.reason, err.message);
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      "release-gate-evidence: unresolvable evidence — resolving to NON-PASS, never swallowed into a pass",
      { releaseId: release.releaseId, environment, error: detail },
    );
    return fail("SDK_ERROR", detail);
  }
}
