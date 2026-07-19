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
 * KEEP IN SYNC: the envelope guard (imported from
 * fixtures/workflow-envelope-guard.ts) mirrors isWorkflowDefinition (and
 * its isWorkflowNodeDefinition / isWorkflowEdgeDefinition sub-guards) in
 * frontend/src/types/workflow.ts field-for-field. The frontend guard carries
 * the reciprocal cross-reference comment — if either side changes shape,
 * update both in the same review.
 */

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';

import { isWorkflowDefinitionEnvelope } from './fixtures/workflow-envelope-guard';

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

// aws-lambda's Handler type declares a legacy required callback third
// parameter, but the implementation is a two-parameter async
// (event, context) function that never uses it — invoke through the real
// signature (single cast here) so calls don't pass a superfluous callback.
const invokeHandler = handler as (
  event: CloudFormationCustomResourceEvent,
  context: Context,
) => Promise<void>;

const EXPECTED_CONDITION_EXPRESSION =
  'attribute_not_exists(workflowId) OR attribute_not_exists(seedVersion) OR seedVersion < :v';

const NOW = '2026-07-17T00:00:00.000Z';

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

      await invokeHandler(makeEvent('Update'), mockContext);

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

      await invokeHandler(makeEvent('Create'), mockContext);

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

      await invokeHandler(makeEvent('Update'), mockContext);

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
        invokeHandler(makeEvent('Update'), mockContext),
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

      await invokeHandler(makeEvent('Update'), mockContext);

      expect(logMessagesContaining(logSpy, 'skipping:')).toBe(2);
      expect(logMessagesContaining(logSpy, 'Updated outdated seed blueprint')).toBe(
        SEED_BLUEPRINTS.length - 2,
      );
    });
  });
});
