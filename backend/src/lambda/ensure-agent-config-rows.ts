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
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  buildAgentCacheRecord,
  toInternalState,
  type AgentCacheRecord,
} from "./registry-sync";
import { getRegistryService } from "./agent-config-resolver";
import { resolveKind } from "../utils/citadel-kind";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Read at call time — module-load env may not be set under test. */
function agentConfigTable(): string {
  return process.env.AGENT_CONFIG_TABLE ?? "";
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
export function extractAgentIdsFromDefinition(
  definitionJson: string,
): string[] {
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
    if (
      typeof agentId === "string" &&
      agentId.length > 0 &&
      !ids.includes(agentId)
    ) {
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
            ProjectionExpression: "agentId",
          },
        },
      }),
    );
    for (const item of result.Responses?.[tableName] ?? []) {
      if (item && typeof item.agentId === "string") {
        existing.add(item.agentId);
      }
    }
  }
  return existing;
}

/** Row shape this writer creates: the shared cache row plus a config flag. */
type EnsuredAgentRow = AgentCacheRecord & { configStatus?: "incomplete" };

function isNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSchemaContent(schema: unknown): boolean {
  if (typeof schema === "string") return schema.trim().length > 0;
  return (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    Object.keys(schema).length > 0
  );
}

/**
 * Names the parts of a projected agent config the supervisor needs to build a
 * tool (name, description, a non-empty schema) that are missing or blank.
 * Empty when the config is complete.
 */
function missingConfigParts(config: unknown): string[] {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return ["config"];
  }
  const fields = config as Record<string, unknown>;
  const missing: string[] = [];
  if (!isNonBlankString(fields.name)) missing.push("name");
  if (!isNonBlankString(fields.description)) missing.push("description");
  if (!hasSchemaContent(fields.schema)) missing.push("schema");
  return missing;
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
  const result: EnsureAgentConfigRowsResult = {
    ensured: [],
    existing: [],
    failed: [],
  };
  const ids = Array.from(
    new Set(agentIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) {
    return result;
  }

  let existing: Set<string>;
  try {
    existing = await findExistingRows(ids);
  } catch (err) {
    // Can't even read the table — leave healing to the next attempt.
    console.error("ensureAgentConfigRows: BatchGet failed:", err);
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
      const record = await registryService.getResource("agent", agentId);
      if (!record) {
        console.warn(
          `ensureAgentConfigRows: no registry record for "${agentId}"`,
        );
        result.failed.push(agentId);
        continue;
      }
      // Kind guard: only agent records should be materialised as agent
      // cache rows. App/tool records are skipped with a WARN.
      const kind = resolveKind(record);
      if (kind !== "agent") {
        console.warn(`ensureAgentConfigRows: skipping non-agent record`, {
          agentId,
          kind,
        });
        result.failed.push(agentId);
        continue;
      }
      // SAME row shape registry-sync writes for CREATED/UPDATED events…
      const item: EnsuredAgentRow = buildAgentCacheRecord(agentId, {
        description: record.description,
        customDescriptorContent: record.customDescriptorContent ?? null,
        createdAt: record.createdAt
          ? record.createdAt.toISOString()
          : undefined,
        updatedAt: record.updatedAt
          ? record.updatedAt.toISOString()
          : undefined,
      });
      // …with state derived from the record's CURRENT status (the same
      // mapping registry-sync applies on STATUS_CHANGED), not the
      // metadata's self-declared state.
      item.state = toInternalState(record.status);
      // Denormalize the same three approval-gate fields registry-sync
      // writes, from this SAME live record already in hand. record.status
      // is a required string on RegistryRecord, so this path always has a
      // status source and always sets registryStatus (never leaves it
      // UNSET) — unlike registry-sync's legacy buildAgentCacheRecord path,
      // which may have no status signal at all.
      item.registryStatus = record.status;
      item.registryRecordId = record.recordId;
      item.statusUpdatedAt = new Date().toISOString();

      // A row the supervisor cannot build a tool from must not be active:
      // the approval status says "approved", but dispatch would skip it.
      // Project it inactive and flag it so the gap is visible and the row
      // can be repaired; the activator only flips rows that exist, so it
      // stays unchanged.
      const missing = missingConfigParts(item.config);
      if (missing.length > 0) {
        item.state = "inactive";
        item.configStatus = "incomplete";
        console.warn(
          `ensureAgentConfigRows: incomplete agent config for "${agentId}", projecting inactive`,
          { agentId, registryStatus: record.status, missing },
        );
      }

      await docClient.send(
        new PutCommand({
          TableName: agentConfigTable(),
          Item: item,
          // Creation-only: never clobber a row registry-sync or a resolver
          // already owns.
          ConditionExpression: "attribute_not_exists(agentId)",
        }),
      );
      result.ensured.push(agentId);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.name === "ConditionalCheckFailedException"
      ) {
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
        helper: "ensureAgentConfigRows",
        ensured: result.ensured,
        existing: result.existing.length,
        failed: result.failed,
      }),
    );
  }
  return result;
}
