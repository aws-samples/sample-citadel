/**
 * Unit tests for execution-resolver Lambda
 * Uses aws-sdk-client-mock for DynamoDB, EventBridge, Cognito
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../execution-resolver';

type HandlerEvent = Parameters<typeof handler>[0];

function makeEvent(fieldName: string, args: Record<string, unknown>, sub = 'user-123'): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as unknown as HandlerEvent;
}

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

/** Invokes the handler and casts the result. */
async function invoke<T = Record<string, unknown>>(event: HandlerEvent): Promise<T> {
  return (await invokeHandler(event)) as T;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

describe('execution-resolver', () => {
  beforeAll(() => {
    process.env.EXECUTIONS_TABLE = 'citadel-executions-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    mockCognitoOrg('org-1');
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.EXECUTIONS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // ─── getExecution ──────────────────────────────────────────────

  describe('getExecution', () => {
    test('returns item and verifies org access', async () => {
      const execution = {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        orgId: 'org-1',
        status: 'pending',
        nodeResults: {},
        startedAt: '2024-01-01T00:00:00Z',
        triggeredBy: 'user-123',
      };
      ddbMock.on(GetCommand).resolves({ Item: execution });

      const result = await invoke(
        makeEvent('getExecution', { executionId: 'exec-1' }),
      );

      expect(result).toEqual(execution);
    });

    test('throws Access denied on org mismatch', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          orgId: 'org-other',
          status: 'pending',
        },
      });

      await expect(
        invoke(makeEvent('getExecution', { executionId: 'exec-1' }),),
      ).rejects.toThrow('Access denied');
    });

    test('claim-first path: reads custom:organization from identity and skips Cognito', async () => {
      const execution = {
        executionId: 'exec-claim',
        workflowId: 'wf-claim',
        orgId: 'org-claim',
        status: 'pending',
        nodeResults: {},
        startedAt: '2024-01-01T00:00:00Z',
        triggeredBy: 'user-123',
      };
      ddbMock.on(GetCommand).resolves({ Item: execution });

      const claimEvent = {
        info: { fieldName: 'getExecution' },
        arguments: { executionId: 'exec-claim' },
        identity: { sub: 'user-123', 'custom:organization': 'org-claim' },
      } as unknown as HandlerEvent;

      const result = await invoke(claimEvent);

      expect(result).toEqual(execution);
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });
  });

  // ─── listExecutions ────────────────────────────────────────────

  describe('listExecutions', () => {
    test('queries WorkflowIndex GSI by workflowId', async () => {
      const items = [
        { executionId: 'exec-1', workflowId: 'wf-1', status: 'completed', startedAt: '2024-01-01T00:00:00Z' },
        { executionId: 'exec-2', workflowId: 'wf-1', status: 'pending', startedAt: '2024-01-02T00:00:00Z' },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: items });

      const result = await invoke(
        makeEvent('listExecutions', { workflowId: 'wf-1' }),
      );

      expect(result).toEqual({ items, nextToken: undefined });

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('WorkflowIndex');
      expect(queryCall.args[0].input.KeyConditionExpression).toContain('workflowId');
    });
  });

  // ─── startExecution ────────────────────────────────────────────

  describe('startExecution', () => {
    const publishedWorkflow = {
      workflowId: 'wf-1',
      orgId: 'org-1',
      name: 'Published Workflow',
      status: 'PUBLISHED',
      version: 3,
      definition: JSON.stringify({
        nodes: [
          { id: 'n1', agentId: 'agent-1', type: 'agent' },
          { id: 'n2', agentId: 'agent-2', type: 'agent' },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      }),
    };

    test('verifies workflow is PUBLISHED, initializes all nodeResults as pending, publishes execution.start.requested event', async () => {
      // First GetCommand: workflow lookup
      ddbMock.on(GetCommand).resolves({ Item: publishedWorkflow });
      ddbMock.on(PutCommand).resolves({});

      const result = await invoke(
        makeEvent('startExecution', { workflowId: 'wf-1', input: JSON.stringify({ key: 'value' }) }),
      );

      // Execution created with correct fields
      expect(result.executionId).toBeDefined();
      expect(result.workflowId).toBe('wf-1');
      expect(result.status).toBe('pending');
      expect(result.workflowVersion).toBe(3);
      expect(result.orgId).toBe('org-1');
      expect(result.triggeredBy).toBe('user-123');
      expect(result.startedAt).toBeDefined();

      // All nodeResults initialized as pending
      const nodeResults = result.nodeResults as Record<string, { nodeId: string; agentId: string; status: string }>;
      expect(nodeResults).toBeDefined();
      expect(nodeResults['n1']).toMatchObject({ nodeId: 'n1', agentId: 'agent-1', status: 'pending' });
      expect(nodeResults['n2']).toMatchObject({ nodeId: 'n2', agentId: 'agent-2', status: 'pending' });

      // PutCommand for execution
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);

      // EventBridge: execution.start.requested
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.workflows');
      expect(entry.DetailType).toBe('execution.start.requested');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.executionId).toBe(result.executionId);
      expect(detail.workflowId).toBe('wf-1');
    });

    test('rejects DRAFT workflows', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-draft',
          orgId: 'org-1',
          name: 'Draft Workflow',
          status: 'DRAFT',
          version: 1,
          definition: JSON.stringify({ nodes: [], edges: [] }),
        },
      });

      await expect(
        invoke(makeEvent('startExecution', { workflowId: 'wf-draft' }),),
      ).rejects.toThrow(/published/i);
    });
  });

  // ─── cancelExecution ───────────────────────────────────────────

  describe('cancelExecution', () => {
    test('updates status to cancelled and publishes execution.cancel.requested event', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          orgId: 'org-1',
          status: 'running',
        },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          orgId: 'org-1',
          status: 'cancelled',
        },
      });

      const result = await invoke(
        makeEvent('cancelExecution', { executionId: 'exec-1' }),
      );

      expect(result.status).toBe('cancelled');

      // UpdateCommand called
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      // EventBridge: execution.cancel.requested
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.workflows');
      expect(entry.DetailType).toBe('execution.cancel.requested');
    });
  });

  // ─── publishWorkflowProgress ───────────────────────────────────

  describe('publishWorkflowProgress', () => {
    const progressInput = {
      executionId: 'exec-1',
      workflowId: 'wf-1',
      eventType: 'node.completed',
      nodeId: 'n1',
      status: 'completed',
      output: '{"result":"ok"}',
      error: null,
      timestamp: '2024-01-01T00:00:00Z',
    };

    test('echoes args.input so AppSync fans out to onWorkflowProgress subscribers', async () => {
      const result = await invoke(
        makeEvent('publishWorkflowProgress', { input: progressInput }),
      );

      expect(result).toEqual(progressInput);
    });

    test('does not throw Unknown field', async () => {
      await expect(
        invoke(makeEvent('publishWorkflowProgress', { input: progressInput }),),
      ).resolves.toBeDefined();
    });
  });
});
