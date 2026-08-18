/**
 * environment-release-pointer-store.ts — the SOLE write choke point for
 * EnvironmentReleasePointersTable.
 *
 * Unlike release-store.ts (AgentReleasesTable), this record is
 * deliberately MUTABLE — it is the cursor saying which AgentRelease an
 * (org, agent, environment) triple currently runs. Two properties this
 * module exists to guarantee at the WRITE BOUNDARY, not in application
 * logic alone:
 *
 *  1. Optimistic locking via a DynamoDB ConditionExpression on the
 *     `version` attribute. Two concurrent promotions racing against the
 *     same stale read must not both succeed — the second Put is rejected
 *     by DynamoDB itself (ConditionalCheckFailedException, surfaced here
 *     as ConcurrentPromotionError) rather than silently overwriting the
 *     first caller's move. A single conditional Put covers both the
 *     first-ever promotion (attribute_not_exists(orgId), mirroring
 *     release-store.ts's create-only guard) and every subsequent move
 *     (#version = :expectedVersion) via one OR'd ConditionExpression, so
 *     there is exactly one write path rather than a create/update branch
 *     that could disagree on locking semantics.
 *  2. previousReleaseId retention on every move, so a later rollback
 *     story can read what was running immediately before the current
 *     release without replaying history from another table.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  CanaryState,
  EnvironmentLiteral,
  EnvironmentReleasePointer,
  EnvironmentReleasePointerHistoryEntry,
  PointerTransitionType,
} from "../types";
import { historySortKeyPrefix } from "./environment-release-pointer-history-store";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function tableName(): string {
  return process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE!;
}

/** Sparse ActiveCanaryIndex GSI (decision D8) — enumerates every pointer
 * that currently carries a canary, so the auto-rollback evaluator never
 * Scans the pointer table. Mirrors the BudgetIndex sparse-GSI precedent
 * (cost-budget-evaluator.ts): the marker attributes below are written ONLY
 * when a canary is present, so a pointer with no canary is absent from the
 * index. Because every pointer write is a full-item Put, clearing the
 * canary (promote/abort) overwrites the item WITHOUT the marker attrs,
 * which removes it from the index in the SAME atomic write — there is no
 * window where the index disagrees with pointer state (security invariant
 * INV: marker maintained inside the sole writer's atomic Put). */
export const ACTIVE_CANARY_GSI = "ActiveCanaryIndex";
export const ACTIVE_CANARY_PK_ATTR = "activeCanaryPk";
export const ACTIVE_CANARY_SK_ATTR = "activeCanarySk";
/** Constant partition for the sparse index — one hot-but-tiny partition of
 * ONLY the currently-active canaries (there are very few at a time). */
export const ACTIVE_CANARY_PK = "CANARY_ACTIVE";

/** SECURITY (must-fix): the fixed server principal minted for every
 * automated pointer move. Kept in lock-step with
 * auto-rollback-finding-writer.ts's RELEASE_ROLLBACK_DECIDED_BY. Never
 * accepted from caller input on the auto path. */
export const RELEASE_ROLLBACK_SYSTEM_ACTOR =
  "system:release-rollback-evaluator";

function historyTableName(): string {
  return process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE!;
}

function sortKey(
  agentTargetId: string,
  environment: EnvironmentLiteral,
): string {
  return `${agentTargetId}#${environment}`;
}

/** Thrown when the write boundary's ConditionExpression rejects a Put
 * because the caller's expectedVersion no longer matches the stored row
 * — i.e. another promotion won the race. Distinct from a generic
 * DynamoDB error so callers/resolvers can react specifically (surface a
 * "someone else just promoted this" message rather than a raw AWS
 * exception) without string-matching on error text. */
export class ConcurrentPromotionError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly agentTargetId: string,
    public readonly environment: EnvironmentLiteral,
  ) {
    super(
      `ConcurrentPromotionError: the environment release pointer for ${agentTargetId}/${environment} (org ${orgId}) was moved by another promotion — reload and retry`,
    );
    this.name = "ConcurrentPromotionError";
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  // Direct conditional Put failure (kept for callers/tests that still
  // surface a bare ConditionalCheckFailedException) AND the
  // TransactWriteItems form: a cancelled transaction whose pointer-Put
  // condition failed surfaces as TransactionCanceledException carrying a
  // CancellationReasons entry with Code "ConditionalCheckFailed". Either
  // shape means "another promotion won the race".
  if (name === "ConditionalCheckFailedException") return true;
  if (name === "TransactionCanceledException") {
    const reasons = (err as { CancellationReasons?: { Code?: string }[] })
      .CancellationReasons;
    if (Array.isArray(reasons)) {
      return reasons.some((r) => r?.Code === "ConditionalCheckFailed");
    }
    // Some SDK/runtime combinations only embed the reason in the message.
    const message = (err as { message?: string }).message ?? "";
    return /ConditionalCheckFailed/.test(message);
  }
  return false;
}

/** Point read for the current pointer of one (org, agent, environment). */
export async function getEnvironmentReleasePointer(
  orgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
): Promise<EnvironmentReleasePointer | null> {
  const res = await docClient.send(
    new GetCommand({
      TableName: tableName(),
      Key: {
        orgId,
        agentTargetId_environment: sortKey(agentTargetId, environment),
      },
    }),
  );
  return (res.Item as EnvironmentReleasePointer | undefined) ?? null;
}

/** Every environment's pointer for one agent, within the caller's org. */
export async function listEnvironmentReleasePointersForAgent(
  orgId: string,
  agentTargetId: string,
): Promise<EnvironmentReleasePointer[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression:
        "orgId = :oid AND begins_with(agentTargetId_environment, :prefix)",
      ExpressionAttributeValues: {
        ":oid": orgId,
        ":prefix": `${agentTargetId}#`,
      },
    }),
  );
  return (res.Items as EnvironmentReleasePointer[] | undefined) ?? [];
}

export interface SetEnvironmentReleasePointerParams {
  orgId: string;
  agentTargetId: string;
  environment: EnvironmentLiteral;
  releaseId: string;
  /** The version the caller last read (null for a brand-new pointer that
   * has never been set). Enforced via ConditionExpression, not re-checked
   * in application logic after the read. */
  expectedVersion: number | null;
  /** The releaseId the caller observed as currently active, carried
   * forward verbatim as previousReleaseId on this move. Omitted (or
   * undefined) on a first-ever promotion, where previousReleaseId is
   * null. */
  currentReleaseId?: string | null;
  promotedBy: string;
  /** Canary state to write onto the pointer (decision D2). Omit or pass
   * `null` to write NO canary attribute (a plain promotion, or a
   * CANARY_PROMOTE/ABORT that clears the canary) — such a row resolves
   * 100% stable, backward-compatible with every pre-canary reader. */
  canary?: CanaryState | null;
  /** The transition discriminator recorded on both the pointer and its
   * history row (I3). Defaults to "PROMOTE" (the pre-canary move) so
   * existing callers are undisturbed. */
  transitionType?: PointerTransitionType;
}

/**
 * Create-or-move write for the (orgId, agentTargetId, environment)
 * pointer. This is the ONLY function in the codebase permitted to issue a
 * write against EnvironmentReleasePointersTable — AND the ONLY writer of
 * EnvironmentReleasePointerHistoryTable (G6), by the SAME single-writer
 * discipline release-store.ts applies to AgentReleasesTable.
 *
 * The pointer move and its append-only history row are written ATOMICALLY
 * in one TransactWriteItems: either both land or neither does. This makes
 * the history table a gap-free record of every move (invariant I3) — a
 * refusal or race can never leave a pointer moved without its history row
 * (or vice versa).
 *
 * The pointer Put's single ConditionExpression `attribute_not_exists(orgId)
 * OR #version = :expectedVersion` covers both cases with one write path:
 *  - First-ever promotion (expectedVersion === null): the row must not
 *    exist yet, mirroring release-store.ts's create-only idempotency
 *    guard structurally, though this table is mutable thereafter.
 *  - Every subsequent move: the row's current `version` must equal what
 *    the caller last read. A stale caller's transaction is rejected by
 *    DynamoDB with TransactionCanceledException (CancellationReasons
 *    carrying ConditionalCheckFailed for the pointer item), surfaced as
 *    ConcurrentPromotionError, BEFORE any data is written — this is the
 *    write-boundary enforcement the optimistic lock exists for. Because
 *    the two Puts share one transaction, the loser's history row never
 *    lands either.
 *
 * The history row carries no ConditionExpression: its SK includes the
 * monotonic `version`, so a genuine retry cannot double-append (the
 * pointer item's version condition fails first and cancels the whole
 * transaction).
 */
export async function setEnvironmentReleasePointer(
  params: SetEnvironmentReleasePointerParams,
): Promise<EnvironmentReleasePointer> {
  const nextVersion = (params.expectedVersion ?? 0) + 1;
  const promotedAt = new Date().toISOString();
  const previousReleaseId = params.currentReleaseId ?? null;
  const transitionType: PointerTransitionType =
    params.transitionType ?? "PROMOTE";

  const pointer: EnvironmentReleasePointer = {
    orgId: params.orgId,
    agentTargetId: params.agentTargetId,
    environment: params.environment,
    releaseId: params.releaseId,
    previousReleaseId,
    promotedAt,
    promotedBy: params.promotedBy,
    version: nextVersion,
    transitionType,
  };
  // Only attach the `canary` attribute when a canary state is actually
  // present — a null/undefined canary writes NO attribute (DynamoDB
  // document client rejects undefined), so the resulting row is
  // byte-identical to a pre-canary pointer and every existing reader
  // resolves it as 100% stable.
  if (params.canary) {
    pointer.canary = params.canary;
  }

  const historyEntry: EnvironmentReleasePointerHistoryEntry = { ...pointer };
  // SK: `${agentTargetId}#${environment}#${promotedAt}#${version}` — the
  // prefix is shared with the reader (historySortKeyPrefix) so the two
  // halves cannot drift; version disambiguates equal-ms timestamps.
  const historySortKey = `${historySortKeyPrefix(
    params.agentTargetId,
    params.environment,
  )}${promotedAt}#${nextVersion}`;

  try {
    const conditionExpression =
      params.expectedVersion === null
        ? "attribute_not_exists(orgId)"
        : "attribute_not_exists(orgId) OR #version = :expectedVersion";
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(),
              Item: {
                ...pointer,
                agentTargetId_environment: sortKey(
                  params.agentTargetId,
                  params.environment,
                ),
                // D8 sparse ActiveCanaryIndex marker — written ONLY when a
                // canary is present. A canary-clearing write (promote/abort)
                // overwrites the item without these attrs, dropping it from
                // the index in the same atomic Put.
                ...(params.canary
                  ? {
                      [ACTIVE_CANARY_PK_ATTR]: ACTIVE_CANARY_PK,
                      [ACTIVE_CANARY_SK_ATTR]: `${params.orgId}#${sortKey(
                        params.agentTargetId,
                        params.environment,
                      )}`,
                    }
                  : {}),
              },
              ConditionExpression: conditionExpression,
              ExpressionAttributeNames:
                params.expectedVersion === null
                  ? undefined
                  : { "#version": "version" },
              ExpressionAttributeValues:
                params.expectedVersion === null
                  ? undefined
                  : { ":expectedVersion": params.expectedVersion },
            },
          },
          {
            Put: {
              TableName: historyTableName(),
              Item: {
                ...historyEntry,
                historySortKey,
              },
            },
          },
        ],
      }),
    );
    return pointer;
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      throw new ConcurrentPromotionError(
        params.orgId,
        params.agentTargetId,
        params.environment,
      );
    }
    throw err;
  }
}

/**
 * Enumerate every pointer that currently carries a canary, via the sparse
 * ActiveCanaryIndex GSI (decision D8). NEVER a Scan — the constant PK
 * partition holds only the handful of active canaries. Paginated for
 * safety though the working set is tiny. The GSI projects ALL attributes,
 * so each returned row is a full EnvironmentReleasePointer (version,
 * releaseId, canary) the evaluator can act on without a second read.
 */
export async function queryActiveCanaries(): Promise<
  EnvironmentReleasePointer[]
> {
  const rows: EnvironmentReleasePointer[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: ACTIVE_CANARY_GSI,
        KeyConditionExpression: `${ACTIVE_CANARY_PK_ATTR} = :pk`,
        ExpressionAttributeValues: { ":pk": ACTIVE_CANARY_PK },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    rows.push(
      ...((res.Items as EnvironmentReleasePointer[] | undefined) ?? []),
    );
    exclusiveStartKey = res.LastEvaluatedKey as
      Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return rows;
}

export interface PerformAutoAbortCanaryParams {
  orgId: string;
  agentTargetId: string;
  environment: EnvironmentLiteral;
  /** The current stable releaseId — UNCHANGED by the abort (the candidate
   * arm is zeroed, stable stays put, so the move can never cross the
   * floor). */
  releaseId: string;
  /** The pointer version the evaluator last read — enforced via the
   * store's version ConditionExpression, which is what makes the rollback
   * exactly-once under concurrent evaluators (the loser gets
   * ConcurrentPromotionError). */
  expectedVersion: number;
}

/**
 * D5 shared STORE-path helper the auto-rollback evaluator calls DIRECTLY
 * (it must NOT go through the resolver — the gate/authz stay resolver-side;
 * the auto-actor's authority is bounded to this single zeroing primitive).
 *
 * SECURITY (must-fix): `promotedBy` and `transitionType` are MINTED HERE,
 * server-side, and are NEVER read from the caller. The floor derivation
 * (rollback-floor.ts) keys on human-vs-system via transitionType, so a
 * caller-supplied principal or transition would be a floor-spoofing
 * vector. Only the safe LOCATING fields (org/agent/env/releaseId/version)
 * are taken from `params`; even a caller that casts a wider object with
 * `promotedBy`/`transitionType` set cannot influence what is persisted,
 * because those two fields are assigned from the module constant /
 * literal here, after — and independent of — anything in `params`.
 *
 * This mints AUTO_ABORT_CANARY (decision D4 — the only auto action in v1):
 * canary is cleared, `releaseId` stays the current stable, so the pointer
 * cannot move below the last human-promoted baseline.
 */
export async function performAutoAbortCanary(
  params: PerformAutoAbortCanaryParams,
): Promise<EnvironmentReleasePointer> {
  return setEnvironmentReleasePointer({
    orgId: params.orgId,
    agentTargetId: params.agentTargetId,
    environment: params.environment,
    releaseId: params.releaseId, // stable unchanged — cannot cross the floor
    expectedVersion: params.expectedVersion,
    currentReleaseId: params.releaseId,
    promotedBy: RELEASE_ROLLBACK_SYSTEM_ACTOR, // minted, never from caller
    canary: null, // zero the candidate
    transitionType: "AUTO_ABORT_CANARY", // minted, never from caller
  });
}
