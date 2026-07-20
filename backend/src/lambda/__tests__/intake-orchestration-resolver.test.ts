/**
 * Unit tests for intake-orchestration-resolver — the IAM-only AppSync router
 * behind the 4 intake post-fabrication mutations. The resolver is a thin
 * boundary: identity guard, input validation, server-side org/project
 * derivation, then delegation to the existing resolver cores (which are
 * mocked here — their own behavior is covered by their own suites).
 */
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

jest.mock('../agent-config-resolver', () => ({
  activateProjectAgents: jest.fn(),
}));
jest.mock('../registry-agent-record-resolver', () => ({
  createApp: jest.fn(),
}));
jest.mock('../workflow-resolver', () => ({
  createWorkflow: jest.fn(),
  publishWorkflow: jest.fn(),
  importBlueprint: jest.fn(),
}));

import { activateProjectAgents } from '../agent-config-resolver';
import { createApp } from '../registry-agent-record-resolver';
import { createWorkflow, publishWorkflow, importBlueprint } from '../workflow-resolver';
import { handler } from '../intake-orchestration-resolver';

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const activateMock = activateProjectAgents as jest.MockedFunction<typeof activateProjectAgents>;
const createAppMock = createApp as jest.MockedFunction<typeof createApp>;
const createWorkflowMock = createWorkflow as jest.MockedFunction<typeof createWorkflow>;
const publishWorkflowMock = publishWorkflow as jest.MockedFunction<typeof publishWorkflow>;
const importBlueprintMock = importBlueprint as jest.MockedFunction<typeof importBlueprint>;

type HandlerEvent = Parameters<typeof handler>[0];

const IAM_IDENTITY = {
  accountId: '123456789012',
  userArn: 'arn:aws:sts::123456789012:assumed-role/intake-runtime-role/session',
  username: 'AROAEXAMPLE:session',
  sourceIp: ['10.0.0.1'],
};

const COGNITO_IDENTITY = {
  sub: 'user-123',
  claims: { sub: 'user-123', 'custom:organization': 'org-evil' },
};

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  identity: unknown = IAM_IDENTITY,
): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity,
  } as unknown as HandlerEvent;
}

const invoke = handler as (event: HandlerEvent) => Promise<unknown>;

const SESSION_ID = 'sess-1111';
const PROJECT_ID = 'proj-2222';
const ORG_ID = 'org-1';
const OWNER_SUB = 'owner-sub-3333';

/** Wire the conversations scan → projectId and projects get → org/name. */
function mockSessionLinkage(opts?: {
  conversationItems?: Record<string, unknown>[];
  project?: Record<string, unknown> | null;
}): void {
  ddbMock
    .on(ScanCommand, { TableName: 'citadel-conversations-test' })
    .resolves({ Items: opts?.conversationItems ?? [{ projectId: PROJECT_ID }] });
  const project =
    opts?.project === undefined
      ? { id: PROJECT_ID, name: 'Alpha Project', organization: ORG_ID, owner: OWNER_SUB }
      : opts.project;
  ddbMock
    .on(GetCommand, { TableName: 'citadel-projects-test' })
    .resolves({ Item: project ?? undefined });
}

describe('intake-orchestration-resolver', () => {
  beforeAll(() => {
    process.env.PROJECTS_TABLE = 'citadel-projects-test';
    process.env.CONVERSATIONS_TABLE = 'citadel-conversations-test';
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.USER_POOL_ID = 'us-west-2_testpool';
  });

  afterAll(() => {
    delete process.env.PROJECTS_TABLE;
    delete process.env.CONVERSATIONS_TABLE;
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.USER_POOL_ID;
  });

  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
    // No stray fallback lookups succeed unless a test wires them explicitly.
    cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });
    jest.clearAllMocks();
  });

  // ─── identity guard (defence-in-depth on top of @aws_iam) ────────────

  describe('IAM identity guard', () => {
    const fields = [
      'intakeActivateProjectAgents',
      'intakeCreateApp',
      'intakeCreateBlueprint',
      'intakeImportBlueprintToApp',
    ];

    test.each(fields)('rejects a Cognito-shaped identity on %s', async (field) => {
      await expect(
        invoke(makeEvent(field, { sessionId: SESSION_ID }, COGNITO_IDENTITY)),
      ).rejects.toThrow(/IAM-only/);
    });

    test('rejects a null identity', async () => {
      await expect(
        invoke(makeEvent('intakeActivateProjectAgents', { sessionId: SESSION_ID }, null)),
      ).rejects.toThrow(/IAM-only/);
    });
  });

  test('throws on unknown field', async () => {
    await expect(invoke(makeEvent('somethingElse', {}))).rejects.toThrow(/Unknown field/);
  });

  // ─── intakeActivateProjectAgents (R1 matching) ───────────────────────

  describe('intakeActivateProjectAgents', () => {
    test('throws a validation error when sessionId is missing', async () => {
      await expect(invoke(makeEvent('intakeActivateProjectAgents', {}))).rejects.toThrow(
        /sessionId/,
      );
    });

    test('activates by sessionId (the fabricator sourceProjectId key) and tags matchedBy sessionId', async () => {
      mockSessionLinkage();
      activateMock.mockResolvedValueOnce({
        activated: ['agent-a'],
        failed: [],
        alreadyActive: ['agent-b'],
      });

      const result = await invoke(
        makeEvent('intakeActivateProjectAgents', { sessionId: SESSION_ID }),
      );

      expect(activateMock).toHaveBeenCalledTimes(1);
      expect(activateMock).toHaveBeenCalledWith(SESSION_ID);
      expect(result).toEqual({
        activated: ['agent-a'],
        failed: [],
        alreadyActive: ['agent-b'],
        matchedBy: 'sessionId',
      });
    });

    test('falls back to the conversations-linked projectId when sessionId matches zero agents', async () => {
      mockSessionLinkage();
      activateMock
        .mockResolvedValueOnce({ activated: [], failed: [], alreadyActive: [] })
        .mockResolvedValueOnce({ activated: ['agent-a'], failed: [], alreadyActive: [] });

      const result = await invoke(
        makeEvent('intakeActivateProjectAgents', { sessionId: SESSION_ID }),
      );

      expect(activateMock).toHaveBeenNthCalledWith(1, SESSION_ID);
      expect(activateMock).toHaveBeenNthCalledWith(2, PROJECT_ID);
      expect(result).toEqual({
        activated: ['agent-a'],
        failed: [],
        alreadyActive: [],
        matchedBy: 'projectId',
      });
    });

    test('surfaces zero-activated explicitly with matchedBy null when both keys match nothing', async () => {
      mockSessionLinkage();
      activateMock.mockResolvedValue({ activated: [], failed: [], alreadyActive: [] });

      const result = await invoke(
        makeEvent('intakeActivateProjectAgents', { sessionId: SESSION_ID }),
      );

      expect(activateMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        activated: [],
        failed: [],
        alreadyActive: [],
        matchedBy: null,
      });
    });

    test('does not retry when no conversation row links a distinct projectId', async () => {
      // No conversation rows → linked projectId falls back to the sessionId
      // itself, so a second activation attempt would be identical: skip it.
      mockSessionLinkage({ conversationItems: [] });
      activateMock.mockResolvedValueOnce({ activated: [], failed: [], alreadyActive: [] });

      const result = await invoke(
        makeEvent('intakeActivateProjectAgents', { sessionId: SESSION_ID }),
      );

      expect(activateMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ matchedBy: null });
    });

    test('finds the linked conversation row beyond the first Scan page', async () => {
      // Dev-observed latent bug: Scan's Limit caps items EVALUATED (pre-
      // filter), so with >Limit rows in the table the single-page lookup
      // usually returned zero matches. The lookup must follow
      // LastEvaluatedKey until the linked row is found.
      const lastKey = { projectId: 'other-proj', timestamp: '2026-01-01T00:00:00Z' };
      ddbMock
        .on(ScanCommand, { TableName: 'citadel-conversations-test' })
        .resolvesOnce({ Items: [], LastEvaluatedKey: lastKey })
        .resolvesOnce({ Items: [{ projectId: PROJECT_ID }] });
      ddbMock
        .on(GetCommand, { TableName: 'citadel-projects-test' })
        .resolves({ Item: { id: PROJECT_ID, name: 'Alpha', organization: ORG_ID } });
      activateMock
        .mockResolvedValueOnce({ activated: [], failed: [], alreadyActive: [] })
        .mockResolvedValueOnce({ activated: ['agent-a'], failed: [], alreadyActive: [] });

      const result = await invoke(
        makeEvent('intakeActivateProjectAgents', { sessionId: SESSION_ID }),
      );

      // Pagination proof: the second page request continues from the first
      // page's LastEvaluatedKey rather than restarting or stopping.
      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls).toHaveLength(2);
      expect(scanCalls[0].args[0].input.ExclusiveStartKey).toBeUndefined();
      expect(scanCalls[1].args[0].input.ExclusiveStartKey).toEqual(lastKey);
      // The row found on page 2 drives the projectId fallback activation.
      expect(activateMock).toHaveBeenNthCalledWith(2, PROJECT_ID);
      expect(result).toMatchObject({ matchedBy: 'projectId' });
    });
  });

  // ─── intakeCreateApp ─────────────────────────────────────────────────

  describe('intakeCreateApp', () => {
    test('derives orgId server-side and stamps sourceProjectId with the sessionId', async () => {
      mockSessionLinkage();
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789', name: 'My App' });

      const result = await invoke(
        makeEvent('intakeCreateApp', {
          sessionId: SESSION_ID,
          name: 'My App',
          description: 'Desc',
          // A hostile caller cannot smuggle scoping fields:
          orgId: 'org-evil',
          sourceProjectId: 'proj-evil',
        }),
      );

      expect(createAppMock).toHaveBeenCalledWith(
        {
          orgId: ORG_ID,
          name: 'My App',
          description: 'Desc',
          sourceProjectId: SESSION_ID,
        },
        IAM_IDENTITY.userArn,
      );
      expect(result).toEqual({ appId: 'rec123456789', name: 'My App' });
    });

    test("falls back to the project owner's Cognito custom:organization when the project row is org-less", async () => {
      // Dev-observed root cause: project-resolver writes
      // `organization: userOrganization || undefined`, so users without the
      // custom:organization claim create org-less projects. Self-healing:
      // resolve the org the owner WOULD have carried, via AdminGetUser
      // (mirrors utils/auth-event.ts extractOrgFromEvent's fallback).
      mockSessionLinkage({ project: { id: PROJECT_ID, name: 'Alpha', owner: OWNER_SUB } });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'custom:organization', Value: 'org-owner' }],
      });
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789' });

      await invoke(makeEvent('intakeCreateApp', { sessionId: SESSION_ID, name: 'My App' }));

      const cognitoCalls = cognitoMock.commandCalls(AdminGetUserCommand);
      expect(cognitoCalls).toHaveLength(1);
      expect(cognitoCalls[0].args[0].input).toEqual({
        UserPoolId: 'us-west-2_testpool',
        Username: OWNER_SUB,
      });
      expect(createAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-owner' }),
        expect.any(String),
      );
    });

    test("falls back to 'default' when the owner carries no custom:organization claim", async () => {
      // Terminal behavior mirrors the Cognito-auth path for an org-less
      // caller: createApp (registry-agent-record-resolver.ts) never derives
      // or validates org, and the frontend sends the literal fallback
      // `selectedOrganization || 'default'` (AppBuilderWizard.tsx). A hard
      // throw here would make intake STRICTER than the UI path it delegates
      // to, which is exactly the dev failure being fixed.
      mockSessionLinkage({ project: { id: PROJECT_ID, name: 'Alpha', owner: OWNER_SUB } });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'email', Value: 'dev@example.com' }],
      });
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789' });

      await invoke(makeEvent('intakeCreateApp', { sessionId: SESSION_ID, name: 'My App' }));

      expect(createAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'default' }),
        expect.any(String),
      );
    });

    test("falls back to 'default' without a Cognito call when the project row has no owner", async () => {
      mockSessionLinkage({ project: { id: PROJECT_ID, name: 'Alpha' } });
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789' });

      await invoke(makeEvent('intakeCreateApp', { sessionId: SESSION_ID, name: 'My App' }));

      expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
      expect(createAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'default' }),
        expect.any(String),
      );
    });

    test('makes no Cognito call when the project row already carries an organization', async () => {
      mockSessionLinkage();
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789' });

      await invoke(makeEvent('intakeCreateApp', { sessionId: SESSION_ID, name: 'My App' }));

      expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
      expect(createAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID }),
        expect.any(String),
      );
    });

    test("falls back to 'default' when Cognito AdminGetUser itself fails", async () => {
      mockSessionLinkage({ project: { id: PROJECT_ID, name: 'Alpha', owner: OWNER_SUB } });
      cognitoMock.on(AdminGetUserCommand).rejects(new Error('UserNotFoundException'));
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789' });

      await invoke(makeEvent('intakeCreateApp', { sessionId: SESSION_ID, name: 'My App' }));

      expect(createAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'default' }),
        expect.any(String),
      );
    });

    test('throws a validation error when name is missing', async () => {
      await expect(
        invoke(makeEvent('intakeCreateApp', { sessionId: SESSION_ID })),
      ).rejects.toThrow(/name/);
      expect(createAppMock).not.toHaveBeenCalled();
    });

    test('neutralises HTML markup in the client-supplied name', async () => {
      mockSessionLinkage();
      createAppMock.mockResolvedValueOnce({ appId: 'rec123456789' });

      await invoke(
        makeEvent('intakeCreateApp', { sessionId: SESSION_ID, name: '  <b>App</b>  ' }),
      );

      expect(createAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: '&lt;b&gt;App&lt;/b&gt;' }),
        expect.any(String),
      );
    });
  });

  // ─── intakeCreateBlueprint (AWSJSON §7 normalization) ────────────────

  describe('intakeCreateBlueprint', () => {
    const DEFINITION_OBJ = {
      version: '1.0.0',
      nodes: [{ id: 'rec1', agentId: 'rec1', position: { x: 100, y: 200 }, configuration: {} }],
      edges: [],
    };

    function mockHappyCreate(): void {
      createWorkflowMock.mockResolvedValueOnce({ workflowId: 'wf-1', status: 'DRAFT' });
      publishWorkflowMock.mockResolvedValueOnce({ workflowId: 'wf-1', status: 'PUBLISHED' });
    }

    test('normalizes an object-shaped definition to a JSON string exactly once', async () => {
      mockSessionLinkage();
      mockHappyCreate();

      await invoke(
        makeEvent('intakeCreateBlueprint', {
          sessionId: SESSION_ID,
          name: 'BP',
          definition: DEFINITION_OBJ,
        }),
      );

      const input = createWorkflowMock.mock.calls[0][0];
      expect(typeof input.definition).toBe('string');
      expect(JSON.parse(input.definition as string)).toEqual(DEFINITION_OBJ);
      expect(input.isBlueprint).toBe(true);
      expect(input.orgId).toBe(ORG_ID);
    });

    test('passes a string-shaped definition through unchanged (no double-encoding)', async () => {
      mockSessionLinkage();
      mockHappyCreate();
      const asString = JSON.stringify(DEFINITION_OBJ);

      await invoke(
        makeEvent('intakeCreateBlueprint', {
          sessionId: SESSION_ID,
          name: 'BP',
          definition: asString,
        }),
      );

      const input = createWorkflowMock.mock.calls[0][0];
      expect(input.definition).toBe(asString);
    });

    test('returns PUBLISHED with blueprintId and nodeCount on success', async () => {
      mockSessionLinkage();
      mockHappyCreate();

      const result = await invoke(
        makeEvent('intakeCreateBlueprint', {
          sessionId: SESSION_ID,
          name: 'BP',
          definition: DEFINITION_OBJ,
        }),
      );

      expect(publishWorkflowMock).toHaveBeenCalledWith('wf-1', IAM_IDENTITY.userArn, expect.anything());
      expect(result).toEqual({
        ok: true,
        blueprintId: 'wf-1',
        status: 'PUBLISHED',
        nodeCount: 1,
        missing: [],
        errors: [],
      });
    });

    test('maps a missing-agent publish failure to AGENTS_SYNCING with the missing agentIds', async () => {
      mockSessionLinkage();
      createWorkflowMock.mockResolvedValueOnce({ workflowId: 'wf-1', status: 'DRAFT' });
      publishWorkflowMock.mockRejectedValueOnce(
        new Error(
          "Validation failed: workflow references agents that do not exist: node 'n1' -> agentId 'rec1'; node 'n2' -> agentId 'rec2'. " +
            'Map each node to an existing agent before publishing; the workflow remains DRAFT.',
        ),
      );

      const result = await invoke(
        makeEvent('intakeCreateBlueprint', {
          sessionId: SESSION_ID,
          name: 'BP',
          definition: DEFINITION_OBJ,
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        blueprintId: 'wf-1',
        status: 'AGENTS_SYNCING',
        missing: ['rec1', 'rec2'],
      });
    });

    test('maps a definition validation failure to VALIDATION_FAILED with errors', async () => {
      mockSessionLinkage();
      createWorkflowMock.mockRejectedValueOnce(
        new Error('Invalid workflow definition: definition.nodes must be an array'),
      );

      const result = await invoke(
        makeEvent('intakeCreateBlueprint', {
          sessionId: SESSION_ID,
          name: 'BP',
          definition: { nodes: 'nope' },
        }),
      );

      expect(publishWorkflowMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        blueprintId: null,
        status: 'VALIDATION_FAILED',
        errors: ['Invalid workflow definition: definition.nodes must be an array'],
      });
    });

    test('throws a validation error when definition is absent', async () => {
      await expect(
        invoke(makeEvent('intakeCreateBlueprint', { sessionId: SESSION_ID, name: 'BP' })),
      ).rejects.toThrow(/definition/);
      expect(createWorkflowMock).not.toHaveBeenCalled();
    });
  });

  // ─── intakeImportBlueprintToApp ──────────────────────────────────────

  describe('intakeImportBlueprintToApp', () => {
    const APP_ID = 'rec123456789';
    const BLUEPRINT_ID = 'wf-bp-1';

    function mockOrgOwnedRows(opts?: { appOrg?: string; blueprintOrg?: string; app?: null }): void {
      ddbMock
        .on(GetCommand, { TableName: 'citadel-apps-test', Key: { appId: APP_ID } })
        .resolves({
          Item:
            opts?.app === null
              ? undefined
              : { appId: APP_ID, orgId: opts?.appOrg ?? ORG_ID },
        });
      ddbMock
        .on(GetCommand, { TableName: 'citadel-workflows-test', Key: { workflowId: BLUEPRINT_ID } })
        .resolves({ Item: { workflowId: BLUEPRINT_ID, orgId: opts?.blueprintOrg ?? ORG_ID } });
    }

    test('rejects when the app belongs to a different organization', async () => {
      mockSessionLinkage();
      mockOrgOwnedRows({ appOrg: 'org-other' });

      await expect(
        invoke(
          makeEvent('intakeImportBlueprintToApp', {
            sessionId: SESSION_ID,
            blueprintId: BLUEPRINT_ID,
            appId: APP_ID,
          }),
        ),
      ).rejects.toThrow(/Access denied/);
      expect(importBlueprintMock).not.toHaveBeenCalled();
    });

    test('rejects when the blueprint belongs to a different organization', async () => {
      mockSessionLinkage();
      mockOrgOwnedRows({ blueprintOrg: 'org-other' });

      await expect(
        invoke(
          makeEvent('intakeImportBlueprintToApp', {
            sessionId: SESSION_ID,
            blueprintId: BLUEPRINT_ID,
            appId: APP_ID,
          }),
        ),
      ).rejects.toThrow(/Access denied/);
      expect(importBlueprintMock).not.toHaveBeenCalled();
    });

    test('rejects when the app does not exist', async () => {
      mockSessionLinkage();
      mockOrgOwnedRows({ app: null });

      await expect(
        invoke(
          makeEvent('intakeImportBlueprintToApp', {
            sessionId: SESSION_ID,
            blueprintId: BLUEPRINT_ID,
            appId: APP_ID,
          }),
        ),
      ).rejects.toThrow(/App not found/);
    });

    test('delegates to importBlueprint with an identity agentMapping', async () => {
      mockSessionLinkage();
      mockOrgOwnedRows();
      const imported = { workflowId: 'wf-new', status: 'DRAFT', appId: APP_ID };
      importBlueprintMock.mockResolvedValueOnce(imported);

      const result = await invoke(
        makeEvent('intakeImportBlueprintToApp', {
          sessionId: SESSION_ID,
          blueprintId: BLUEPRINT_ID,
          appId: APP_ID,
          name: 'Process Flow',
        }),
      );

      expect(importBlueprintMock).toHaveBeenCalledWith(
        BLUEPRINT_ID,
        APP_ID,
        'Process Flow',
        {},
        IAM_IDENTITY.userArn,
        expect.anything(),
      );
      expect(result).toBe(imported);
    });
  });
});
