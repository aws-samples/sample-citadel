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
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EnvironmentLiteral, EnvironmentReleasePointer } from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function tableName(): string {
  return process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE!;
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
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
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
}

/**
 * Create-or-move write for the (orgId, agentTargetId, environment)
 * pointer. This is the ONLY function in the codebase permitted to issue a
 * write against EnvironmentReleasePointersTable.
 *
 * The single ConditionExpression `attribute_not_exists(orgId) OR
 * #version = :expectedVersion` covers both cases with one write path:
 *  - First-ever promotion (expectedVersion === null): the row must not
 *    exist yet, mirroring release-store.ts's create-only idempotency
 *    guard structurally, though this table is mutable thereafter.
 *  - Every subsequent move: the row's current `version` must equal what
 *    the caller last read. A stale caller's Put is rejected by DynamoDB
 *    with ConditionalCheckFailedException, surfaced as
 *    ConcurrentPromotionError, BEFORE any data is overwritten — this is
 *    the write-boundary enforcement the optimistic lock exists for, not
 *    a read-then-compare done in this function's own logic.
 */
export async function setEnvironmentReleasePointer(
  params: SetEnvironmentReleasePointerParams,
): Promise<EnvironmentReleasePointer> {
  const nextVersion = (params.expectedVersion ?? 0) + 1;
  const promotedAt = new Date().toISOString();
  const previousReleaseId = params.currentReleaseId ?? null;

  const pointer: EnvironmentReleasePointer = {
    orgId: params.orgId,
    agentTargetId: params.agentTargetId,
    environment: params.environment,
    releaseId: params.releaseId,
    previousReleaseId,
    promotedAt,
    promotedBy: params.promotedBy,
    version: nextVersion,
  };

  try {
    const conditionExpression =
      params.expectedVersion === null
        ? "attribute_not_exists(orgId)"
        : "attribute_not_exists(orgId) OR #version = :expectedVersion";
    await docClient.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          ...pointer,
          agentTargetId_environment: sortKey(
            params.agentTargetId,
            params.environment,
          ),
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
