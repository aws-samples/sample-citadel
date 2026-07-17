/**
 * Seed Blueprints — CloudFormation Custom Resource Lambda
 *
 * Loads the seed blueprint definitions into the workflows table on deployment.
 * Follows the existing seed-organizations pattern.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4
 */

import * as https from 'https';
import * as url from 'url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  Context,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE!;

/**
 * Monotonic seed-content version stamped on every seeded row as
 * `seedVersion`. Bump it whenever the seeded blueprint content changes shape
 * so existing SYSTEM seed rows are healed on the next deploy (user rows are
 * never touched — see the ConditionExpression in the handler). Version 2
 * introduced the full canvas-shape WorkflowDefinition envelope; rows seeded
 * before v2 lack the `seedVersion` attribute entirely and are healed exactly
 * once.
 */
export const SEED_VERSION = 2;

/** Deterministic ID from blueprint name so re-deploys don't create duplicates. */
export function deterministicId(name: string): string {
  const hash = createHash('sha256')
    .update(`citadel-seed-blueprint:${name}`)
    .digest('hex');
  // Format as UUID-like: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

interface SeedBlueprintNode {
  id: string;
  agentId: string;
  position: { x: number; y: number };
  configuration: Record<string, unknown>;
}

interface SeedBlueprintEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  condition?: { field: string; operator: string; value: unknown };
}

interface SeedBlueprintDefinition {
  nodes: SeedBlueprintNode[];
  edges: SeedBlueprintEdge[];
}

interface SeedBlueprint {
  name: string;
  description: string;
  category: string;
  definition: SeedBlueprintDefinition;
  metadata: { category: string; isSystem: boolean; tags: string[] };
}

/**
 * Full canvas-shape WorkflowDefinition envelope persisted in the `definition`
 * column. Mirrors the WorkflowDefinition interface in
 * frontend/src/types/workflow.ts so seeded rows load directly on the canvas.
 * The envelope is additive — node/edge shapes are unchanged.
 */
interface SeedWorkflowDefinitionEnvelope extends SeedBlueprintDefinition {
  version: string;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
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
 * Build the DynamoDB item for a seed blueprint. Kept separate from the
 * declarative SEED_BLUEPRINTS const so the definitions stay data-only while
 * the envelope (version/id/name/createdAt/updatedAt) is computed here.
 * Exported for the contract test in
 * backend/src/lambda/__tests__/seed-blueprints-contract.test.ts.
 */
export function buildSeedBlueprintItem(blueprint: SeedBlueprint, now: string): SeedBlueprintItem {
  const workflowId = deterministicId(blueprint.name);
  const definition: SeedWorkflowDefinitionEnvelope = {
    version: '1.0.0',
    id: workflowId,
    name: blueprint.name,
    createdAt: now,
    updatedAt: now,
    nodes: blueprint.definition.nodes,
    edges: blueprint.definition.edges,
  };
  return {
    workflowId,
    orgId: 'system',
    name: blueprint.name,
    description: blueprint.description,
    status: 'PUBLISHED',
    isBlueprint: 'true',
    definition: JSON.stringify(definition),
    configuration: null,
    version: 1,
    versionHistory: [],
    appId: null,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
    metadata: JSON.stringify(blueprint.metadata),
    seedVersion: SEED_VERSION,
  };
}

export const SEED_BLUEPRINTS: SeedBlueprint[] = [
  // 1. Sequential Agent Pipeline — 3 nodes in series
  {
    name: 'Sequential Agent Pipeline',
    description: '[Template] Three agents executing in sequence — each passes output to the next. Clone and re-map agent IDs before publishing.',
    category: 'pipeline',
    definition: {
      nodes: [
        { id: 'node-1', agentId: 'placeholder-agent-1', position: { x: 100, y: 200 }, configuration: {} },
        { id: 'node-2', agentId: 'placeholder-agent-2', position: { x: 400, y: 200 }, configuration: {} },
        { id: 'node-3', agentId: 'placeholder-agent-3', position: { x: 700, y: 200 }, configuration: {} },
      ],
      edges: [
        { id: 'edge-1-2', source: 'node-1', target: 'node-2', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-2-3', source: 'node-2', target: 'node-3', sourceHandle: 'output', targetHandle: 'input' },
      ],
    },
    metadata: { category: 'pipeline', isSystem: true, tags: ['sequential', 'basic'] },
  },

  // 2. Parallel Fan-Out — 1 root → 3 parallel → 1 convergence (5 nodes, 6 edges)
  {
    name: 'Parallel Fan-Out',
    description: '[Template] One root agent fans out to three parallel agents, then converges to a single aggregator. Clone and re-map agent IDs before publishing.',
    category: 'parallel',
    definition: {
      nodes: [
        { id: 'root', agentId: 'placeholder-root', position: { x: 400, y: 50 }, configuration: {} },
        { id: 'branch-a', agentId: 'placeholder-branch-a', position: { x: 100, y: 250 }, configuration: {} },
        { id: 'branch-b', agentId: 'placeholder-branch-b', position: { x: 400, y: 250 }, configuration: {} },
        { id: 'branch-c', agentId: 'placeholder-branch-c', position: { x: 700, y: 250 }, configuration: {} },
        { id: 'aggregator', agentId: 'placeholder-aggregator', position: { x: 400, y: 450 }, configuration: {} },
      ],
      edges: [
        { id: 'edge-root-a', source: 'root', target: 'branch-a', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-root-b', source: 'root', target: 'branch-b', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-root-c', source: 'root', target: 'branch-c', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-a-agg', source: 'branch-a', target: 'aggregator', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-b-agg', source: 'branch-b', target: 'aggregator', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-c-agg', source: 'branch-c', target: 'aggregator', sourceHandle: 'output', targetHandle: 'input' },
      ],
    },
    metadata: { category: 'parallel', isSystem: true, tags: ['parallel', 'fan-out', 'convergence'] },
  },

  // 3. Conditional Router — 1 root → 2 conditional branches → 1 convergence (4 nodes, 4 edges)
  {
    name: 'Conditional Router',
    description: '[Template] One root agent routes to two conditional branches based on output, then converges. Clone and re-map agent IDs before publishing.',
    category: 'conditional',
    definition: {
      nodes: [
        { id: 'router', agentId: 'placeholder-router', position: { x: 400, y: 50 }, configuration: {} },
        { id: 'branch-true', agentId: 'placeholder-true-handler', position: { x: 200, y: 250 }, configuration: {} },
        { id: 'branch-false', agentId: 'placeholder-false-handler', position: { x: 600, y: 250 }, configuration: {} },
        { id: 'merger', agentId: 'placeholder-merger', position: { x: 400, y: 450 }, configuration: {} },
      ],
      edges: [
        { id: 'edge-router-true', source: 'router', target: 'branch-true', sourceHandle: 'output', targetHandle: 'input', condition: { field: 'result.route', operator: 'equals', value: 'branch-a' } },
        { id: 'edge-router-false', source: 'router', target: 'branch-false', sourceHandle: 'output', targetHandle: 'input', condition: { field: 'result.route', operator: 'equals', value: 'branch-b' } },
        { id: 'edge-true-merger', source: 'branch-true', target: 'merger', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-false-merger', source: 'branch-false', target: 'merger', sourceHandle: 'output', targetHandle: 'input' },
      ],
    },
    metadata: { category: 'conditional', isSystem: true, tags: ['conditional', 'routing', 'branching'] },
  },

  // 4. Data Processing Pipeline — ingest → transform → validate → store (4 nodes, 3 edges)
  {
    name: 'Data Processing Pipeline',
    description: '[Template] Ingest → Transform → Validate → Store pipeline for data processing workflows. Clone and re-map agent IDs before publishing.',
    category: 'data-processing',
    definition: {
      nodes: [
        { id: 'ingest', agentId: 'placeholder-ingest', position: { x: 100, y: 200 }, configuration: {} },
        { id: 'transform', agentId: 'placeholder-transform', position: { x: 350, y: 200 }, configuration: {} },
        { id: 'validate', agentId: 'placeholder-validate', position: { x: 600, y: 200 }, configuration: {} },
        { id: 'store', agentId: 'placeholder-store', position: { x: 850, y: 200 }, configuration: {} },
      ],
      edges: [
        { id: 'edge-ingest-transform', source: 'ingest', target: 'transform', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-transform-validate', source: 'transform', target: 'validate', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-validate-store', source: 'validate', target: 'store', sourceHandle: 'output', targetHandle: 'input' },
      ],
    },
    metadata: { category: 'data-processing', isSystem: true, tags: ['data', 'etl', 'pipeline'] },
  },

  // 5. Echo Demo — the one runnable, publishable seed workflow. Unlike the
  //    template blueprints above (which carry placeholder agentIds and are
  //    rejected by publish validation until cloned/re-mapped), this references
  //    a REAL seeded, active agent ('demo-echo-agent') and forms a minimal
  //    connected acyclic DAG, so it passes validateDefinition and can execute
  //    end to end.
  {
    name: 'Echo Demo Workflow',
    description: 'Runnable demo: two echo steps that each return their input. References a real seeded agent, so it passes publish validation and executes end to end.',
    category: 'demo',
    definition: {
      nodes: [
        { id: 'echo-1', agentId: 'demo-echo-agent', position: { x: 150, y: 200 }, configuration: {} },
        { id: 'echo-2', agentId: 'demo-echo-agent', position: { x: 450, y: 200 }, configuration: {} },
      ],
      edges: [
        { id: 'edge-echo-1-2', source: 'echo-1', target: 'echo-2', sourceHandle: 'output', targetHandle: 'input' },
      ],
    },
    metadata: { category: 'demo', isSystem: true, tags: ['demo', 'echo', 'runnable'] },
  },
];


/** Send CloudFormation Custom Resource response. */
async function sendCfnResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: 'SUCCESS' | 'FAILED',
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
        method: 'PUT',
        headers: {
          'Content-Type': '',
          'Content-Length': responseBody.length,
        },
      },
      () => resolve(),
    );
    req.on('error', reject);
    req.write(responseBody);
    req.end();
  });
}

export const handler: CloudFormationCustomResourceHandler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));

  if (event.RequestType === 'Delete') {
    await sendCfnResponse(event, context, 'SUCCESS', { Message: 'Nothing to clean up' });
    return;
  }

  try {
    const now = new Date().toISOString();

    for (const blueprint of SEED_BLUEPRINTS) {
      const item = buildSeedBlueprintItem(blueprint, now);

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
              'attribute_not_exists(workflowId) OR attribute_not_exists(seedVersion) OR seedVersion < :v',
            ExpressionAttributeValues: { ':v': SEED_VERSION },
            ReturnValues: 'ALL_OLD',
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
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
          console.log(
            `⊘ Blueprint current (seedVersion >= ${SEED_VERSION}), skipping: ${blueprint.name}`,
          );
          continue;
        }
        throw err;
      }
    }

    await sendCfnResponse(event, context, 'SUCCESS', {
      Message: 'Blueprints seeded successfully',
      Count: SEED_BLUEPRINTS.length,
    });
  } catch (err: unknown) {
    console.error('Error seeding blueprints:', err);
    await sendCfnResponse(event, context, 'FAILED', { Message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};
