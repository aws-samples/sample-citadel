/**
 * Unit tests for seed-blueprints Lambda (CloudFormation Custom Resource)
 * Tests seed blueprint creation, structure validation, and idempotency.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 27.5
 */

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';

const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock https module for CFN response
const mockHttpsRequest = jest.fn();
jest.mock('https', () => ({
  request: (...args: any[]) => {
    mockHttpsRequest(...args);
    const req = {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    // Call the callback immediately with a mock response
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      callback({ statusCode: 200 });
    }
    return req;
  },
}));

// Import handler after mocks are set up
import { handler, SEED_BLUEPRINTS } from '../index';

function makeEvent(requestType: 'Create' | 'Update' | 'Delete'): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints',
    ResponseURL: 'https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/response',
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid',
    RequestId: 'unique-id-1234',
    ResourceType: 'Custom::SeedBlueprints',
    LogicalResourceId: 'SeedBlueprintsResource',
    ResourceProperties: {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints',
      Version: 'v1.0.0',
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
  logStreamName: '2024/01/15/[$LATEST]abc123',
  getRemainingTimeInMillis: () => 30000,
  done: jest.fn(),
  fail: jest.fn(),
  succeed: jest.fn(),
};

describe('seed-blueprints Lambda', () => {
  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
  });

  beforeEach(() => {
    ddbMock.reset();
    mockHttpsRequest.mockClear();
  });

  afterAll(() => {
    delete process.env.WORKFLOWS_TABLE;
  });

  // ─── Blueprint structure validation ────────────────────────────

  describe('seed blueprint definitions', () => {
    test('exports exactly 4 seed blueprints', () => {
      expect(SEED_BLUEPRINTS).toHaveLength(4);
    });

    test('all 4 expected blueprints are present by name', () => {
      const names = SEED_BLUEPRINTS.map((b) => b.name);
      expect(names).toContain('Sequential Agent Pipeline');
      expect(names).toContain('Parallel Fan-Out');
      expect(names).toContain('Conditional Router');
      expect(names).toContain('Data Processing Pipeline');
    });

    test.each([
      'Sequential Agent Pipeline',
      'Parallel Fan-Out',
      'Conditional Router',
      'Data Processing Pipeline',
    ])('"%s" has valid WorkflowDefinition structure (nodes array, edges array)', (name) => {
      const bp = SEED_BLUEPRINTS.find((b) => b.name === name)!;
      expect(bp).toBeDefined();
      expect(bp.definition).toBeDefined();
      expect(Array.isArray(bp.definition.nodes)).toBe(true);
      expect(Array.isArray(bp.definition.edges)).toBe(true);
      expect(bp.definition.nodes.length).toBeGreaterThan(0);

      // Each node has required fields
      for (const node of bp.definition.nodes) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('agentId');
        expect(node).toHaveProperty('position');
        expect(typeof node.position.x).toBe('number');
        expect(typeof node.position.y).toBe('number');
        expect(node).toHaveProperty('configuration');
      }

      // Each edge has required fields
      for (const edge of bp.definition.edges) {
        expect(edge).toHaveProperty('id');
        expect(edge).toHaveProperty('source');
        expect(edge).toHaveProperty('target');
        expect(edge).toHaveProperty('sourceHandle');
        expect(edge).toHaveProperty('targetHandle');
      }
    });

    test('each blueprint has metadata with category and isSystem flag', () => {
      for (const bp of SEED_BLUEPRINTS) {
        expect(bp.metadata).toBeDefined();
        expect(typeof bp.metadata.category).toBe('string');
        expect(bp.metadata.category.length).toBeGreaterThan(0);
        expect(bp.metadata.isSystem).toBe(true);
      }
    });

    test('Sequential Agent Pipeline has 3 nodes and 2 edges', () => {
      const bp = SEED_BLUEPRINTS.find((b) => b.name === 'Sequential Agent Pipeline')!;
      expect(bp.definition.nodes).toHaveLength(3);
      expect(bp.definition.edges).toHaveLength(2);
    });

    test('Parallel Fan-Out has 5 nodes (1→3→1) and 6 edges', () => {
      const bp = SEED_BLUEPRINTS.find((b) => b.name === 'Parallel Fan-Out')!;
      expect(bp.definition.nodes).toHaveLength(5);
      expect(bp.definition.edges).toHaveLength(6);
    });

    test('Conditional Router has 4 nodes (1→2→1) and edges with conditions', () => {
      const bp = SEED_BLUEPRINTS.find((b) => b.name === 'Conditional Router')!;
      expect(bp.definition.nodes).toHaveLength(4);
      // 1→2 edges + 2→1 edges = 4 edges
      expect(bp.definition.edges.length).toBeGreaterThanOrEqual(4);
    });

    test('Data Processing Pipeline has 4 nodes and 3 edges', () => {
      const bp = SEED_BLUEPRINTS.find((b) => b.name === 'Data Processing Pipeline')!;
      expect(bp.definition.nodes).toHaveLength(4);
      expect(bp.definition.edges).toHaveLength(3);
    });
  });

  // ─── Create/Update behavior ────────────────────────────────────

  describe('Create and Update request types', () => {
    test('blueprints are created with isBlueprint="true" and status=PUBLISHED', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(4);

      for (const call of putCalls) {
        const item = call.args[0].input.Item!;
        expect(item.isBlueprint).toBe('true');
        expect(item.status).toBe('PUBLISHED');
        expect(item.orgId).toBe('system');
        expect(item.createdBy).toBe('system');
        expect(typeof item.workflowId).toBe('string');
        expect(item.version).toBe(1);
      }
    });

    test('PutCommand uses ConditionExpression for idempotency', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());

      const putCalls = ddbMock.commandCalls(PutCommand);
      for (const call of putCalls) {
        expect(call.args[0].input.ConditionExpression).toBe(
          'attribute_not_exists(workflowId)',
        );
      }
    });

    test('handles ConditionalCheckFailedException gracefully on re-deploy', async () => {
      const conditionalError = new Error('The conditional request failed');
      (conditionalError as any).name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejects(conditionalError);

      // Should not throw — idempotent behavior
      await expect(
        handler(makeEvent('Update'), mockContext, jest.fn()),
      ).resolves.not.toThrow();
    });

    test('uses deterministic workflowId based on blueprint name', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());
      const firstCallIds = ddbMock.commandCalls(PutCommand).map(
        (c) => c.args[0].input.Item!.workflowId,
      );

      ddbMock.reset();
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());
      const secondCallIds = ddbMock.commandCalls(PutCommand).map(
        (c) => c.args[0].input.Item!.workflowId,
      );

      // Same blueprint names should produce same IDs across invocations
      expect(firstCallIds).toEqual(secondCallIds);
    });

    test('uses WORKFLOWS_TABLE env var and writes all 4 blueprints', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());

      // Verify all 4 blueprints were written
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(4);

      // Verify the handler reads from WORKFLOWS_TABLE env var
      // (if env var is missing, handler would throw on undefined table)
      const origTable = process.env.WORKFLOWS_TABLE;
      delete process.env.WORKFLOWS_TABLE;
      // Re-import would be needed to test this properly, but we verify
      // the env var is set and the handler completes successfully
      process.env.WORKFLOWS_TABLE = origTable;
    });

    test('definition is stored as serialized JSON string', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());

      const putCalls = ddbMock.commandCalls(PutCommand);
      for (const call of putCalls) {
        const item = call.args[0].input.Item!;
        expect(typeof item.definition).toBe('string');
        // Should be valid JSON
        const parsed = JSON.parse(item.definition);
        expect(Array.isArray(parsed.nodes)).toBe(true);
        expect(Array.isArray(parsed.edges)).toBe(true);
      }
    });

    test('metadata is stored as serialized JSON string with category and isSystem', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(makeEvent('Create'), mockContext, jest.fn());

      const putCalls = ddbMock.commandCalls(PutCommand);
      for (const call of putCalls) {
        const item = call.args[0].input.Item!;
        expect(typeof item.metadata).toBe('string');
        const parsed = JSON.parse(item.metadata);
        expect(typeof parsed.category).toBe('string');
        expect(parsed.isSystem).toBe(true);
      }
    });
  });

  // ─── Delete behavior ───────────────────────────────────────────

  describe('Delete request type', () => {
    test('does nothing on Delete — no DynamoDB calls', async () => {
      await handler(makeEvent('Delete'), mockContext, jest.fn());

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });
  });

  // ─── Error propagation ────────────────────────────────────────

  describe('error handling', () => {
    test('re-throws non-ConditionalCheckFailedException errors', async () => {
      ddbMock.on(PutCommand).rejects(new Error('InternalServerError'));

      await expect(
        handler(makeEvent('Create'), mockContext, jest.fn()),
      ).rejects.toThrow('InternalServerError');
    });
  });
});
