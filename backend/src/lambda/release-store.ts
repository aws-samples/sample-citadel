/**
 * release-store.ts — the SOLE write choke point for AgentReleasesTable.
 *
 * Immutability layer L1 (design §2): this is the ONLY module in the
 * codebase permitted to reference AgentReleasesTable or issue a raw
 * Put/Update/Delete command against it. It exports create (putRelease)
 * and read (getRelease) only — deliberately no update, no delete, not
 * even unused. A CI guard test
 * (release-store-choke-point.guard.test.ts) fails the build if any other
 * file references the table or those commands.
 *
 * Immutability layer L2: putRelease uses
 * ConditionExpression attribute_not_exists(releaseId). Because releaseId
 * IS the content hash of the constituents (release-hash.ts), re-putting
 * identical content always collides on the same key and is treated as an
 * idempotent no-op (the existing row is fetched and returned) rather than
 * an error; differing content hashes to a different key and is inserted
 * as a new, distinct row — an existing row can never be overwritten by
 * any Put through this module.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { computeReleaseHash } from "./utils/release-hash";
import type {
  AgentRelease,
  AgentReleaseConstituents,
  AgentReleaseInput,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function tableName(): string {
  return process.env.AGENT_RELEASES_TABLE!;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Create-only write. Computes releaseId from the constituents ONLY (pure,
 * order-independent hash) — volatile metadata that varies per call
 * (createdAt, and any other non-constituent field on AgentReleaseInput)
 * is deliberately excluded from the hash domain, so that re-cutting
 * identical constituents at a different wall-clock time still collides on
 * the same releaseId. Feeding the full input (including createdAt) into
 * the hash would defeat content-addressing: a real retry after a
 * transient failure mints a fresh createdAt and would otherwise produce a
 * distinct row instead of the idempotent no-op this store exists to
 * guarantee. Attempts a conditional Put keyed on that hash. If a row with
 * the same releaseId already exists (identical constituents), the Put is
 * rejected by DynamoDB and this function treats that as a no-op,
 * returning the already-stored release. Any other DynamoDB error
 * propagates.
 */
export async function putRelease(
  input: AgentReleaseInput,
): Promise<AgentRelease> {
  const constituents: AgentReleaseConstituents = {
    agentConfig: input.agentConfig,
    promptVersions: input.promptVersions,
    execSpecId: input.execSpecId,
    execSpecVersion: input.execSpecVersion,
    modelConfigSnapshots: input.modelConfigSnapshots,
    toolConfigs: input.toolConfigs,
    policySnapshot: input.policySnapshot,
    evalEvidence: input.evalEvidence,
  };
  const releaseId = computeReleaseHash(constituents);
  const release: AgentRelease = { ...input, releaseId };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName(),
        Item: release,
        ConditionExpression: "attribute_not_exists(releaseId)",
      }),
    );
    return release;
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      const existing = await getRelease(releaseId);
      if (existing) {
        return existing;
      }
    }
    throw err;
  }
}

/** Point read by releaseId. Returns null when the release does not exist. */
export async function getRelease(
  releaseId: string,
): Promise<AgentRelease | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: { releaseId } }),
  );
  return (res.Item as AgentRelease | undefined) ?? null;
}
