/**
 * Seed blueprint contract tests — envelope shape + seedVersion-aware upsert.
 *
 * Part A asserts that every SEED_BLUEPRINTS entry builds into a full
 * canvas-shape WorkflowDefinition envelope the frontend canvas can load
 * directly (seeded rows historically stored bare {nodes, edges} and were
 * rejected by the frontend guard with INVALID_WORKFLOW_STRUCTURE).
 *
 * Part B asserts the DynamoDB upsert semantics: system seed rows are
 * overwritten when outdated (missing seedVersion or seedVersion < current)
 * but never when current, and user rows are never touched.
 *
 * KEEP IN SYNC: the envelope guard below mirrors isWorkflowDefinition (and
 * its isWorkflowNodeDefinition / isWorkflowEdgeDefinition sub-guards) in
 * frontend/src/types/workflow.ts field-for-field. The frontend guard carries
 * the reciprocal cross-reference comment — if either side changes shape,
 * update both in the same review.
 */

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';

// Mock the https module so the CFN custom-resource response resolves locally.
jest.mock('https', () => ({
  request: (_options: unknown, callback?: () => void) => {
    if (typeof callback === 'function') {
      callback();
    }
    return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  },
}));

import {
  handler,
  SEED_BLUEPRINTS,
  SEED_VERSION,
  buildSeedBlueprintItem,
  deterministicId,
} from '../seed-blueprints';

const ddbMock = mockClient(DynamoDBDocumentClient);

const EXPECTED_CONDITION_EXPRESSION =
  'attribute_not_exists(workflowId) OR attribute_not_exists(seedVersion) OR seedVersion < :v';

const NOW = '2026-07-17T00:00:00.000Z';

// ─── Envelope guard: field-for-field mirror of the frontend type guards ───
// Mirrors isWorkflowNodeDefinition in frontend/src/types/workflow.ts.
function isWorkflowNodeDefinition(node: unknown): boolean {
  if (node === null || typeof node !== 'object') {
    return false;
  }
  const candidate = node as {
    id?: unknown;
    agentId?: unknown;
    position?: unknown;
    configuration?: unknown;
  };
  if (candidate.position === null || typeof candidate.position !== 'object') {
    return false;
  }
  const position = candidate.position as { x?: unknown; y?: unknown };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.agentId === 'string' &&
    typeof position.x === 'number' &&
    typeof position.y === 'number' &&
    candidate.configuration !== null &&
    typeof candidate.configuration === 'object'
  );
}

// Mirrors isWorkflowEdgeDefinition in frontend/src/types/workflow.ts.
function isWorkflowEdgeDefinition(edge: unknown): boolean {
  if (edge === null || typeof edge !== 'object') {
    return false;
  }
  const candidate = edge as {
    id?: unknown;
    source?: unknown;
    target?: unknown;
    sourceHandle?: unknown;
    targetHandle?: unknown;
  };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.target === 'string' &&
    typeof candidate.sourceHandle === 'string' &&
    typeof candidate.targetHandle === 'string'
  );
}

// Mirrors isWorkflowDefinition in frontend/src/types/workflow.ts.
function isWorkflowDefinitionEnvelope(workflow: unknown): boolean {
  if (workflow === null || typeof workflow !== 'object') {
    return false;
  }
  const candidate = workflow as {
    version?: unknown;
    id?: unknown;
    name?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  if (
    typeof candidate.version !== 'string' ||
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !Array.isArray(candidate.nodes) ||
    !Array.isArray(candidate.edges)
  ) {
    return false;
  }
  return (
    candidate.nodes.every(isWorkflowNodeDefinition) &&
    candidate.edges.every(isWorkflowEdgeDefinition)
  );
}

// ─── CFN event/context fixtures ────────────────────────────────────────────
function makeEvent(
  requestType: 'Create' | 'Update' | 'Delete',
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints',
    ResponseURL:
      'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/response',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid',
    RequestId: 'unique-id-1234',
    ResourceType: 'Custom::SeedBlueprints',
    LogicalResourceId: 'SeedBlueprintsResource',
    ResourceProperties: {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints',
      Version: 'v1.2.0',
    },
  } as CloudFormationCustomResourceEvent;
}

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'seed-blueprints',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints',
  memoryLimitInMB: '128',
  awsRequestId: 'req-123',
  logGroupName: '/aws/lambda/seed-blueprints',
  logStreamName: '2026/07/17/[$LATEST]abc123',
  getRemainingTimeInMillis: () => 30000,
  done: jest.fn(),
  fail: jest.fn(),
  succeed: jest.fn(),
};

function logMessagesContaining(spy: jest.SpyInstance, needle: string): number {
  return spy.mock.calls.filter(
    (call) => typeof call[0] === 'string' && (call[0] as string).includes(needle),
  ).length;
}

describe('seed-blueprints contract', () => {
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
  });

  beforeEach(() => {
    ddbMock.reset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  afterAll(() => {
    delete process.env.WORKFLOWS_TABLE;
  });

  // ─── Part A: canonical envelope on every built seed definition ──────────

  describe('definition envelope', () => {
    test('SEED_VERSION starts at 2', () => {
      expect(SEED_VERSION).toBe(2);
    });

    test.each(SEED_BLUEPRINTS.map((bp) => [bp.name, bp] as const))(
      '"%s" builds a full canvas-shape WorkflowDefinition envelope',
      (_name, blueprint) => {
        const item = buildSeedBlueprintItem(blueprint, NOW);
        const definition: unknown = JSON.parse(item.definition);

        expect(isWorkflowDefinitionEnvelope(definition)).toBe(true);

        const envelope = definition as {
          version: string;
          id: string;
          name: string;
          createdAt: string;
          updatedAt: string;
          nodes: unknown[];
          edges: unknown[];
        };
        expect(envelope.version).toBe('1.0.0');
        expect(envelope.id).toBe(deterministicId(blueprint.name));
        expect(envelope.id).toBe(item.workflowId);
        expect(envelope.name).toBe(blueprint.name);
        expect(envelope.createdAt).toBe(NOW);
        expect(envelope.updatedAt).toBe(NOW);

        // Envelope is additive — node/edge shapes are unchanged.
        expect(envelope.nodes).toEqual(blueprint.definition.nodes);
        expect(envelope.edges).toEqual(blueprint.definition.edges);
      },
    );

    test.each(SEED_BLUEPRINTS.map((bp) => [bp.name, bp] as const))(
      '"%s" item is stamped with seedVersion = SEED_VERSION',
      (_name, blueprint) => {
        const item = buildSeedBlueprintItem(blueprint, NOW);
        expect(item.seedVersion).toBe(SEED_VERSION);
      },
    );
  });

  // ─── Part B: seedVersion-aware upsert semantics ──────────────────────────

  describe('seedVersion-aware upsert', () => {
    test('PutCommand uses the seedVersion-aware ConditionExpression with :v bound to SEED_VERSION', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Update'), mockContext, jest.fn());

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(SEED_BLUEPRINTS.length);
      for (const call of putCalls) {
        const input = call.args[0].input;
        expect(input.ConditionExpression).toBe(EXPECTED_CONDITION_EXPRESSION);
        expect(input.ExpressionAttributeValues).toEqual({ ':v': SEED_VERSION });
        expect(input.ReturnValues).toBe('ALL_OLD');
        expect(input.Item!.seedVersion).toBe(SEED_VERSION);
      }
    });

    test('logs created for each blueprint when no prior row exists (no Attributes returned)', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());

      expect(logMessagesContaining(logSpy, 'Created blueprint:')).toBe(
        SEED_BLUEPRINTS.length,
      );
      expect(logMessagesContaining(logSpy, 'Updated outdated seed blueprint')).toBe(0);
      expect(logMessagesContaining(logSpy, 'skipping:')).toBe(0);
    });

    test('logs updated (healed) when an outdated seed row is overwritten (Attributes returned)', async () => {
      // Existing envelope-less seed rows lack seedVersion → the condition
      // passes and Put replaces them, returning the old image.
      ddbMock.on(PutCommand).resolves({
        Attributes: { workflowId: 'existing-row', orgId: 'system' },
      });

      await handler(makeEvent('Update'), mockContext, jest.fn());

      expect(logMessagesContaining(logSpy, 'Updated outdated seed blueprint')).toBe(
        SEED_BLUEPRINTS.length,
      );
      expect(logMessagesContaining(logSpy, 'Created blueprint:')).toBe(0);
    });

    test('logs skipped and continues when rows are current (ConditionalCheckFailedException)', async () => {
      const conditionalError = new Error('The conditional request failed');
      conditionalError.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejects(conditionalError);

      await expect(
        handler(makeEvent('Update'), mockContext, jest.fn()),
      ).resolves.not.toThrow();

      // All blueprints are still attempted — one current row must not stop the rest.
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(SEED_BLUEPRINTS.length);
      expect(logMessagesContaining(logSpy, 'skipping:')).toBe(SEED_BLUEPRINTS.length);
    });

    test('heals exactly the outdated rows in a mixed table state', async () => {
      // First two rows are current (condition fails), the rest are healed.
      const conditionalError = new Error('The conditional request failed');
      conditionalError.name = 'ConditionalCheckFailedException';
      ddbMock
        .on(PutCommand)
        .rejectsOnce(conditionalError)
        .rejectsOnce(conditionalError)
        .resolves({ Attributes: { workflowId: 'stale-row' } });

      await handler(makeEvent('Update'), mockContext, jest.fn());

      expect(logMessagesContaining(logSpy, 'skipping:')).toBe(2);
      expect(logMessagesContaining(logSpy, 'Updated outdated seed blueprint')).toBe(
        SEED_BLUEPRINTS.length - 2,
      );
    });
  });
});
