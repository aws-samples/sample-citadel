/**
 * tool-approval-grant-writer.ts — write-once GovernanceFinding row that
 * PRE-GRANTS a single-use approval for a gated tool (finding c947aa77).
 *
 * Sibling of release-promotion-approval-writer.ts — same
 * GOVERNANCE_LEDGER_TABLE, same key-schema-alias + dataclass dual-write
 * convention, same fail-closed write-once discipline. This is the GRANT
 * half of approval-required tool gating; the worker seam
 * (arbiter/governance/tool_approval.py) READS this row and writes the
 * separate single-use CONSUMPTION marker.
 *
 * Scope (decision f0056afe): the grant is PRE-GRANTABLE per the FULL tuple
 * (orgId, workflowDefinitionId, nodeId, toolName) — NOT per execution
 * (ungrantable before dispatch) and NOT per tool (a standing bearer grant).
 * findingId is derived deterministically from that FULL tuple (same
 * digest the Python reader computes) so the reader's GetItem hits it and
 * NO prefix match can widen scope.
 *
 * Validity vs retention (decision f0056afe, settled constraint): the row
 * carries TWO distinct time attributes that must NEVER be conflated:
 *   * `expiresAt` — the APPLICATION validity window (short, checked in
 *     application code by the worker). An expired grant is refused.
 *   * `ttl`       — the DynamoDB retention attribute (90 days, same as
 *     every other ledger row). This keeps the AUDIT record long after the
 *     approval stops being usable; TTL deletion must never be the mechanism
 *     that "expires" an approval, and expiry must never delete the audit row.
 * Both are written as INTEGER epoch seconds (finding 96d24639 — a native
 * float is rejected by DynamoDB TTL / marshalling).
 *
 * decidedBy is ALWAYS server-derived from the caller's Cognito identity
 * (authContext.userId) — there is deliberately NO `decidedBy` field on the
 * input type, same doctrine as release-promotion-approval-writer.ts. A
 * caller can never author who decided.
 *
 * Separation of duties (explicit v1 choice): the pre-grant model DECOUPLES
 * the approver (decidedBy, at grant time) from the executor (the runtime
 * principal that triggers the workflow and whose executionId single-use-
 * consumes the grant). v1 does NOT hard-block an operator approving a tool
 * they will later trigger — pre-granting is inherently ahead-of-time and
 * there is no single "requester" identity at grant time to diff against.
 * The consuming executionId is recorded on the consumption marker so an
 * auditor can correlate who approved vs which run consumed it. A strict
 * requester≠approver enforcement is deferred (documented in
 * docs/APPROVAL_GATING.md), not silently assumed.
 */
import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function governanceLedgerTable(): string {
  return process.env.GOVERNANCE_LEDGER_TABLE!;
}

const TTL_DAYS = 90; // Retention — DISTINCT from the approval validity window.
const REQUESTING_AGENT = "tool-approval";
export const APPROVAL_GRANT_CATEGORY = "tool-approval";
/** Default application validity window (seconds) when the caller does not
 * specify one. Deliberately short — an approval is meant for the imminent
 * run. Mirrors DEFAULT_APPROVAL_VALIDITY_SECONDS in the Python reader. */
const DEFAULT_VALIDITY_SECONDS = 3600;

export interface ToolApprovalGrantInput {
  orgId: string;
  workflowDefinitionId: string;
  nodeId: string;
  toolName: string;
  /** Server-derived caller identity (authContext.userId from Cognito
   * claims), NEVER caller-supplied. */
  decidedBy: string;
  /** Optional application validity window in seconds (clamped to a sane
   * range). Defaults to DEFAULT_VALIDITY_SECONDS. */
  validitySeconds?: number;
  /** Optional caller justification, carried verbatim. */
  justification?: string | null;
  traceId?: string;
  runId?: string;
}

/**
 * Deterministic finding-id over the FULL tuple — MUST match the Python
 * reader's `grant_finding_id` (sha256 over the same canonical JSON array,
 * prefixed with "tool-approval:"). No prefix matching.
 */
export function grantFindingId(input: {
  orgId: string;
  workflowDefinitionId: string;
  nodeId: string;
  toolName: string;
}): string {
  const canonical = JSON.stringify([
    input.orgId,
    input.workflowDefinitionId,
    input.nodeId,
    input.toolName,
  ]);
  return (
    "tool-approval:" + createHash("sha256").update(canonical).digest("hex")
  );
}

function workflowIdFor(input: ToolApprovalGrantInput): string {
  return `TOOL_APPROVAL#${input.workflowDefinitionId}#${input.nodeId}`;
}

function clampValidity(seconds: number | undefined): number {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return DEFAULT_VALIDITY_SECONDS;
  }
  // Cap at 24h — an approval is a short-lived pre-authorization, never a
  // long-lived standing grant (replay-window control).
  return Math.min(Math.floor(seconds), 24 * 3600);
}

/**
 * Writes one write-once GovernanceFinding row PRE-GRANTING a single-use
 * approval. Idempotent per (org, workflowDefinition, node, tool) — a
 * duplicate grant for the exact tuple is a benign no-op (the existing grant
 * stands). Rethrows any error other than the write-once dedupe rejection
 * (fail-closed, same standing decision as the release approval writer).
 */
export async function writeToolApprovalGrant(
  input: ToolApprovalGrantInput,
): Promise<{ findingId: string; expiresAt: number }> {
  const findingId = grantFindingId(input);
  const workflowId = workflowIdFor(input);
  // INTEGER epoch seconds for both time attributes (finding 96d24639).
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + clampValidity(input.validitySeconds);
  const ttl = nowSeconds + TTL_DAYS * 86400;

  const item: Record<string, unknown> = {
    findingId,
    workflowId,
    // GSI range key — integer epoch (finding 96d24639).
    timestamp: nowSeconds,
    workflow_id: workflowId,
    decision: "permit",
    requesting_agent: REQUESTING_AGENT,
    target_agent: `tool:${input.toolName}`,
    reason:
      `Tool approval GRANTED for tool="${input.toolName}" ` +
      `node="${input.nodeId}" workflowDefinition="${input.workflowDefinitionId}" ` +
      `decidedBy="${input.decidedBy}".`,
    finding_id: findingId,
    // Server-derived decidedBy — NEVER from caller input.
    decided_by: input.decidedBy,
    category: APPROVAL_GRANT_CATEGORY,
    // Scope tuple attributes (the reader re-checks these against the request
    // as defense-in-depth against a colliding-id row).
    orgId: input.orgId,
    workflowDefinitionId: input.workflowDefinitionId,
    nodeId: input.nodeId,
    toolName: input.toolName,
    // APPLICATION validity — DISTINCT from ttl retention (never conflate).
    expiresAt,
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
      // intentional-empty-catch: a grant for this exact tuple already
      // exists — benign write-once idempotency, same discipline as
      // release-promotion-approval-writer.ts. The existing grant stands.
      return { findingId, expiresAt };
    }
    // Fail-closed: every other error aborts the grant.
    throw err;
  }
  return { findingId, expiresAt };
}
