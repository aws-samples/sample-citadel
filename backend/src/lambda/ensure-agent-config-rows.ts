/**
 * Self-healing AGENT_CONFIG_TABLE materializer for the intake orchestration
 * path (dual-store gap).
 *
 * The fabricator persists fabricated agents to the AgentCore Registry ONLY,
 * while workflow-resolver's verifyAgentsExist gate BatchGets the DynamoDB
 * agents cache table (AGENT_CONFIG_TABLE). Registry-only agents therefore
 * fail every publish/import with a permanent AGENTS_SYNCING — and
 * registry-sync.ts cannot backfill a missing row from a STATUS_CHANGED event
 * (its update is conditioned on attribute_exists).
 *
 * ensureAgentConfigRows closes the gap at the moment of need: for every
 * referenced registry recordId with no agents-table row it synthesizes the
 * row from the live registry record using the SAME mapping registry-sync.ts
 * applies to registry events (buildAgentCacheRecord for the row shape,
 * toInternalState for the status→state derivation) and creates it with a
 * creation-only conditional Put. Existing rows are NEVER touched, so richer
 * rows written by registry-sync/seedConfig/resolvers stay authoritative.
 *
 * Best-effort by design: this helper never throws. A row that cannot be
 * healed simply leaves the existing verifyAgentsExist failure mode in place.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildAgentCacheRecord, toInternalState } from './registry-sync';
import { getRegistryService } from './agent-config-resolver';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Read at call time — module-load env may not be set under test. */
function agentConfigTable(): string {
  return process.env.AGENT_CONFIG_TABLE ?? '';
}

export interface EnsureAgentConfigRowsResult {
  /** Rows this call created. */
  ensured: string[];
  /** Rows that already existed (including concurrent-create races). */
  existing: string[];
  /** Ids that could not be healed (no registry record, or write failure). */
  failed: string[];
}

/**
 * Extracts the unique, non-empty node agentIds from a workflow definition
 * JSON string. Malformed definitions yield [] — the definition validator
 * owns rejecting those.
 */
export function extractAgentIdsFromDefinition(definitionJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definitionJson);
  } catch {
    return [];
  }
  const nodes = (parsed as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }
  const ids: string[] = [];
  for (const node of nodes) {
    const agentId = (node as { agentId?: unknown })?.agentId;
    if (typeof agentId === 'string' && agentId.length > 0 && !ids.includes(agentId)) {
      ids.push(agentId);
    }
  }
  return ids;
}

/** BatchGet the agents table for the ids that already have a row. */
async function findExistingRows(agentIds: string[]): Promise<Set<string>> {
  const tableName = agentConfigTable();
  const existing = new Set<string>();
  for (let i = 0; i < agentIds.length; i += 100) {
    const chunk = agentIds.slice(i, i + 100);
    const result = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: chunk.map((agentId) => ({ agentId })),
            ProjectionExpression: 'agentId',
          },
        },
      }),
    );
    for (const item of result.Responses?.[tableName] ?? []) {
      if (item && typeof item.agentId === 'string') {
        existing.add(item.agentId);
      }
    }
  }
  return existing;
}

/**
 * Ensures an AGENT_CONFIG_TABLE row exists for every given registry
 * recordId. Missing rows are synthesized from the live registry record via
 * the registry-sync mapping; `state` derives from the record STATUS (via
 * toInternalState — active only when the status warrants), never from the
 * metadata's self-declared state. Never throws.
 */
export async function ensureAgentConfigRows(
  agentIds: string[],
): Promise<EnsureAgentConfigRowsResult> {
  const result: EnsureAgentConfigRowsResult = { ensured: [], existing: [], failed: [] };
  const ids = Array.from(new Set(agentIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (ids.length === 0) {
    return result;
  }

  let existing: Set<string>;
  try {
    existing = await findExistingRows(ids);
  } catch (err) {
    // Can't even read the table — leave healing to the next attempt.
    console.error('ensureAgentConfigRows: BatchGet failed:', err);
    result.failed.push(...ids);
    return result;
  }

  const registryService = getRegistryService();

  for (const agentId of ids) {
    if (existing.has(agentId)) {
      result.existing.push(agentId);
      continue;
    }
    try {
      const record = await registryService.getResource('agent', agentId);
      if (!record) {
        console.warn(`ensureAgentConfigRows: no registry record for "${agentId}"`);
        result.failed.push(agentId);
        continue;
      }
      // SAME row shape registry-sync writes for CREATED/UPDATED events…
      const item = buildAgentCacheRecord(agentId, {
        description: record.description,
        customDescriptorContent: record.customDescriptorContent ?? null,
        createdAt: record.createdAt ? record.createdAt.toISOString() : undefined,
        updatedAt: record.updatedAt ? record.updatedAt.toISOString() : undefined,
      });
      // …with state derived from the record's CURRENT status (the same
      // mapping registry-sync applies on STATUS_CHANGED), not the
      // metadata's self-declared state.
      item.state = toInternalState(record.status);

      await docClient.send(
        new PutCommand({
          TableName: agentConfigTable(),
          Item: item,
          // Creation-only: never clobber a row registry-sync or a resolver
          // already owns.
          ConditionExpression: 'attribute_not_exists(agentId)',
        }),
      );
      result.ensured.push(agentId);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        // Concurrent creation — the row exists now, which is all we need.
        result.existing.push(agentId);
        continue;
      }
      console.error(`ensureAgentConfigRows: failed to heal "${agentId}":`, err);
      result.failed.push(agentId);
    }
  }

  if (result.ensured.length > 0 || result.failed.length > 0) {
    console.log(
      JSON.stringify({
        helper: 'ensureAgentConfigRows',
        ensured: result.ensured,
        existing: result.existing.length,
        failed: result.failed,
      }),
    );
  }
  return result;
}
