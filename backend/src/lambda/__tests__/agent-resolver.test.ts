/**
 * Tests for agent-resolver Lambda
 */
// Env vars must be set BEFORE the resolver module is imported, because the
// module captures `process.env.PROJECTS_TABLE` and `process.env.AGENT_STATUS_TABLE`
// into top-level constants at load time.
process.env.AGENT_STATUS_TABLE = 'test-agent-status';
process.env.PROJECTS_TABLE = 'test-projects';
process.env.EVENT_BUS_NAME = 'test-event-bus';

import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);
const eventBridgeMock = mockClient(EventBridgeClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../agent-resolver';

/**
 * Configure dynamoMock to dispatch GetCommand calls per-table.
 * Returns the project Item from `projectItem` and the agent-status
 * Item from `agentStatusItem`. Either may be `undefined` to simulate
 * "row not found".
 */
function mockDynamoGets(projectItem: any, agentStatusItem: any) {
  dynamoMock.on(GetCommand).callsFake((input: any) => {
    if (input.TableName === 'test-projects') {
      return projectItem ? { Item: projectItem } : {};
    }
    if (input.TableName === 'test-agent-status') {
      return agentStatusItem ? { Item: agentStatusItem } : {};
    }
    return {};
  });
}

describe('agent-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    eventBridgeMock.reset();
    eventBridgeMock.on(PutEventsCommand).resolves({});
  });

  afterEach(() => {
    // Env vars are intentionally left in place — see the file-top hoisting.
  });

  /**
   * Build a synthetic AppSync event. The `claims['custom:organization']`
   * is the canonical caller-org reader path (see backend/src/utils/auth-event.ts);
   * setting it here keeps the test off the Cognito AdminGetUser fallback.
   */
  const makeEvent = (fieldName: string, args: any, orgId: string | null = 'org-1') => ({
    info: { fieldName },
    arguments: args,
    identity: {
      sub: 'user-123',
      claims: orgId ? { sub: 'user-123', 'custom:organization': orgId } : { sub: 'user-123' },
    },
  });

  describe('getAgentStatus', () => {
    test('returns agent status when found and caller org matches project organization', async () => {
      mockDynamoGets(
        { id: 'proj-1', organization: 'org-1', name: 'Test Project' },
        {
          agentId: 'agent-1',
          projectId: 'proj-1',
          status: 'PROCESSING',
          currentTask: 'Building',
          lastUpdate: '2025-01-01T00:00:00Z',
        },
      );

      const result = await handler(makeEvent('getAgentStatus', {
        projectId: 'proj-1',
        agentId: 'agent-1',
      }) as any, {} as any, {} as any);

      expect(result.agentId).toBe('agent-1');
      expect(result.status).toBe('PROCESSING');
      // Both reads were performed (project membership check + agent status read).
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(2);
    });

    test('returns default IDLE status when agent row missing but project exists & matches', async () => {
      mockDynamoGets(
        { id: 'proj-1', organization: 'org-1' },
        undefined, // agent-status row not found
      );

      const result = await handler(makeEvent('getAgentStatus', {
        projectId: 'proj-1',
        agentId: 'agent-new',
      }) as any, {} as any, {} as any);

      expect(result!.status).toBe('IDLE');
      expect(result!.agentId).toBe('agent-new');
    });

    // ─── Authz: project-membership check (security-architect issue 1) ─────

    test('throws Access denied when caller org differs from project organization', async () => {
      // Caller is in 'org-1' (from makeEvent) but project belongs to 'org-other'.
      mockDynamoGets(
        { id: 'proj-1', organization: 'org-other' },
        // Agent-status mock IS set, so a successful read would silently
        // bypass the check; the Access-denied throw must precede this read.
        {
          agentId: 'agent-1',
          projectId: 'proj-1',
          status: 'LEAKED',
          lastUpdate: '2025-01-01T00:00:00Z',
        },
      );

      await expect(
        handler(makeEvent('getAgentStatus', {
          projectId: 'proj-1',
          agentId: 'agent-1',
        }) as any, {} as any, {} as any),
      ).rejects.toThrow('Access denied');

      // Pin ordering: agent-status table must NOT be read on a tenant-mismatch
      // (closes the existence-oracle leak).
      const agentStatusReads = dynamoMock
        .commandCalls(GetCommand)
        .filter((c) => (c.args[0].input as any).TableName === 'test-agent-status');
      expect(agentStatusReads).toHaveLength(0);
    });

    test('returns null and does NOT read agent-status table when project not found', async () => {
      mockDynamoGets(
        undefined, // project not found
        {
          agentId: 'agent-1',
          projectId: 'missing',
          status: 'LEAKED',
          lastUpdate: '2025-01-01T00:00:00Z',
        },
      );

      const result = await handler(makeEvent('getAgentStatus', {
        projectId: 'missing',
        agentId: 'agent-1',
      }) as any, {} as any, {} as any);

      // null — not the legacy default IDLE — so a caller cannot use the
      // default response as an existence oracle for arbitrary projectIds.
      expect(result).toBeNull();
      const agentStatusReads = dynamoMock
        .commandCalls(GetCommand)
        .filter((c) => (c.args[0].input as any).TableName === 'test-agent-status');
      expect(agentStatusReads).toHaveLength(0);
    });
  });

  describe('updateAgentStatus', () => {
    test('stores status and emits EventBridge event when caller org matches project', async () => {
      // Project-membership precondition: caller in org-1, project in org-1.
      mockDynamoGets({ id: 'proj-1', organization: 'org-1' }, undefined);
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('updateAgentStatus', {
        projectId: 'proj-1',
        agentId: 'agent-1',
        status: { status: 'COMPLETED', progress: 100 },
      }) as any, {} as any, {} as any);

      expect(result.status).toBe('COMPLETED');
      expect(result.progress).toBe(100);

      // Project Get must precede the write.
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(1);
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    // ─── Authz: project-membership check (security-architect issue 1) ─────

    test('throws Access denied when caller org differs from project organization (write path)', async () => {
      // Caller is in 'org-1' (from makeEvent) but project belongs to 'org-other'.
      // PutCommand IS mocked with a sentinel response — if the resolver fails to
      // throw before the write, we must catch the leak via the call-count assertion.
      mockDynamoGets({ id: 'proj-1', organization: 'org-other' }, undefined);
      dynamoMock.on(PutCommand).resolves({ Attributes: { status: 'LEAKED' } } as any);
      eventBridgeMock.on(PutEventsCommand).resolves({});

      await expect(
        handler(makeEvent('updateAgentStatus', {
          projectId: 'proj-1',
          agentId: 'agent-1',
          status: { status: 'COMPLETED', progress: 100 },
        }) as any, {} as any, {} as any),
      ).rejects.toThrow('Access denied');

      // Pin ordering: the Put must NOT have run on a tenant mismatch.
      // This is the cross-tenant write-path leak the finding flagged.
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('returns null and does NOT write when project not found (write path)', async () => {
      mockDynamoGets(undefined, undefined); // project not found
      dynamoMock.on(PutCommand).resolves({ Attributes: { status: 'LEAKED' } } as any);
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('updateAgentStatus', {
        projectId: 'missing',
        agentId: 'agent-1',
        status: { status: 'COMPLETED', progress: 100 },
      }) as any, {} as any, {} as any);

      // null — mirrors getAgentStatus existence-oracle behavior, and prevents
      // a caller from probing arbitrary projectIds via successful writes.
      expect(result).toBeNull();
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });
  });

  test('throws on unknown field', async () => {
    await expect(
      handler(makeEvent('unknownField', {}) as any, {} as any, {} as any)
    ).rejects.toThrow('Unknown field');
  });
});
