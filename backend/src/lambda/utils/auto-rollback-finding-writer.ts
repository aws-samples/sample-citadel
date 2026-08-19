/**
 * auto-rollback-finding-writer.ts — write-once GovernanceFinding row for
 * ONE automated rollback event (decision D6).
 *
 * Mirrors release-gate-finding-writer.ts EXACTLY: same GOVERNANCE_LEDGER_TABLE,
 * same camelCase-key-alias + snake_case-dataclass dual-write convention (so
 * governance-ui-resolver.ts::projectFinding reads it unmodified), same
 * write-once `attribute_not_exists(findingId)` dedupe, same rethrow-every-
 * OTHER-error discipline, same 90-day TTL. NO GovernanceFinding schema
 * change is introduced (decision D7) — this reuses the existing row shape,
 * carrying the rollback specifics inside the free-form `rollback_evidence`
 * object exactly as eval-drift-finding-writer.ts attaches its own evidence.
 *
 * findingId = sha256(`{orgId}#{agentTargetId}#{environment}#{fromVersion}#{action}`)
 * — keyed on the pointer `version` the rollback moved FROM (unique per
 * rollback event) so a retried/duplicate evaluator run collides on PutItem
 * rather than producing a second finding, AND a NEXT-CYCLE backfill of a
 * committed-but-unrecorded rollback re-derives the identical id (idempotent
 * — see the evaluator's finding-write failure handling).
 *
 * This writer RETHROWS every error except the expected dedupe rejection:
 * the evaluator (its sole caller) converts a rethrown failure into an
 * alarmable CloudWatch error metric (D6) so a committed-but-unrecorded
 * rollback is loud, not silent — the pointer move + its gap-free history
 * row are the atomic legal record, but the finding is the analyst-facing
 * evidence and its absence must page.
 */
import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { EnvironmentLiteral, PointerTransitionType } from "../../types";
import type { RollbackMetricName } from "./rollback-policy";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function governanceLedgerTable(): string {
  return process.env.GOVERNANCE_LEDGER_TABLE!;
}

const TTL_DAYS = 90; // Same retention as release-gate-finding-writer.ts.
const REQUESTING_AGENT = "release-rollback-evaluator";
/** SECURITY (must-fix): the decided-by principal for the auto path is a
 * FIXED server identity, never a caller value. Kept in lock-step with the
 * store's minted promotedBy (environment-release-pointer-store.ts's
 * RELEASE_ROLLBACK_SYSTEM_ACTOR). */
export const RELEASE_ROLLBACK_DECIDED_BY = "system:release-rollback-evaluator";

/** Machine-readable proof attached to every auto-rollback finding
 * (acceptance: "every auto-rollback is a ledger finding with metric
 * evidence"). Carried inside the existing finding row's free-form evidence
 * slot — no schema change (D7). */
export interface RollbackEvidence {
  metric: RollbackMetricName;
  arm: "candidate";
  observedValue: number;
  threshold: number;
  sampleCount: number;
  windowStart: string;
  windowEnd: string;
  candidateReleaseId: string;
  stableReleaseId: string;
  fromReleaseId: string;
  toReleaseId: string;
  action: PointerTransitionType;
  fromVersion: number;
}

export interface AutoRollbackFindingInput {
  orgId: string;
  agentTargetId: string;
  environment: EnvironmentLiteral;
  /** The pointer version the rollback moved FROM — the idempotency key
   * component that makes the finding unique per rollback event. */
  fromVersion: number;
  /** The AUTO_* transition performed (the action component of the id). */
  action: PointerTransitionType;
  evidence: RollbackEvidence;
  /** Optional trace id (additive, omit-when-absent — same discipline as
   * release-gate-finding-writer.ts). */
  traceId?: string;
  runId?: string;
}

function findingIdFor(input: AutoRollbackFindingInput): string {
  const raw = `${input.orgId}#${input.agentTargetId}#${input.environment}#${input.fromVersion}#${input.action}`;
  return createHash("sha256").update(raw).digest("hex");
}

function workflowIdFor(input: AutoRollbackFindingInput): string {
  return `RELEASE_ROLLBACK#${input.agentTargetId}#${input.environment}`;
}

function buildReason(input: AutoRollbackFindingInput): string {
  const e = input.evidence;
  return (
    `Automated rollback ${input.action} for agent="${input.agentTargetId}" ` +
    `environment="${input.environment}": candidate arm ${e.metric} ` +
    `observed=${e.observedValue} exceeded threshold=${e.threshold} over ` +
    `${e.sampleCount} samples [${e.windowStart}..${e.windowEnd}]; ` +
    `rolled from release="${e.fromReleaseId}" to release="${e.toReleaseId}" ` +
    `(candidate="${e.candidateReleaseId}", stable="${e.stableReleaseId}").`
  );
}

/**
 * Writes one write-once GovernanceFinding row for an auto-rollback event.
 * Idempotent per (orgId, agentTargetId, environment, fromVersion, action).
 * Rethrows any error other than the expected write-once dedupe rejection
 * (ConditionalCheckFailedException) — the caller alarms on a rethrow.
 */
export async function writeAutoRollbackFinding(
  input: AutoRollbackFindingInput,
): Promise<void> {
  const findingId = findingIdFor(input);
  const workflowId = workflowIdFor(input);
  const timestamp = Date.now() / 1000;
  const ttl = timestamp + TTL_DAYS * 86400;

  const item: Record<string, unknown> = {
    findingId,
    workflowId,
    timestamp,
    workflow_id: workflowId,
    decision: "deny",
    requesting_agent: REQUESTING_AGENT,
    target_agent: input.agentTargetId,
    reason: buildReason(input),
    finding_id: findingId,
    decided_by: RELEASE_ROLLBACK_DECIDED_BY,
    category: "auto-rollback",
    org_id: input.orgId,
    environment: input.environment,
    release_id: input.evidence.fromReleaseId,
    rollback_evidence: input.evidence,
    ttl,
  };

  if (input.traceId !== undefined) {
    item.traceId = input.traceId;
  }
  if (input.runId !== undefined) {
    item.runId = input.runId;
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: governanceLedgerTable(),
        Item: item,
        ConditionExpression: "attribute_not_exists(findingId)",
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // intentional-empty-catch: expected outcome — a finding for this
      // exact (org, agent, environment, fromVersion, action) already
      // exists. Not an error, same dedupe discipline as
      // release-gate-finding-writer.ts.
      return;
    }
    // Every OTHER error is rethrown — the evaluator converts it into an
    // alarmable error metric (D6) so a committed-but-unrecorded rollback
    // pages rather than passing silently.
    throw err;
  }
}
