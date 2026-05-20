/**
 * Property-based tests for agent READY status precondition.
 *
 * Property 10: Agent READY status precondition
 * **Validates: Requirements 5.3**
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../app-resolver';

// ── Helpers ─────────────────────────────────────────────────

function makeEvent(fieldName: string, args: any) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as any;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

const APP_ITEM = {
  appId: 'app-1',
  orgId: 'org-1',
  groupId: 'APP#app-1',
  sortId: 'METADATA',
  name: 'Test App',
  status: 'DRAFT',
  version: 1,
  workflowIds: [],
  createdBy: 'user-123',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const AGENT_BINDING_ITEM = {
  appId: 'app-1',
  groupId: 'APP#app-1',
  sortId: 'AGENT#agent-1',
  agentId: 'agent-1',
  status: 'DESIGN',
  addedAt: '2024-01-01T00:00:00.000Z',
};

// ── Generators ──────────────────────────────────────────────

/** Agent states that are NOT 'active' — READY transition must fail for these */
const nonActiveStateArb = fc.constantFrom('inactive', 'deleted', 'error', 'creating', 'pending', 'suspended');

/** All possible agent states including 'active' */
const agentStateArb = fc.constantFrom('active', 'inactive', 'deleted', 'error', 'creating', 'pending', 'suspended');

// ── Property 10: Agent READY status precondition ────────────

describe('Property 10: Agent READY status precondition', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AGENT_CONFIG_TABLE;
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * For any agent state that is 'active', updating the agent binding
   * status to READY should succeed (no error thrown).
   */
  it('READY transition succeeds when agent exists with state=active', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
        async (agentId) => {
          ddbMock.reset();
          ebMock.reset();
          cognitoMock.reset();
          mockCognitoOrg('org-1');
          ebMock.on(PutEventsCommand).resolves({});

          const binding = { ...AGENT_BINDING_ITEM, sortId: `AGENT#${agentId}`, agentId };

          // GetCommand #1: getApp returns app
          // GetCommand #2: agent lookup returns active agent
          ddbMock.on(GetCommand)
            .resolvesOnce({ Item: APP_ITEM })
            .resolvesOnce({ Item: { agentId, state: 'active', config: {} } });

          // QueryCommand #1: binding check returns binding
          // QueryCommand #2: getAppWithComponents after update
          ddbMock.on(QueryCommand)
            .resolvesOnce({ Items: [APP_ITEM, binding] })
            .resolvesOnce({ Items: [APP_ITEM, { ...binding, status: 'READY' }] });

          ddbMock.on(UpdateCommand).resolves({});

          const result = await handler(
            makeEvent('updateAgentBinding', {
              input: { appId: 'app-1', agentId, status: 'READY' },
            }),
            {} as any,
            {} as any,
          );

          expect(result).toBeDefined();
          expect(result.appId).toBe('app-1');
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * For any agent state that is NOT 'active', updating the agent binding
   * status to READY should throw an error.
   */
  it('READY transition fails when agent exists with non-active state', () => {
    return fc.assert(
      fc.asyncProperty(nonActiveStateArb, async (agentState) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-1');
        ebMock.on(PutEventsCommand).resolves({});

        // GetCommand #1: getApp returns app
        // GetCommand #2: agent lookup returns agent with non-active state
        ddbMock.on(GetCommand)
          .resolvesOnce({ Item: APP_ITEM })
          .resolvesOnce({ Item: { agentId: 'agent-1', state: agentState, config: {} } });

        // QueryCommand: binding check returns binding
        ddbMock.on(QueryCommand)
          .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] });

        await expect(
          handler(
            makeEvent('updateAgentBinding', {
              input: { appId: 'app-1', agentId: 'agent-1', status: 'READY' },
            }),
            {} as any,
            {} as any,
          ),
        ).rejects.toThrow('Agent must be active before it can be marked as ready');
      }),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * When the agent does not exist in the agents table (undefined),
   * the READY transition should fail with the same error.
   */
  it('READY transition fails when agent does not exist in agents table', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
        async (agentId) => {
          ddbMock.reset();
          ebMock.reset();
          cognitoMock.reset();
          mockCognitoOrg('org-1');
          ebMock.on(PutEventsCommand).resolves({});

          const binding = { ...AGENT_BINDING_ITEM, sortId: `AGENT#${agentId}`, agentId };

          // GetCommand #1: getApp returns app
          // GetCommand #2: agent lookup returns undefined (not found)
          ddbMock.on(GetCommand)
            .resolvesOnce({ Item: APP_ITEM })
            .resolvesOnce({ Item: undefined });

          // QueryCommand: binding check returns binding
          ddbMock.on(QueryCommand)
            .resolvesOnce({ Items: [APP_ITEM, binding] });

          await expect(
            handler(
              makeEvent('updateAgentBinding', {
                input: { appId: 'app-1', agentId, status: 'READY' },
              }),
              {} as any,
              {} as any,
            ),
          ).rejects.toThrow('Agent must be active before it can be marked as ready');
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * The core property: for any randomly generated agent state,
   * READY transition succeeds if and only if state === 'active'.
   */
  it('READY transition succeeds iff agent state is active', () => {
    return fc.assert(
      fc.asyncProperty(agentStateArb, async (agentState) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-1');
        ebMock.on(PutEventsCommand).resolves({});

        // GetCommand #1: getApp returns app
        // GetCommand #2: agent lookup returns agent with generated state
        ddbMock.on(GetCommand)
          .resolvesOnce({ Item: APP_ITEM })
          .resolvesOnce({ Item: { agentId: 'agent-1', state: agentState, config: {} } });

        // QueryCommand #1: binding check returns binding
        ddbMock.on(QueryCommand)
          .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
          .resolvesOnce({ Items: [APP_ITEM, { ...AGENT_BINDING_ITEM, status: 'READY' }] });

        ddbMock.on(UpdateCommand).resolves({});

        if (agentState === 'active') {
          // Should succeed
          const result = await handler(
            makeEvent('updateAgentBinding', {
              input: { appId: 'app-1', agentId: 'agent-1', status: 'READY' },
            }),
            {} as any,
            {} as any,
          );
          expect(result).toBeDefined();
          expect(result.appId).toBe('app-1');
        } else {
          // Should fail
          await expect(
            handler(
              makeEvent('updateAgentBinding', {
                input: { appId: 'app-1', agentId: 'agent-1', status: 'READY' },
              }),
              {} as any,
              {} as any,
            ),
          ).rejects.toThrow('Agent must be active before it can be marked as ready');
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ── Additional imports for Property 11 ──────────────────────
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

// ── Property 11: Publish precondition validation ────────────

describe('Property 11: Publish precondition validation', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.AWS_REGION = 'us-east-1';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    iamMock.reset();
    stsMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.AWS_REGION;
  });

  // ── Generators ──────────────────────────────────────────

  /** Generate a binding status — either READY or DESIGN */
  const bindingStatusArb = fc.constantFrom('READY', 'DESIGN');

  /** Generate a list of agent bindings with random statuses */
  const agentBindingsArb = fc.array(
    fc.record({
      agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
      status: bindingStatusArb,
    }),
    { minLength: 0, maxLength: 5 },
  ).map(bindings => {
    // Deduplicate by agentId
    const seen = new Set<string>();
    return bindings.filter(b => {
      if (seen.has(b.agentId)) return false;
      seen.add(b.agentId);
      return true;
    });
  });

  /** Generate config state: no schema, schema with valid values, schema with invalid values, schema with missing values */
  const configStateArb = fc.constantFrom(
    'no_schema',
    'schema_with_valid_values',
    'schema_with_invalid_values',
    'schema_without_values',
  );

  /** Generate whether PolicyManager succeeds or fails */
  const policySuccessArb = fc.boolean();

  // ── Helpers ─────────────────────────────────────────────

  const VALID_SCHEMA = {
    type: 'object',
    properties: {
      apiKey: { type: 'string' },
    },
    required: ['apiKey'],
  };

  function setupMocks(
    bindings: Array<{ agentId: string; status: string }>,
    configState: string,
    policySuccess: boolean,
  ) {
    // Cognito org
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: 'sub', Value: 'user-123' },
        { Name: 'custom:organization', Value: 'org-1' },
      ],
    });

    // STS identity for PolicyManager
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: '123456789012',
      Arn: 'arn:aws:sts::123456789012:assumed-role/citadel-app-resolver-role/session',
    });

    // EventBridge always succeeds
    ebMock.on(PutEventsCommand).resolves({});

    // Build GroupIndex items
    const appItem = {
      ...APP_ITEM,
      status: 'DRAFT',
      version: 1,
    };

    const groupItems: any[] = [appItem];

    for (const b of bindings) {
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: `AGENT#${b.agentId}`,
        agentId: b.agentId,
        status: b.status,
        addedAt: '2024-01-01T00:00:00.000Z',
      });
    }

    if (configState === 'schema_with_valid_values') {
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: 'CONFIG#schema',
        schema: VALID_SCHEMA,
      });
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: 'CONFIG#values',
        values: { apiKey: 'sk-test-123' },
      });
    } else if (configState === 'schema_with_invalid_values') {
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: 'CONFIG#schema',
        schema: VALID_SCHEMA,
      });
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: 'CONFIG#values',
        values: { wrongField: 123 }, // Missing required 'apiKey'
      });
    } else if (configState === 'schema_without_values') {
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: 'CONFIG#schema',
        schema: VALID_SCHEMA,
      });
      // No CONFIG#values item
    }
    // 'no_schema' — no config items added

    // GetCommand: getApp returns DRAFT app
    ddbMock.on(GetCommand).resolves({ Item: appItem });

    // QueryCommand: GroupIndex query returns all components
    ddbMock.on(QueryCommand).resolves({ Items: groupItems });

    // PolicyManager IAM calls
    if (policySuccess) {
      iamMock.on(CreateRoleCommand).resolves({});
      iamMock.on(PutRolePolicyCommand).resolves({});
    } else {
      iamMock.on(CreateRoleCommand).rejects(new Error('IAM permission denied'));
    }

    // UpdateCommand for status change
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...appItem, status: 'ACTIVE', version: 2 },
    });
  }

  function allBindingsReady(bindings: Array<{ agentId: string; status: string }>): boolean {
    return bindings.every(b => b.status === 'READY');
  }

  function configValid(configState: string): boolean {
    return configState === 'no_schema' || configState === 'schema_with_valid_values';
  }

  function allPreconditionsHold(
    bindings: Array<{ agentId: string; status: string }>,
    configState: string,
    _policySuccess: boolean,
  ): boolean {
    // policySuccess is irrelevant when no permissions are declared (ensurePublishRole skips)
    return allBindingsReady(bindings) && configValid(configState);
  }

  /**
   * **Validates: Requirements 5.5, 7.6, 8.7**
   *
   * For any combination of agent binding statuses, config states, and
   * PolicyManager outcomes: DRAFT→ACTIVE succeeds iff ALL preconditions hold.
   */
  it('DRAFT→ACTIVE succeeds iff all preconditions hold', () => {
    return fc.assert(
      fc.asyncProperty(
        agentBindingsArb,
        configStateArb,
        policySuccessArb,
        async (bindings, configState, policySuccess) => {
          ddbMock.reset();
          ebMock.reset();
          cognitoMock.reset();
          iamMock.reset();
          stsMock.reset();

          setupMocks(bindings, configState, policySuccess);

          const shouldSucceed = allPreconditionsHold(bindings, configState, policySuccess);

          if (shouldSucceed) {
            const result = await handler(
              makeEvent('updateApp', {
                input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
              }),
              {} as any,
              {} as any,
            );
            expect(result).toBeDefined();
            expect(result.status).toBe('ACTIVE');
          } else {
            await expect(
              handler(
                makeEvent('updateApp', {
                  input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
                }),
                {} as any,
                {} as any,
              ),
            ).rejects.toThrow();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.5, 7.6, 8.7**
   *
   * When preconditions fail, the error message lists all failing preconditions.
   * Specifically: DESIGN agents are named, config issues are mentioned.
   */
  it('error lists all failing preconditions when publish is rejected', () => {
    return fc.assert(
      fc.asyncProperty(
        agentBindingsArb.filter(bs => bs.some(b => b.status === 'DESIGN')),
        fc.constantFrom('schema_without_values', 'schema_with_invalid_values'),
        async (bindings, configState) => {
          ddbMock.reset();
          ebMock.reset();
          cognitoMock.reset();
          iamMock.reset();
          stsMock.reset();

          // PolicyManager succeeds so we isolate agent + config failures
          setupMocks(bindings, configState, true);

          try {
            await handler(
              makeEvent('updateApp', {
                input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
              }),
              {} as any,
              {} as any,
            );
            // Should not reach here
            expect(true).toBe(false);
          } catch (error: any) {
            const msg = error.message;

            // Error should mention DESIGN agents
            const designAgents = bindings.filter(b => b.status === 'DESIGN');
            for (const agent of designAgents) {
              expect(msg).toContain(agent.agentId);
            }

            // Error should mention config issue
            expect(msg.toLowerCase()).toMatch(/config/);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 5.5, 7.6, 8.7**
   *
   * When PolicyManager fails but other preconditions pass,
   * the error mentions the role/policy failure.
   */
  it('error mentions PolicyManager failure when role creation fails', () => {
    return fc.assert(
      fc.asyncProperty(
        agentBindingsArb.filter(bs => bs.every(b => b.status === 'READY')),
        fc.constantFrom('no_schema', 'schema_with_valid_values'),
        async (bindings, configState) => {
          ddbMock.reset();
          ebMock.reset();
          cognitoMock.reset();
          iamMock.reset();
          stsMock.reset();

          // All preconditions pass except PolicyManager
          // We need permissions so ensurePublishRole actually attempts role creation
          setupMocks(bindings, configState, false);

          // Inject a PERMISSION item into the QueryCommand response so ensurePublishRole runs
          const currentHandler = ddbMock.commandCalls(QueryCommand);
          ddbMock.reset();
          // Re-setup mocks but manually add permission to group items
          cognitoMock.on(AdminGetUserCommand).resolves({
            UserAttributes: [
              { Name: 'sub', Value: 'user-123' },
              { Name: 'custom:organization', Value: 'org-1' },
            ],
          });
          stsMock.on(GetCallerIdentityCommand).resolves({
            Account: '123456789012',
            Arn: 'arn:aws:sts::123456789012:assumed-role/citadel-app-resolver-role/session',
          });
          ebMock.on(PutEventsCommand).resolves({});

          const appItem = {
            appId: 'app-1',
            orgId: 'org-1',
            groupId: 'APP#app-1',
            sortId: 'METADATA',
            name: 'Test App',
            status: 'DRAFT',
            version: 1,
            workflowIds: [],
            createdBy: 'user-123',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          };

          const groupItems: any[] = [appItem];
          for (const b of bindings) {
            groupItems.push({
              appId: 'app-1',
              groupId: 'APP#app-1',
              sortId: `AGENT#${b.agentId}`,
              agentId: b.agentId,
              status: b.status,
              addedAt: '2024-01-01T00:00:00.000Z',
            });
          }
          // Add a permission so ensurePublishRole actually runs
          groupItems.push({
            appId: 'app-1',
            groupId: 'APP#app-1',
            sortId: 'PERMISSION#perm-1',
            permissionId: 'perm-1',
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::bucket/*'],
          });

          if (configState === 'schema_with_valid_values') {
            groupItems.push({
              appId: 'app-1', groupId: 'APP#app-1', sortId: 'CONFIG#schema',
              schema: { type: 'object', properties: { apiKey: { type: 'string' } }, required: ['apiKey'] },
            });
            groupItems.push({
              appId: 'app-1', groupId: 'APP#app-1', sortId: 'CONFIG#values',
              values: { apiKey: 'sk-test-123' },
            });
          }

          ddbMock.on(GetCommand).resolves({ Item: appItem });
          ddbMock.on(QueryCommand).resolves({ Items: groupItems });
          iamMock.on(CreateRoleCommand).rejects(new Error('IAM permission denied'));
          ddbMock.on(UpdateCommand).resolves({
            Attributes: { ...appItem, status: 'ACTIVE', version: 2 },
          });

          await expect(
            handler(
              makeEvent('updateApp', {
                input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
              }),
              {} as any,
              {} as any,
            ),
          ).rejects.toThrow(/policy|permission|role/i);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── Additional imports for Property 17 ──────────────────────
import { DeleteRolePolicyCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';

// ── Property 17: Archive resets agent binding statuses ───────

describe('Property 17: Archive resets agent binding statuses', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    iamMock.reset();
    stsMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AGENT_CONFIG_TABLE;
  });

  // ── Generators ──────────────────────────────────────────

  /** Generate a binding status — either READY or DESIGN */
  const bindingStatusArb = fc.constantFrom('READY', 'DESIGN');

  /** Generate a list of agent bindings (0 to 5) with random statuses */
  const archiveBindingsArb = fc.array(
    fc.record({
      agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
      status: bindingStatusArb,
    }),
    { minLength: 0, maxLength: 5 },
  ).map(bindings => {
    // Deduplicate by agentId
    const seen = new Set<string>();
    return bindings.filter(b => {
      if (seen.has(b.agentId)) return false;
      seen.add(b.agentId);
      return true;
    });
  });

  // ── Helpers ─────────────────────────────────────────────

  const ACTIVE_APP = {
    appId: 'app-1',
    orgId: 'org-1',
    groupId: 'APP#app-1',
    sortId: 'METADATA',
    name: 'Test App',
    status: 'ACTIVE',
    version: 1,
    workflowIds: [],
    createdBy: 'user-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  function setupArchiveMocks(bindings: Array<{ agentId: string; status: string }>) {
    // Cognito org
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: 'sub', Value: 'user-123' },
        { Name: 'custom:organization', Value: 'org-1' },
      ],
    });

    // EventBridge always succeeds
    ebMock.on(PutEventsCommand).resolves({});

    // IAM deleteRole calls succeed
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});

    // Build GroupIndex items
    const groupItems: any[] = [ACTIVE_APP];
    for (const b of bindings) {
      groupItems.push({
        appId: 'app-1',
        groupId: 'APP#app-1',
        sortId: `AGENT#${b.agentId}`,
        agentId: b.agentId,
        status: b.status,
        addedAt: '2024-01-01T00:00:00.000Z',
      });
    }

    // GetCommand: getApp returns ACTIVE app
    ddbMock.on(GetCommand).resolves({ Item: ACTIVE_APP });

    // QueryCommand: GroupIndex query returns app + bindings
    ddbMock.on(QueryCommand).resolves({ Items: groupItems });

    // UpdateCommand succeeds
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...ACTIVE_APP, status: 'ARCHIVED', version: 2 },
    });
  }

  /**
   * **Validates: Requirements 8.8**
   *
   * For any app with N agent bindings (with random READY/DESIGN statuses)
   * transitioning from ACTIVE to ARCHIVED, the number of UpdateCommand calls
   * that reset binding status to DESIGN should equal exactly N (one per binding).
   */
  it('ACTIVE→ARCHIVED resets all agent bindings to DESIGN', () => {
    return fc.assert(
      fc.asyncProperty(archiveBindingsArb, async (bindings) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        iamMock.reset();
        stsMock.reset();

        setupArchiveMocks(bindings);

        const result = await handler(
          makeEvent('updateApp', {
            input: { appId: 'app-1', status: 'ARCHIVED', version: 1 },
          }),
          {} as any,
          {} as any,
        );

        expect(result).toBeDefined();

        // Count UpdateCommand calls that set status to DESIGN (binding resets)
        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        const bindingResetCalls = updateCalls.filter(call => {
          const input = call.args[0].input;
          return input.ExpressionAttributeValues?.[':designStatus'] === 'DESIGN';
        });

        // The number of binding reset calls should match the number of bindings
        expect(bindingResetCalls.length).toBe(bindings.length);
      }),
      { numRuns: 100 },
    );
  });
});
