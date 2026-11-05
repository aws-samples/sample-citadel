/**
 * Seed Blueprints — CloudFormation Custom Resource Lambda
 *
 * Loads the seed blueprint definitions into the workflows table on deployment.
 * Follows the existing seed-organizations pattern.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4
 *
 * Data definitions (SEED_VERSION, SEED_BLUEPRINTS, SMOKE_BLUEPRINTS, types,
 * and the content fingerprint) live in ./definitions.ts — a data-only module
 * that is safe to import at CDK synth time (no AWS SDK instantiation).
 */

import * as https from "https";
import * as url from "url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  Context,
} from "aws-lambda";

// Re-export everything from definitions so existing consumers
// (reconcile-seeded-rows, contract tests, node-shape tests) that import
// from '../seed-blueprints' or '../seed-blueprints/index' continue to work.
export {
  SEED_VERSION,
  deterministicId,
  SEED_BLUEPRINTS,
  SMOKE_BLUEPRINTS,
  SEEDED_BLUEPRINT_IDS,
  computeSeedBlueprintFingerprint,
} from "./definitions";
export type {
  SeedBlueprint,
  SeedBlueprintNode,
  SeedBlueprintEdge,
  SeedBlueprintDefinition,
} from "./definitions";
import {
  SEED_VERSION,
  deterministicId,
  SEED_BLUEPRINTS,
  SMOKE_BLUEPRINTS,
} from "./definitions";
import type { SeedBlueprint } from "./definitions";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE!;

/**
 * Idempotency-seam smoke workflow gate — DIAGNOSTIC FIXTURE, non-prod only.
 *
 * CDK sets SMOKE_FIXTURES_ENABLED exclusively for non-production stacks
 * (see backend/lib/arbiter-stack.ts); a production deploy never sets it, so
 * this resolves false there and no smoke workflow row is ever written to a
 * production WORKFLOWS_TABLE. Read lazily (a function, not a module-load-time
 * constant) so it reflects the CURRENT process.env at handler-invocation
 * time — the real Lambda runtime never mutates env vars mid-lifetime, so
 * this is behaviorally identical there; it also lets tests flip the env var
 * between invocations within one Jest module instance without needing
 * `jest.resetModules()` (which would require a second DynamoDBDocumentClient
 * to be constructed, defeating aws-sdk-client-mock's single-instance mock).
 */
function smokeFixturesEnabled(): boolean {
  return process.env.SMOKE_FIXTURES_ENABLED === "true";
}

/**
 * Full canvas-shape WorkflowDefinition envelope persisted in the `definition`
 * column. Mirrors the WorkflowDefinition interface in
 * frontend/src/types/workflow.ts so seeded rows load directly on the canvas.
 * The envelope is additive — node/edge shapes are unchanged.
 */
interface SeedWorkflowDefinitionEnvelope {
  version: string;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: Array<{
    id: string;
    agentId: string;
    legacyAgentName?: string;
    position: { x: number; y: number };
    configuration: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
    condition?: { field: string; operator: string; value: unknown };
  }>;
}

/** DynamoDB row shape written for each seeded blueprint. */
export interface SeedBlueprintItem {
  workflowId: string;
  orgId: string;
  name: string;
  description: string;
  status: string;
  isBlueprint: string;
  definition: string;
  configuration: null;
  version: number;
  versionHistory: never[];
  appId: null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metadata: string;
  seedVersion: number;
}

/**
 * Resolve agent friendly names to registry recordIds by reading the agent
 * config table. First tries a GetItem on the name (thin pointer row carries
 * `_canonicalRecordId`); if no pointer exists or the table is unavailable,
 * falls back to a full scan looking for recordId-keyed rows with a matching
 * `name` attribute.
 *
 * Returns a Map<agentName, recordId>. Names that cannot be resolved are
 * omitted (blueprints will keep the friendly name — existing behavior).
 */
export async function resolveAgentRecordIds(
  agentNames: string[],
  ddbDocClient: DynamoDBDocumentClient,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  // Read lazily so tests can set the env var after module import.
  const agentConfigTable = process.env.AGENT_CONFIG_TABLE;
  if (!agentConfigTable) {
    console.log(
      "AGENT_CONFIG_TABLE not set — skipping agent recordId resolution",
    );
    return resolved;
  }

  const uniqueNames = [...new Set(agentNames)];
  for (const name of uniqueNames) {
    // Attempt 1: GetItem by name — the thin pointer row carries _canonicalRecordId.
    try {
      const resp = await ddbDocClient.send(
        new GetCommand({
          TableName: agentConfigTable,
          Key: { agentId: name },
          ProjectionExpression: "#crid, registryRecordId",
          ExpressionAttributeNames: { "#crid": "_canonicalRecordId" },
        }),
      );
      const canonId =
        (resp.Item?._canonicalRecordId as string) ??
        (resp.Item?.registryRecordId as string);
      if (canonId && canonId !== name) {
        resolved.set(name, canonId);
        continue;
      }
    } catch (err) {
      console.log(
        `GetItem for agent name "${name}" failed: ${String(err)} — trying scan fallback`,
      );
    }

    // Attempt 2: Scan for a recordId-keyed row with `name` attribute matching.
    try {
      const scan = await ddbDocClient.send(
        new ScanCommand({
          TableName: agentConfigTable,
          FilterExpression: "#n = :name AND attribute_exists(#ck)",
          ExpressionAttributeNames: { "#n": "name", "#ck": "citadelKind" },
          ExpressionAttributeValues: { ":name": name },
          ProjectionExpression: "agentId",
        }),
      );
      const match = scan.Items?.[0];
      if (match?.agentId && String(match.agentId) !== name) {
        resolved.set(name, String(match.agentId));
      }
    } catch (err) {
      console.log(
        `Scan fallback for agent "${name}" failed: ${String(err)} — blueprint will keep friendly name`,
      );
    }
  }

  return resolved;
}

/**
 * Build the DynamoDB item for a seed blueprint. Kept separate from the
 * declarative SEED_BLUEPRINTS const so the definitions stay data-only while
 * the envelope (version/id/name/createdAt/updatedAt) is computed here.
 *
 * When `agentRecordIds` is provided, node `agentId` values that match a
 * known agent name are replaced with the corresponding registry recordId,
 * and a `legacyAgentName` attribute preserving the original name is added.
 *
 * Exported for the contract test in
 * backend/src/lambda/__tests__/seed-blueprints-contract.test.ts.
 */
export function buildSeedBlueprintItem(
  blueprint: SeedBlueprint,
  now: string,
  agentRecordIds?: Map<string, string>,
): SeedBlueprintItem {
  const workflowId = deterministicId(blueprint.name);
  // Rewrite node agentIds from friendly names to recordIds where resolved.
  const resolvedNodes = blueprint.definition.nodes.map((node) => {
    const recordId = agentRecordIds?.get(node.agentId);
    if (recordId) {
      return { ...node, agentId: recordId, legacyAgentName: node.agentId };
    }
    return node;
  });
  const definition: SeedWorkflowDefinitionEnvelope = {
    version: "1.0.0",
    id: workflowId,
    name: blueprint.name,
    createdAt: now,
    updatedAt: now,
    nodes: resolvedNodes,
    edges: blueprint.definition.edges,
  };
  return {
    workflowId,
    orgId: "system",
    name: blueprint.name,
    description: blueprint.description,
    status: "PUBLISHED",
    isBlueprint: "true",
    definition: JSON.stringify(definition),
    configuration: null,
    version: 1,
    versionHistory: [],
    appId: null,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    metadata: JSON.stringify(blueprint.metadata),
    seedVersion: SEED_VERSION,
  };
}

/** Send CloudFormation Custom Resource response. */
async function sendCfnResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: "SUCCESS" | "FAILED",
  data: Record<string, unknown>,
): Promise<void> {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const parsedUrl = url.parse(event.ResponseURL);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: "PUT",
        headers: {
          "Content-Type": "",
          "Content-Length": responseBody.length,
        },
      },
      () => resolve(),
    );
    req.on("error", reject);
    req.write(responseBody);
    req.end();
  });
}

export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context,
) => {
  console.log("Event:", JSON.stringify(event));

  if (event.RequestType === "Delete") {
    await sendCfnResponse(event, context, "SUCCESS", {
      Message: "Nothing to clean up",
    });
    return;
  }

  try {
    const now = new Date().toISOString();
    // Smoke fixtures are appended ONLY when smokeFixturesEnabled() is true
    // (non-prod stacks only, see the function's doc comment above). In
    // production this is a plain SEED_BLUEPRINTS iteration, byte-identical
    // to pre-smoke-fixture behavior.
    const blueprintsToSeed = smokeFixturesEnabled()
      ? [...SEED_BLUEPRINTS, ...SMOKE_BLUEPRINTS]
      : SEED_BLUEPRINTS;

    // Collect all real (non-placeholder) agent names referenced in blueprints
    // and resolve them to registry recordIds via the agent config table.
    const realAgentNames = blueprintsToSeed
      .flatMap((bp) => bp.definition.nodes.map((n) => n.agentId))
      .filter((id) => !id.startsWith("placeholder-"));
    const agentRecordIds = await resolveAgentRecordIds(
      realAgentNames,
      docClient,
    );
    if (agentRecordIds.size > 0) {
      console.log(
        `Resolved ${agentRecordIds.size} agent name(s) to recordId(s):`,
        Object.fromEntries(agentRecordIds),
      );
    }

    for (const blueprint of blueprintsToSeed) {
      const item = buildSeedBlueprintItem(blueprint, now, agentRecordIds);

      try {
        // Upsert semantics: create when absent, overwrite SYSTEM seed rows
        // that predate the current SEED_VERSION (rows seeded before the
        // envelope change lack `seedVersion` entirely and are healed exactly
        // once), and never touch rows that are already current. User-created
        // workflows are never seeded here, so their rows are never matched
        // by a seed workflowId and remain untouched.
        const result = await docClient.send(
          new PutCommand({
            TableName: WORKFLOWS_TABLE,
            Item: item,
            ConditionExpression:
              "attribute_not_exists(workflowId) OR attribute_not_exists(seedVersion) OR seedVersion < :v",
            ExpressionAttributeValues: { ":v": SEED_VERSION },
            ReturnValues: "ALL_OLD",
          }),
        );
        if (result.Attributes) {
          console.log(
            `↻ Updated outdated seed blueprint (seedVersion → ${SEED_VERSION}): ${blueprint.name}`,
          );
        } else {
          console.log(`✓ Created blueprint: ${blueprint.name}`);
        }
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ConditionalCheckFailedException"
        ) {
          console.log(
            `⊘ Blueprint current (seedVersion >= ${SEED_VERSION}), skipping: ${blueprint.name}`,
          );
          continue;
        }
        throw err;
      }
    }

    await sendCfnResponse(event, context, "SUCCESS", {
      Message: "Blueprints seeded successfully",
      Count: blueprintsToSeed.length,
    });
  } catch (err: unknown) {
    console.error("Error seeding blueprints:", err);
    await sendCfnResponse(event, context, "FAILED", {
      Message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
