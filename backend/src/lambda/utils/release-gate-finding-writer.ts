/**
 * release-gate-finding-writer.ts — write-once GovernanceFinding row for
 * ONE release-promotion gate decision.
 *
 * Writes into the SAME `GOVERNANCE_LEDGER_TABLE` the Python arbiter's
 * `arbiter/governance/ledger.py::write_finding` writes, using the same
 * key-schema aliases (camelCase) + dataclass field names (snake_case)
 * dual-write convention already established by
 * eval-drift-finding-writer.ts, so governance-ui-resolver.ts's existing
 * `projectFinding` reads this row unmodified.
 *
 * DIFFERS DELIBERATELY from eval-drift-finding-writer.ts's error
 * handling: that writer is a best-effort observability side-channel and
 * drops any non-dedupe error (log + return). This writer is NOT
 * best-effort — in shadow mode, the finding written here is the ONLY
 * durable record that the promotion gate would have blocked. A swallowed
 * write failure in shadow mode would silently erase the sole evidence of
 * a would-block, defeating the reason shadow mode exists (rollout
 * telemetry). So this writer rethrows every error EXCEPT the expected
 * write-once dedupe rejection (ConditionalCheckFailedException), which
 * means "a finding for this exact decision already exists" — not a
 * failure — same as the drift writer's dedupe case.
 *
 * ORDERING NOTE (see environment-release-pointer-resolver.ts's slice-3
 * wiring comment for the full justification): callers in STRICT mode
 * must decide whether to throw the promotion-refusing error from the
 * ALREADY-COMPUTED verdict alone, independent of whether this writer's
 * own write succeeds — i.e. the caller must not let a write failure here
 * either (a) suppress the strict refusal, or (b) replace it with an
 * unrelated DynamoDB exception that looks like the gate "passed". This
 * module does not enforce that ordering itself (it has no opinion on
 * strict vs shadow); it only guarantees its own errors are never
 * silently dropped, so the caller's ordering choice is not undermined by
 * a swallowed exception here.
 *
 * findingId is derived deterministically from
 * `{orgId}#{agentTargetId}#{environment}#{releaseId}#{decision}` (a
 * stable hash, not a fresh UUID) — same idempotency discipline as
 * eval-drift-finding-writer.ts's `findingIdFor`. A promotion attempt that
 * is retried against the SAME release+environment+decision collides on
 * PutItem rather than producing a duplicate finding row.
 */
import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { GovernanceEnforce } from "../../utils/governance-flag";
import type { DimensionAggregate } from "./eval-score-aggregate";
import type { EnvironmentLiteral } from "../../types";
import type { ReleaseGateReason } from "./release-gate";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function governanceLedgerTable(): string {
  return process.env.GOVERNANCE_LEDGER_TABLE!;
}

const TTL_DAYS = 90; // Same default retention as eval-drift-finding-writer.ts.
const REQUESTING_AGENT = "release-quality-gate";

/** The two ArbitrationDecision literals a promotion gate can produce.
 * (Python's `ArbitrationDecision` also has `escalate`/`halt` for other
 * arbitration contexts — this gate never emits those.) */
export type ReleaseGateDecision = "permit" | "deny";

export interface ReleaseGateFindingInput {
  orgId: string;
  agentTargetId: string;
  environment: EnvironmentLiteral;
  releaseId: string;
  /** Server-derived caller identity (from Cognito claims), never from
   * caller-supplied input. */
  decidedBy: string;
  decision: ReleaseGateDecision;
  /** Machine-readable reasons from ReleaseGateVerdict.reasons — carried
   * verbatim, not summarized, so the exact gate outcome is
   * reconstructable from the finding alone. */
  reasons: ReleaseGateReason[];
  /** The full score-vector detail (ReleaseGateVerdict.scoreVector) — an
   * auditable decision must show what evidence produced it, not just
   * the pass/fail label. */
  scoreVector: DimensionAggregate[];
  mode: GovernanceEnforce;
}

function findingIdFor(input: ReleaseGateFindingInput): string {
  const raw = `${input.orgId}#${input.agentTargetId}#${input.environment}#${input.releaseId}#${input.decision}`;
  return createHash("sha256").update(raw).digest("hex");
}

function workflowIdFor(input: ReleaseGateFindingInput): string {
  return `RELEASE_PROMOTION#${input.agentTargetId}#${input.environment}`;
}

function buildReason(input: ReleaseGateFindingInput): string {
  const reasonList =
    input.reasons.length > 0 ? input.reasons.join(", ") : "PASS";
  const scoreDetail = input.scoreVector
    .map((agg) => {
      const parts: string[] = [];
      if (typeof agg.passRate === "number")
        parts.push(`passRate=${agg.passRate}`);
      if (typeof agg.meanScore === "number")
        parts.push(`meanScore=${agg.meanScore}`);
      if (typeof agg.p95 === "number") parts.push(`p95=${agg.p95}`);
      if (typeof agg.meanUsd === "number") parts.push(`meanUsd=${agg.meanUsd}`);
      parts.push(`n=${agg.scoredCount}`);
      return `${agg.dimension}(${parts.join(",")})`;
    })
    .join("; ");
  return (
    `Release promotion gate ${input.decision.toUpperCase()} for ` +
    `release="${input.releaseId}" agent="${input.agentTargetId}" ` +
    `environment="${input.environment}" mode="${input.mode}": ` +
    `reasons=[${reasonList}] scoreVector=[${scoreDetail}].`
  );
}

/**
 * Writes one write-once GovernanceFinding row for a release-promotion
 * gate decision. Idempotent per (orgId, agentTargetId, environment,
 * releaseId, decision) — see module doc. Rethrows any error other than
 * the expected write-once dedupe rejection — see module doc for why this
 * writer must NOT swallow errors the way eval-drift-finding-writer.ts
 * does.
 */
export async function writeReleaseGateFinding(
  input: ReleaseGateFindingInput,
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
    decision: input.decision,
    requesting_agent: REQUESTING_AGENT,
    target_agent: input.agentTargetId,
    reason: buildReason(input),
    finding_id: findingId,
    decided_by: input.decidedBy,
    category: "release-promotion",
    org_id: input.orgId,
    environment: input.environment,
    release_id: input.releaseId,
    enforcement_mode: input.mode,
    score_vector: input.scoreVector,
    gate_reasons: input.reasons,
    ttl,
  };

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
      // exact (org, agent, environment, release, decision) already
      // exists. Not an error, same dedupe discipline as
      // eval-drift-finding-writer.ts.
      return;
    }
    // Every OTHER error is rethrown — see module doc: unlike
    // eval-drift-finding-writer.ts, this writer is not a best-effort
    // side channel, and swallowing here would erase shadow mode's sole
    // record of a would-block decision.
    throw err;
  }
}
