/**
 * release-promotion-approval-writer.ts — write-once GovernanceFinding row
 * for ONE interim human-approval decision on a release promotion.
 *
 * Sibling of release-gate-finding-writer.ts — mirrors its contract
 * exactly (same GOVERNANCE_LEDGER_TABLE, same key-schema aliases
 * (camelCase) + dataclass field names (snake_case) dual-write
 * convention, same write-once dedupe discipline), so
 * governance-ui-resolver.ts's existing `projectFinding` reads this row
 * unmodified. Decision 8165b7e5: this is the interim human-approval
 * substrate riding the existing promote mutation — the CIT-030 approval
 * substrate does not exist, so this writer + the `PromotionApproval`
 * input on `promoteEnvironmentReleasePointer` are the whole of it.
 *
 * category is `release-promotion-approval` — distinct from the release
 * gate's `release-promotion` category (release-gate-finding-writer.ts)
 * — so the two decisions are never conflated when querying findings by
 * category, even though both write into the same ledger table for the
 * same release+environment.
 *
 * decidedBy is ALWAYS `authContext.userId` (Cognito, server-derived) —
 * the caller must never be able to author who decided; there is
 * deliberately no `decidedBy` field on the input type at all (see
 * ReleasePromotionApprovalInput below), matching the schema-level
 * doctrine that `PromotionApproval` (schema.graphql) carries no
 * `decidedBy` field either.
 *
 * FAIL-CLOSED, same as release-gate-finding-writer.ts and the SAME
 * standing user decision (finding 23971f32): a failed write here must
 * abort the promotion, never be swallowed. Only the expected write-once
 * dedupe rejection (ConditionalCheckFailedException) is caught; every
 * other error is rethrown unchanged.
 *
 * findingId is derived deterministically from
 * `{orgId}#{agentTargetId}#{environment}#{releaseId}#approval#{decision}`
 * — same idempotency discipline as release-gate-finding-writer.ts's
 * findingIdFor, with an extra `#approval` segment so an approval
 * decision's findingId can never collide with the gate's own finding
 * for the same release+environment+decision.
 */
import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { EnvironmentLiteral } from "../../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function governanceLedgerTable(): string {
  return process.env.GOVERNANCE_LEDGER_TABLE!;
}

const TTL_DAYS = 90; // Same default retention as release-gate-finding-writer.ts.
const REQUESTING_AGENT = "release-promotion-approval";

/** The two ArbitrationDecision literals an approval decision can
 * produce, derived from `approved` at the call site. */
export type ReleasePromotionApprovalDecision = "permit" | "deny";

export interface ReleasePromotionApprovalInput {
  orgId: string;
  agentTargetId: string;
  environment: EnvironmentLiteral;
  releaseId: string;
  /** Server-derived caller identity (from Cognito claims via
   * authContext.userId), never from caller-supplied input. */
  decidedBy: string;
  decision: ReleasePromotionApprovalDecision;
  /** Caller-supplied justification, carried verbatim. Optional — the
   * `PromotionApproval` schema input's `justification` field is
   * nullable. */
  justification?: string | null;
  traceId?: string;
  runId?: string;
}

function findingIdFor(input: ReleasePromotionApprovalInput): string {
  const raw = `${input.orgId}#${input.agentTargetId}#${input.environment}#${input.releaseId}#approval#${input.decision}`;
  return createHash("sha256").update(raw).digest("hex");
}

function workflowIdFor(input: ReleasePromotionApprovalInput): string {
  return `RELEASE_PROMOTION_APPROVAL#${input.agentTargetId}#${input.environment}`;
}

function buildReason(input: ReleasePromotionApprovalInput): string {
  const justificationPart = input.justification
    ? ` justification="${input.justification}"`
    : "";
  return (
    `Release promotion approval ${input.decision.toUpperCase()} for ` +
    `release="${input.releaseId}" agent="${input.agentTargetId}" ` +
    `environment="${input.environment}" decidedBy="${input.decidedBy}".` +
    justificationPart
  );
}

/**
 * Writes one write-once GovernanceFinding row for a release-promotion
 * approval decision. Idempotent per (orgId, agentTargetId, environment,
 * releaseId, decision) — see module doc. Rethrows any error other than
 * the expected write-once dedupe rejection (ConditionalCheckFailedException).
 */
export async function writeReleasePromotionApprovalFinding(
  input: ReleasePromotionApprovalInput,
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
    category: "release-promotion-approval",
    org_id: input.orgId,
    environment: input.environment,
    release_id: input.releaseId,
    ttl,
  };

  if (input.justification !== undefined && input.justification !== null) {
    item.justification = input.justification;
  }
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
      // exact (org, agent, environment, release, approval, decision)
      // already exists. Not an error, same dedupe discipline as
      // release-gate-finding-writer.ts.
      return;
    }
    // Every OTHER error is rethrown — approval recording is FAIL-CLOSED
    // same as the gate finding (a failed write aborts the promotion;
    // that is the standing user decision, finding 23971f32).
    throw err;
  }
}
