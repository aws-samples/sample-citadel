/**
 * Unit tests for workflow-resolver Lambda — CRUD operations
 * Uses aws-sdk-client-mock for DynamoDB, EventBridge, Cognito
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../workflow-resolver';

function makeEvent(fieldName: string, args: any, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as any;
}

/** Helper: configure Cognito mock to return orgId for user */
function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

describe('workflow-resolver', () => {
  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
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
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.APPS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // ─── getWorkflow ───────────────────────────────────────────────

  describe('getWorkflow', () => {
    test('returns item when caller orgId matches workflow orgId', async () => {
      const workflow = {
        workflowId: 'wf-1',
        orgId: 'org-1',
        name: 'Test Workflow',
        status: 'DRAFT',
        version: 1,
      };
      ddbMock.on(GetCommand).resolves({ Item: workflow });

      const result = await handler(
        makeEvent('getWorkflow', { workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      expect(result).toEqual(workflow);
    });

    test('throws Access denied when caller orgId does not match workflow orgId', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-other', name: 'Other Org Workflow' },
      });

      await expect(
        handler(makeEvent('getWorkflow', { workflowId: 'wf-1' }), {} as any, {} as any),
      ).rejects.toThrow('Access denied');
    });
  });

  // ─── listWorkflows ─────────────────────────────────────────────

  describe('listWorkflows', () => {
    test('queries OrgStatusIndex and filters isBlueprint=false', async () => {
      const items = [
        { workflowId: 'wf-1', orgId: 'org-1', isBlueprint: 'false', status: 'DRAFT' },
        { workflowId: 'wf-2', orgId: 'org-1', isBlueprint: 'false', status: 'PUBLISHED' },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: items });

      const result = await handler(
        makeEvent('listWorkflows', { orgId: 'org-1' }),
        {} as any,
        {} as any,
      );

      expect(result).toEqual({ items, nextToken: undefined });

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('OrgStatusIndex');
    });
  });

  // ─── listBlueprints ────────────────────────────────────────────

  describe('listBlueprints', () => {
    test('queries BlueprintIndex for isBlueprint=true and filters by category', async () => {
      const blueprints = [
        {
          workflowId: 'bp-1',
          isBlueprint: 'true',
          metadata: JSON.stringify({ category: 'data-processing' }),
        },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: blueprints });

      const result = await handler(
        makeEvent('listBlueprints', { category: 'data-processing' }),
        {} as any,
        {} as any,
      );

      expect(result).toEqual({ items: blueprints, nextToken: undefined });

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('BlueprintIndex');
    });
  });

  // ─── createWorkflow ────────────────────────────────────────────

  describe('createWorkflow', () => {
    test('sets version=1, status=DRAFT, generates UUID, isBlueprint defaults to "false"', async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent('createWorkflow', {
          input: {
            name: 'New Workflow',
            description: 'A test workflow',
            orgId: 'org-1',
            definition: JSON.stringify({ nodes: [], edges: [] }),
          },
        }),
        {} as any,
        {} as any,
      );

      expect(result).toMatchObject({
        name: 'New Workflow',
        orgId: 'org-1',
        status: 'DRAFT',
        version: 1,
        isBlueprint: 'false',
      });
      expect(result.workflowId).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(result.createdBy).toBe('user-123');

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });
  });

  // ─── updateWorkflow ────────────────────────────────────────────

  describe('updateWorkflow', () => {
    test('succeeds with correct version (optimistic lock)', async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          name: 'Updated Name',
          version: 2,
          status: 'DRAFT',
        },
      });
      // Mock getWorkflow for org check
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', version: 1, status: 'DRAFT' },
      });

      const result = await handler(
        makeEvent('updateWorkflow', {
          input: { workflowId: 'wf-1', name: 'Updated Name', version: 1 },
        }),
        {} as any,
        {} as any,
      );

      expect(result.name).toBe('Updated Name');
      expect(result.version).toBe(2);
    });

    test('throws conflict error when version is stale', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', version: 3, status: 'DRAFT' },
      });
      const condErr = new Error('ConditionalCheckFailedException');
      condErr.name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateCommand).rejects(condErr);

      await expect(
        handler(
          makeEvent('updateWorkflow', {
            input: { workflowId: 'wf-1', name: 'Stale', version: 1 },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/Conflict/);
    });
  });

  // ─── deleteWorkflow ────────────────────────────────────────────

  describe('deleteWorkflow', () => {
    test('succeeds when workflow is DRAFT', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', status: 'DRAFT' },
      });
      ddbMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent('deleteWorkflow', { workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      expect(result).toEqual({ success: true, message: expect.any(String) });
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    test('throws error when workflow is PUBLISHED', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', status: 'PUBLISHED' },
      });

      await expect(
        handler(makeEvent('deleteWorkflow', { workflowId: 'wf-1' }), {} as any, {} as any),
      ).rejects.toThrow(/published/i);
    });
  });

  // ─── publishWorkflow ───────────────────────────────────────────

  describe('publishWorkflow', () => {
    const validDefinition = JSON.stringify({
      nodes: [
        { id: 'n1', agentId: 'agent-1', type: 'agent' },
        { id: 'n2', agentId: 'agent-2', type: 'agent' },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });

    test('validates definition and updates status to PUBLISHED', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          status: 'DRAFT',
          definition: validDefinition,
          version: 1,
        },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          status: 'PUBLISHED',
          definition: validDefinition,
          version: 2,
        },
      });

      const result = await handler(
        makeEvent('publishWorkflow', { workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      expect(result.status).toBe('PUBLISHED');
    });

    test('returns validation errors for invalid definition (node missing agentId)', async () => {
      const invalidDef = JSON.stringify({
        nodes: [
          { id: 'n1', type: 'agent' }, // missing agentId
        ],
        edges: [],
      });
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          status: 'DRAFT',
          definition: invalidDef,
          version: 1,
        },
      });

      await expect(
        handler(makeEvent('publishWorkflow', { workflowId: 'wf-1' }), {} as any, {} as any),
      ).rejects.toThrow(/validation/i);
    });
  });

  // ─── EventBridge events ────────────────────────────────────────

  describe('EventBridge events', () => {
    test('emits workflow.created event on createWorkflow', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(
        makeEvent('createWorkflow', {
          input: {
            name: 'EB Test',
            orgId: 'org-1',
            definition: JSON.stringify({ nodes: [], edges: [] }),
          },
        }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.workflows');
      expect(entry.DetailType).toBe('workflow.created');
    });

    test('emits workflow.updated event on updateWorkflow', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', version: 1, status: 'DRAFT' },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { workflowId: 'wf-1', orgId: 'org-1', name: 'Updated', version: 2 },
      });

      await handler(
        makeEvent('updateWorkflow', {
          input: { workflowId: 'wf-1', name: 'Updated', version: 1 },
        }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.workflows');
      expect(entry.DetailType).toBe('workflow.updated');
    });

    test('emits workflow.deleted event on deleteWorkflow', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', status: 'DRAFT' },
      });
      ddbMock.on(DeleteCommand).resolves({});

      await handler(
        makeEvent('deleteWorkflow', { workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.workflows');
      expect(entry.DetailType).toBe('workflow.deleted');
    });

    test('emits workflow.published event on publishWorkflow', async () => {
      const validDef = JSON.stringify({
        nodes: [
          { id: 'n1', agentId: 'a1', type: 'agent' },
          { id: 'n2', agentId: 'a2', type: 'agent' },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      });
      ddbMock.on(GetCommand).resolves({
        Item: { workflowId: 'wf-1', orgId: 'org-1', status: 'DRAFT', definition: validDef, version: 1 },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { workflowId: 'wf-1', orgId: 'org-1', status: 'PUBLISHED', version: 2 },
      });

      await handler(
        makeEvent('publishWorkflow', { workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.workflows');
      expect(entry.DetailType).toBe('workflow.published');
    });
  });

  // ─── updateWorkflowConfiguration ──────────────────────────────

  describe('updateWorkflowConfiguration', () => {
    test('shallow merges config at top-level keys and uses optimistic lock via version', async () => {
      const existingConfig = JSON.stringify({
        integrations: { int1: { endpoint: 'https://old.com' } },
        credentials: { cred1: 'secret-ref-1' },
      });
      const newConfig = JSON.stringify({
        integrations: { int2: { endpoint: 'https://new.com' } },
        parameters: { key1: 'value1' },
      });
      // GetCommand returns existing workflow with config
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          version: 3,
          status: 'DRAFT',
          configuration: existingConfig,
        },
      });
      // UpdateCommand returns merged result
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          version: 4,
          status: 'DRAFT',
          configuration: JSON.stringify({
            integrations: { int2: { endpoint: 'https://new.com' } },
            credentials: { cred1: 'secret-ref-1' },
            parameters: { key1: 'value1' },
          }),
        },
      });

      const result = await handler(
        makeEvent('updateWorkflowConfiguration', {
          workflowId: 'wf-1',
          configuration: newConfig,
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      expect(result.version).toBe(4);
      // Verify UpdateCommand was called with version condition
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      const updateInput = updateCalls[0].args[0].input;
      expect(updateInput.ConditionExpression).toContain('version');
    });
  });

  // ─── importBlueprint ──────────────────────────────────────────

  describe('importBlueprint', () => {
    const blueprintDef = JSON.stringify({
      nodes: [
        { id: 'n1', agentId: 'agent-1', type: 'agent' },
        { id: 'n2', agentId: 'agent-2', type: 'agent' },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });

    test('deep-copies definition from PUBLISHED blueprint, sets DRAFT, isBlueprint=false, appends workflowId to app workflowIds, emits workflow.imported', async () => {
      // First GetCommand: blueprint lookup
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: {
            workflowId: 'bp-1',
            orgId: 'org-1',
            name: 'My Blueprint',
            status: 'PUBLISHED',
            isBlueprint: 'true',
            definition: blueprintDef,
            metadata: JSON.stringify({ category: 'data-processing' }),
            version: 2,
          },
        })
        // Second GetCommand: app lookup
        .resolvesOnce({
          Item: {
            appId: 'app-1',
            orgId: 'org-1',
            name: 'My App',
            workflowIds: ['wf-existing'],
            version: 1,
          },
        });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('importBlueprint', { blueprintId: 'bp-1', appId: 'app-1' }),
        {} as any,
        {} as any,
      );

      // New workflow created as DRAFT, not a blueprint
      expect(result.status).toBe('DRAFT');
      expect(result.isBlueprint).toBe('false');
      expect(result.workflowId).toBeDefined();
      expect(result.workflowId).not.toBe('bp-1'); // new UUID
      expect(result.name).toBe('My Blueprint (Copy)'); // default name
      expect(result.appId).toBe('app-1');

      // Definition is deep-copied
      expect(result.definition).toBe(blueprintDef);

      // PutCommand for new workflow + UpdateCommand for app
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);

      // EventBridge: workflow.imported
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('workflow.imported');
    });

    test('rejects draft blueprints', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          workflowId: 'bp-draft',
          orgId: 'org-1',
          name: 'Draft Blueprint',
          status: 'DRAFT',
          isBlueprint: 'true',
          definition: blueprintDef,
          version: 1,
        },
      });

      await expect(
        handler(
          makeEvent('importBlueprint', { blueprintId: 'bp-draft', appId: 'app-1' }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/published/i);
    });

    test('rejects wrong orgId (throws Access denied)', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: {
            workflowId: 'bp-1',
            orgId: 'org-1',
            name: 'Blueprint',
            status: 'PUBLISHED',
            isBlueprint: 'true',
            definition: blueprintDef,
            version: 2,
          },
        })
        .resolvesOnce({
          Item: {
            appId: 'app-1',
            orgId: 'org-other', // different org
            name: 'Other App',
            workflowIds: [],
            version: 1,
          },
        });

      await expect(
        handler(
          makeEvent('importBlueprint', { blueprintId: 'bp-1', appId: 'app-1' }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/Access denied/i);
    });
  });

  // ─── importWorkflow ────────────────────────────────────────────

  describe('importWorkflow', () => {
    test('validates JSON structure, generates new UUID, sets version=1, status=DRAFT', async () => {
      const workflowJson = JSON.stringify({
        name: 'Imported Workflow',
        description: 'From export',
        definition: JSON.stringify({
          nodes: [{ id: 'n1', agentId: 'a1', type: 'agent' }],
          edges: [],
        }),
        configuration: null,
        metadata: null,
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent('importWorkflow', {
          input: { orgId: 'org-1', workflowJson, name: 'Custom Name' },
        }),
        {} as any,
        {} as any,
      );

      expect(result.workflowId).toBeDefined();
      expect(result.version).toBe(1);
      expect(result.status).toBe('DRAFT');
      expect(result.name).toBe('Custom Name');
      expect(result.orgId).toBe('org-1');
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });
  });

  // ─── exportWorkflow ────────────────────────────────────────────

  describe('exportWorkflow', () => {
    test('returns workflow as JSON and verifies org access', async () => {
      const definition = JSON.stringify({ nodes: [], edges: [] });
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          name: 'Export Me',
          definition,
          configuration: null,
          metadata: null,
          status: 'DRAFT',
          version: 1,
        },
      });

      const result = await handler(
        makeEvent('exportWorkflow', { workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      // Should return the workflow data as JSON
      expect(result).toBeDefined();
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      expect(parsed.name).toBe('Export Me');
      expect(parsed.definition).toBe(definition);
    });
  });

  // ─── getWorkflowVersion ────────────────────────────────────────

  describe('getWorkflowVersion', () => {
    test('extracts correct version from versionHistory array', async () => {
      const v1Def = JSON.stringify({ nodes: [{ id: 'n1', agentId: 'a1', type: 'agent' }], edges: [] });
      const v2Def = JSON.stringify({ nodes: [{ id: 'n1', agentId: 'a1', type: 'agent' }, { id: 'n2', agentId: 'a2', type: 'agent' }], edges: [] });
      const currentDef = JSON.stringify({ nodes: [], edges: [] });

      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          name: 'Versioned Workflow',
          definition: currentDef,
          version: 3,
          versionHistory: [
            { version: 1, definition: v1Def, updatedAt: '2024-01-01T00:00:00Z', updatedBy: 'user-1' },
            { version: 2, definition: v2Def, updatedAt: '2024-01-02T00:00:00Z', updatedBy: 'user-1' },
          ],
        },
      });

      const result = await handler(
        makeEvent('getWorkflowVersion', { workflowId: 'wf-1', version: 1 }),
        {} as any,
        {} as any,
      );

      expect(result.definition).toBe(v1Def);
      expect(result.workflowId).toBe('wf-1');
    });
  });

  // ─── versioning ─────────────────────────────────────────────────

  describe('versioning', () => {
    const oldDef = JSON.stringify({ nodes: [{ id: 'n1', agentId: 'a1', type: 'agent' }], edges: [] });
    const newDef = JSON.stringify({ nodes: [{ id: 'n1', agentId: 'a1', type: 'agent' }, { id: 'n2', agentId: 'a2', type: 'agent' }], edges: [] });

    test('updateWorkflow appends previous state to versionHistory before updating', async () => {
      // Existing workflow at version 2 with one history entry
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          version: 2,
          status: 'DRAFT',
          definition: oldDef,
          updatedAt: '2024-01-02T00:00:00Z',
          createdBy: 'user-123',
          versionHistory: [
            { version: 1, definition: '{"nodes":[],"edges":[]}', updatedAt: '2024-01-01T00:00:00Z', updatedBy: 'user-123' },
          ],
        },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          name: 'Updated',
          version: 3,
          status: 'DRAFT',
          definition: newDef,
        },
      });

      await handler(
        makeEvent('updateWorkflow', {
          input: { workflowId: 'wf-1', definition: newDef, version: 2 },
        }),
        {} as any,
        {} as any,
      );

      // Verify the UpdateCommand includes versionHistory append
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      const updateInput = updateCalls[0].args[0].input;
      const updateExpr = updateInput.UpdateExpression as string;
      expect(updateExpr).toContain('versionHistory');
    });

    test('versionHistory entry contains correct version, definition, updatedAt, updatedBy fields', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          version: 2,
          status: 'DRAFT',
          definition: oldDef,
          updatedAt: '2024-06-15T10:30:00Z',
          createdBy: 'user-123',
          versionHistory: [],
        },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          version: 3,
          definition: newDef,
        },
      });

      await handler(
        makeEvent('updateWorkflow', {
          input: { workflowId: 'wf-1', definition: newDef, version: 2 },
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const exprValues = updateCalls[0].args[0].input.ExpressionAttributeValues!;
      const historyEntry = exprValues[':historyEntry'];
      expect(historyEntry).toBeDefined();
      expect(historyEntry).toEqual([
        {
          version: 2,
          definition: oldDef,
          updatedAt: '2024-06-15T10:30:00Z',
          updatedBy: 'user-123',
        },
      ]);
    });

    test('getWorkflowVersion returns correct historical definition from versionHistory', async () => {
      const v1Def = JSON.stringify({ nodes: [], edges: [] });
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: 'wf-1',
          orgId: 'org-1',
          version: 3,
          definition: newDef,
          versionHistory: [
            { version: 1, definition: v1Def, updatedAt: '2024-01-01T00:00:00Z', updatedBy: 'user-1' },
            { version: 2, definition: oldDef, updatedAt: '2024-01-02T00:00:00Z', updatedBy: 'user-1' },
          ],
        },
      });

      const result = await handler(
        makeEvent('getWorkflowVersion', { workflowId: 'wf-1', version: 2 }),
        {} as any,
        {} as any,
      );

      expect(result.version).toBe(2);
      expect(result.definition).toBe(oldDef);
      expect(result.workflowId).toBe('wf-1');
    });
  });

  // ─── listAppWorkflows ──────────────────────────────────────────

  describe('listAppWorkflows', () => {
    test('fetches app by appId, then BatchGetItem for workflows by workflowIds', async () => {
      // GetCommand returns the app
      ddbMock.on(GetCommand).resolves({
        Item: {
          appId: 'app-1',
          orgId: 'org-1',
          name: 'My App',
          workflowIds: ['wf-1', 'wf-2'],
          version: 1,
        },
      });
      // BatchGetCommand returns the workflows
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {
          'citadel-workflows-test': [
            { workflowId: 'wf-1', orgId: 'org-1', name: 'Workflow 1', status: 'DRAFT' },
            { workflowId: 'wf-2', orgId: 'org-1', name: 'Workflow 2', status: 'PUBLISHED' },
          ],
        },
      });

      const result = await handler(
        makeEvent('listAppWorkflows', { appId: 'app-1' }),
        {} as any,
        {} as any,
      );

      expect(result).toHaveLength(2);
      expect(result[0].workflowId).toBe('wf-1');
      expect(result[1].workflowId).toBe('wf-2');

      // Verify BatchGetCommand was called
      expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(1);
    });
  });
});
