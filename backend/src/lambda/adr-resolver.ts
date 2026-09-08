/**
 * ADR resolver.
 *
 * Implements the createADR / supersedeADR mutations and the getADR /
 * listADRsForProject queries against the citadel-adrs-{env} table. Also
 * exposes an internal lockADR helper used by future stories that coordinate
 * ADR lifecycle (integration tests, reopen flow, etc.). lockADR
 * emits governance.adr.locked via the standalone notifier helper landed in.
 *
 * Lifecycle transitions are validated through LifecycleManager with
 * ADR_TRANSITIONS — see backend/src/adapters/lifecycle.ts.
 *
 * Optimistic concurrency: every mutating write asserts the current DDB
 * version with a ConditionExpression on the `version` attribute, so a stale
 * read that tries to lock or supersede an ADR that was concurrently mutated
 * is rejected with ConditionalCheckFailedException — the invariant required
 * by QT3-2.
 *
 * ## Per-operation disposition (finding 677c1a6c)
 *
 * DEFECT: every op below gated only on hasPermission('adr:create'/
 * 'adr:reopen') and trusted the client-supplied/fetched projectId with NO
 * project-to-organization reconciliation. FIX: `assertProjectOrgAccess`
 * (backend/src/utils/project-org-access.ts) is threaded through every
 * exported function as an OPTIONAL trailing `event` parameter — additive
 * to hasPermission, never a replacement. `handler` always supplies `event`
 * (every real AppSync invocation is gated); internal/system callers that
 * invoke these functions directly with no `event` (project-resolver.ts's
 * phase guard, program-review-resolver.ts, agent-import-resolver.ts's
 * SYSTEM_IMPORT_ADR_AUTHOR path) are unaffected, since they already
 * establish their own right to the projectId before calling in.
 *
 *  - createADR       — GATED. hasPermission('adr:create') unchanged; org
 *                       check on input.projectId runs immediately after
 *                       and BEFORE the PutCommand.
 *  - supersedeADR     — GATED. hasPermission('adr:create') unchanged; org
 *                       check runs on the (already-validated-equal)
 *                       shared projectId of both ADRs, after the
 *                       cross-project ValidationError check and BEFORE the
 *                       UpdateCommand that flips oldAdr to SUPERSEDED.
 *  - reopenADR        — GATED. hasPermission('adr:reopen') unchanged; org
 *                       check runs right after Step 1 fetches the ADR (so
 *                       it has a projectId to reconcile) and BEFORE Step
 *                       2's audit-row PutCommand — a cross-org caller
 *                       never gets an audit row written for a foreign
 *                       project's ADR. Does not disturb audit-before-auth
 *                       ordering for callers who pass the org gate.
 *  - lockADR          — GATED (not a dispatch case — see below). org check
 *                       runs after the fetch and BEFORE the idempotent-
 *                       LOCKED early-return, so a cross-org caller cannot
 *                       observe even that shortcut for a foreign ADR.
 *  - getADR           — GATED. Fetch-then-verify: the projectId to
 *                       reconcile comes from the FETCHED record (adrId is
 *                       the only client-supplied key), so the row is read
 *                       from DynamoDB but the org check runs BEFORE the ADR
 *                       is returned to the caller — nothing is handed back
 *                       before the check passes.
 *  - listADRsForProject — GATED. org check on the client-supplied
 *                       projectId runs BEFORE the QueryCommand, so a
 *                       cross-org caller never triggers a read of another
 *                       tenant's ADR rows at all.
 *
 * lockADR is intentionally NOT a dispatch `case` (no top-level GraphQL
 * mutation exposes it, per its own docblock) — it is still gated (called
 * by integration tests / future lifecycle-coordinating stories) but is
 * exercised via direct unit tests rather than the dispatch-enumeration
 * guard's case-derived list.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { LifecycleManager, ADR_TRANSITIONS } from "../adapters/lifecycle";
import { emitGovernanceEvent } from "../utils/notifier-base";
import { hasPermission } from "../utils/auth";
import { assertProjectOrgAccess } from "../utils/project-org-access";
import type {
  AuthContext,
  ADRReopenAttempt,
  AuthResultLiteral,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ADRS_TABLE = process.env.ADRS_TABLE!;
const ADR_REOPEN_ATTEMPTS_TABLE = process.env.ADR_REOPEN_ATTEMPTS_TABLE!;
const adrLifecycle = new LifecycleManager(ADR_TRANSITIONS);

export type ADRStatusLiteral =
  "PROPOSED" | "LOCKED" | "SUPERSEDED" | "REOPENED";
export type ADRSeverityLiteral = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ADRInput {
  projectId: string;
  title: string;
  decision: string;
  reasoning: string;
  constraints: string[];
  alternativesConsidered: string[];
  revisitConditions: string[];
  severity?: ADRSeverityLiteral;
  affectsModules?: string[];
  reviewers?: string[];
  sourceRoundIds: string[];
}

export interface ADR extends ADRInput {
  adrId: string;
  status: ADRStatusLiteral;
  version: number;
  createdAt: string;
  createdBy: string;
  lockedAt?: string;
  supersededBy?: string;
}

/** Merged view of every argument this resolver's fields receive. */
interface ADRResolverArguments {
  input: ADRInput;
  adrId: string;
  oldAdrId: string;
  newAdrId: string;
  proposedChange: string;
  revisitConditionMatched: boolean;
  reason: string;
  projectId: string;
}

type ADRResolverEvent = GovernanceResolverEvent<ADRResolverArguments>;

function authContextFromEvent(event: ADRResolverEvent): AuthContext {
  const identity: GovernanceEventIdentity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole] : [],
  };
}

/**
 * Truncate long string values in event.arguments so that error logs cannot
 * be weaponised to exfiltrate long payloads. Non-string values pass through.
 */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  return out;
}

/**
 * `event` is OPTIONAL and additive to `hasPermission('adr:create')`, never a
 * replacement for it (finding 677c1a6c). When supplied — i.e. every real
 * AppSync invocation, via `handler` — the caller's organization is
 * reconciled against `input.projectId`'s owning organization BEFORE any
 * write, closing the cross-tenant ADR-creation hole. When omitted, this is
 * an internal/system call (project-resolver's phase guard,
 * agent-import-resolver's SYSTEM_IMPORT_ADR_AUTHOR path) that has already
 * established its own right to operate on the given projectId — those call
 * sites are unaffected.
 */
export async function createADR(
  input: ADRInput,
  authContext: AuthContext,
  event?: unknown,
): Promise<ADR> {
  if (!hasPermission(authContext, "adr:create")) {
    throw new Error("UnauthorizedError: adr:create permission required");
  }
  if (event !== undefined) {
    await assertProjectOrgAccess(input.projectId, event);
  }
  if (!input.decision) {
    throw new Error("ValidationError: decision is required");
  }
  if (!input.reasoning) {
    throw new Error("ValidationError: reasoning is required");
  }
  if (
    !Array.isArray(input.constraints) ||
    !Array.isArray(input.alternativesConsidered) ||
    !Array.isArray(input.revisitConditions)
  ) {
    throw new Error(
      "ValidationError: constraints, alternativesConsidered, revisitConditions must be arrays",
    );
  }
  if (!Array.isArray(input.sourceRoundIds)) {
    throw new Error("ValidationError: sourceRoundIds must be an array");
  }

  const adr: ADR = {
    adrId: uuidv4(),
    projectId: input.projectId,
    title: input.title,
    decision: input.decision,
    reasoning: input.reasoning,
    constraints: input.constraints,
    alternativesConsidered: input.alternativesConsidered,
    revisitConditions: input.revisitConditions,
    severity: input.severity,
    affectsModules: input.affectsModules,
    reviewers: input.reviewers,
    sourceRoundIds: input.sourceRoundIds,
    status: "PROPOSED",
    version: 1,
    createdAt: new Date().toISOString(),
    createdBy: authContext.userId,
  };

  await docClient.send(
    new PutCommand({
      TableName: ADRS_TABLE,
      Item: adr,
      ConditionExpression: "attribute_not_exists(adrId)",
    }),
  );
  return adr;
}

/**
 * `event` is OPTIONAL (see createADR's docblock for the rationale). When
 * supplied, the org check runs AFTER the row is fetched (the projectId to
 * reconcile against comes from the fetched record, not a caller-supplied
 * argument) and BEFORE the ADR is returned to the caller — nothing is
 * handed back before the check passes.
 */
export async function getADR(
  adrId: string,
  event?: unknown,
): Promise<ADR | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: ADRS_TABLE, Key: { adrId } }),
  );
  const adr = (res.Item as ADR | undefined) ?? null;
  if (adr && event !== undefined) {
    await assertProjectOrgAccess(adr.projectId, event);
  }
  return adr;
}

/**
 * `event` is OPTIONAL (see createADR's docblock). When supplied, the org
 * check runs BEFORE the QueryCommand against ADRS_TABLE, so a cross-org
 * caller never triggers a read of another tenant's ADR rows at all.
 */
export async function listADRsForProject(
  projectId: string,
  event?: unknown,
): Promise<ADR[]> {
  if (event !== undefined) {
    await assertProjectOrgAccess(projectId, event);
  }
  const res = await docClient.send(
    new QueryCommand({
      TableName: ADRS_TABLE,
      IndexName: "project-index",
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
    }),
  );
  return (res.Items as ADR[] | undefined) ?? [];
}

/**
 * `event` is OPTIONAL (see createADR's docblock). When supplied, both ADRs'
 * shared projectId (already validated equal below) is org-checked BEFORE
 * the UpdateCommand that flips oldAdr to SUPERSEDED.
 */
export async function supersedeADR(
  oldAdrId: string,
  newAdrId: string,
  authContext: AuthContext,
  event?: unknown,
): Promise<ADR> {
  if (!hasPermission(authContext, "adr:create")) {
    throw new Error(
      "UnauthorizedError: adr:create permission required to supersede",
    );
  }
  const oldAdr = await getADR(oldAdrId);
  if (!oldAdr) throw new Error(`ADR not found: ${oldAdrId}`);
  const newAdr = await getADR(newAdrId);
  if (!newAdr) throw new Error(`ADR not found: ${newAdrId}`);
  if (oldAdr.projectId !== newAdr.projectId) {
    throw new Error(
      "ValidationError: superseding ADR must belong to the same projectId",
    );
  }
  if (event !== undefined) {
    await assertProjectOrgAccess(oldAdr.projectId, event);
  }
  // Guard: an already-SUPERSEDED ADR is terminal; it cannot be superseded
  // again even though LifecycleManager's same-state idempotence would
  // otherwise accept SUPERSEDED -> SUPERSEDED. Re-supersession would
  // overwrite supersededBy and break the ADR history chain.
  if (oldAdr.status === "SUPERSEDED") {
    throw new Error(
      `Invalid status transition: ${oldAdr.status} → SUPERSEDED. ` +
        "ADR is already superseded and is terminal.",
    );
  }
  adrLifecycle.validateTransition(oldAdr.status, "SUPERSEDED");

  const currentVersion = oldAdr.version;
  const res = await docClient.send(
    new UpdateCommand({
      TableName: ADRS_TABLE,
      Key: { adrId: oldAdrId },
      UpdateExpression:
        "SET #status =:newStatus, supersededBy =:newAdrId, #version = :newVersion",
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: { "#status": "status", "#version": "version" },
      ExpressionAttributeValues: {
        ":newStatus": "SUPERSEDED",
        ":newAdrId": newAdrId,
        ":newVersion": currentVersion + 1,
        ":currentVersion": currentVersion,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes as ADR;
}

/**
 * Reopen a LOCKED ADR. Implements the audit-before-auth
 * pattern locked by QT2A-7 + QT3-3: the audit row is written BEFORE the
 * Cognito permission check. If auth is denied, the row records
 * authResult='DENIED' and the resolver throws UnauthorizedError; if auth
 * is allowed, the row is updated to authResult='ALLOWED' and the ADR
 * transitions LOCKED → REOPENED. If the lifecycle transition then fails,
 * the audit row's transitionError is populated — the audit row stays
 * ALLOWED (auth WAS allowed; only the subsequent transition failed).
 *
 * The invariant 'audit row exists ∀ invocation' must hold under every
 * combination of (user-role, adr-status, revisitConditionMatched).
 *
 * Emits governance.adr.reopen.attempted via the standalone notifier from
 * with payload {projectId, adrId, revisitConditionMatched,
 * attemptedBy, authResult}. The event is emitted regardless of outcome
 * (DENIED attempts are emitted too, so downstream monitoring can alert).
 *
 * Input-shape validation runs BEFORE the audit write so we do not pollute
 * the audit table with malformed attempts — the GraphQL schema already
 * enforces the types, so a failure here indicates a caller bypassing the
 * schema (direct Lambda invoke, test harness, etc.), not a user action
 * that deserves non-repudiation.
 *
 * `event` is OPTIONAL (see createADR's docblock). When supplied, the org
 * check runs immediately after Step 1 fetches the ADR (so it has a
 * projectId to reconcile) and BEFORE Step 2's audit-row write — a cross-org
 * caller never gets an audit row for a foreign project's ADR, matching the
 * "zero writes... of foreign data" acceptance bar. This does not disturb
 * the audit-before-auth ordering for a same-org caller: the audit write
 * still precedes the adr:reopen permission check for every request that
 * passes the org gate.
 */
export async function reopenADR(
  adrId: string,
  proposedChange: string,
  revisitConditionMatched: boolean,
  reason: string,
  authContext: AuthContext,
  event?: unknown,
): Promise<ADR> {
  // Step 0: validate input shape (pre-audit — see docblock).
  if (typeof proposedChange !== "string") {
    throw new Error("ValidationError: proposedChange must be a string");
  }
  if (typeof reason !== "string") {
    throw new Error("ValidationError: reason must be a string");
  }
  if (typeof revisitConditionMatched !== "boolean") {
    throw new Error(
      "ValidationError: revisitConditionMatched must be a boolean",
    );
  }

  // Step 1: lookup the ADR so we can stamp projectId onto the audit row
  // even on DENIED or ADR-not-found outcomes. If the ADR doesn't exist,
  // still audit the attempt with projectId='' so the audit trail records
  // who tried and when.
  const adr = await getADR(adrId);
  const projectId = adr?.projectId ?? "";

  // Step 1b: org gate. Only enforceable when the ADR (and therefore a
  // projectId) exists — a missing ADR has no project to reconcile against,
  // so it falls through to the existing audit-then-not-found path below.
  if (adr && event !== undefined) {
    await assertProjectOrgAccess(projectId, event);
  }

  // Step 2: write audit row with authResult='PENDING' BEFORE the permission
  // check. This is the critical audit-before-auth ordering.
  const attemptId = uuidv4();
  const attemptedAt = new Date().toISOString();
  const auditRow: ADRReopenAttempt = {
    attemptId,
    adrId,
    projectId,
    attemptedBy: authContext.userId,
    attemptedAt,
    proposedChange,
    revisitConditionMatched,
    reason,
    authResult: "PENDING",
  };
  await docClient.send(
    new PutCommand({
      TableName: ADR_REOPEN_ATTEMPTS_TABLE,
      Item: auditRow,
      ConditionExpression: "attribute_not_exists(attemptId)",
    }),
  );

  // Step 3: NOW check the Cognito permission.
  const authorised = hasPermission(authContext, "adr:reopen");
  const authResult: AuthResultLiteral = authorised ? "ALLOWED" : "DENIED";

  // Step 4: update the audit row to reflect the auth outcome.
  await docClient.send(
    new UpdateCommand({
      TableName: ADR_REOPEN_ATTEMPTS_TABLE,
      Key: { attemptId },
      UpdateExpression: "SET authResult = :ar",
      ExpressionAttributeValues: { ":ar": authResult },
    }),
  );

  // Step 5: emit governance.adr.reopen.attempted regardless of outcome.
  // Downstream alerting on DENIED counts relies on both branches emitting.
  await emitGovernanceEvent("governance.adr.reopen.attempted", {
    projectId,
    adrId,
    revisitConditionMatched,
    attemptedBy: authContext.userId,
    authResult: authorised ? "ALLOWED" : "DENIED",
  });

  // Step 6: if auth denied, throw. Audit row is already persisted + emitted.
  if (!authorised) {
    throw new Error("UnauthorizedError: adr:reopen permission required");
  }

  // Step 7: if the ADR did not exist, surface that AFTER auditing the
  // attempt (so denied-and-missing is a loud log event but not silent).
  if (!adr) {
    throw new Error(`ADR not found: ${adrId}`);
  }

  // Step 8: validate lifecycle transition. LOCKED → REOPENED is the only
  // valid path per ADR_TRANSITIONS. If current status is not LOCKED, the
  // ValidationError propagates and the audit row remains ALLOWED with
  // transitionError populated.
  try {
    adrLifecycle.validateTransition(adr.status, "REOPENED");
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await docClient.send(
      new UpdateCommand({
        TableName: ADR_REOPEN_ATTEMPTS_TABLE,
        Key: { attemptId },
        UpdateExpression: "SET transitionError = :te",
        ExpressionAttributeValues: { ":te": msg },
      }),
    );
    throw err;
  }

  // Step 9: transition the ADR. Optimistic lock on version. If the
  // ConditionExpression fails (concurrent update from another caller),
  // the exception propagates — the audit row stays ALLOWED without a
  // transitionError (the failure is a DDB-level race, not a lifecycle
  // violation).
  const currentVersion = adr.version;
  const res = await docClient.send(
    new UpdateCommand({
      TableName: ADRS_TABLE,
      Key: { adrId },
      UpdateExpression: "SET #status = :newStatus, #version = :newVersion",
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: { "#status": "status", "#version": "version" },
      ExpressionAttributeValues: {
        ":newStatus": "REOPENED",
        ":newVersion": currentVersion + 1,
        ":currentVersion": currentVersion,
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  return res.Attributes as ADR;
}

/**
 * Lock an ADR (PROPOSED → LOCKED). Not exposed as a top-level GraphQL
 * mutation in this story — used by integration tests and by future stories
 * that coordinate ADR lifecycle. Emits governance.adr.locked on success.
 *
 * Idempotent early-return: if the ADR is already LOCKED, we short-circuit
 * BEFORE running the lifecycle validation or DDB update. This prevents a
 * spurious second emission of governance.adr.locked and a stray version
 * bump when the caller retries. The alternative of routing through
 * validateTransition (which accepts same-state) would either re-emit or
 * fight the optimistic-lock ConditionExpression depending on the retry
 * pattern — early-return is the simpler, safer choice per QT3-5 review.
 *
 * `event` is OPTIONAL (see createADR's docblock). When supplied, the org
 * check runs after the fetch (needs the ADR's projectId) and BEFORE the
 * idempotent-LOCKED early-return / lifecycle validation / UpdateCommand —
 * a cross-org caller cannot even observe the idempotent "already locked"
 * shortcut for a foreign ADR.
 */
export async function lockADR(
  adrId: string,
  authContext: AuthContext,
  event?: unknown,
): Promise<ADR> {
  if (!hasPermission(authContext, "adr:create")) {
    throw new Error(
      "UnauthorizedError: adr:create permission required to lock",
    );
  }
  const adr = await getADR(adrId);
  if (!adr) throw new Error(`ADR not found: ${adrId}`);
  if (event !== undefined) {
    await assertProjectOrgAccess(adr.projectId, event);
  }
  if (adr.status === "LOCKED") return adr;
  adrLifecycle.validateTransition(adr.status, "LOCKED");

  const currentVersion = adr.version;
  const res = await docClient.send(
    new UpdateCommand({
      TableName: ADRS_TABLE,
      Key: { adrId },
      UpdateExpression:
        "SET #status = :newStatus, lockedAt = :lockedAt, #version = :newVersion",
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: { "#status": "status", "#version": "version" },
      ExpressionAttributeValues: {
        ":newStatus": "LOCKED",
        ":lockedAt": new Date().toISOString(),
        ":newVersion": currentVersion + 1,
        ":currentVersion": currentVersion,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  const locked = res.Attributes as ADR;
  await emitGovernanceEvent("governance.adr.locked", {
    projectId: locked.projectId,
    adrId: locked.adrId,
    title: locked.title,
    sourceRoundIds: locked.sourceRoundIds ?? [],
  });
  return locked;
}

export const handler = async (event: ADRResolverEvent): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "createADR":
        return await createADR(
          event.arguments.input as ADRInput,
          authContext,
          event,
        );
      case "supersedeADR":
        return await supersedeADR(
          event.arguments.oldAdrId,
          event.arguments.newAdrId,
          authContext,
          event,
        );
      case "reopenADR":
        return await reopenADR(
          event.arguments.adrId,
          event.arguments.proposedChange,
          event.arguments.revisitConditionMatched,
          event.arguments.reason,
          authContext,
          event,
        );
      case "getADR":
        return await getADR(event.arguments.adrId, event);
      case "listADRsForProject":
        return await listADRsForProject(event.arguments.projectId, event);
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("adr-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
