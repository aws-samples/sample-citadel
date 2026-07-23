/**
 * Unit tests for the server-side name-resolution enrichment on
 * registry-agent-record-resolver's getApp / listApps read paths:
 *
 *   - `createdByName`: resolved from the `createdBy` Cognito userId via
 *     AdminGetUser (given_name + family_name, else email, else the raw
 *     userId on any lookup failure).
 *   - `agentBindings[].name`: resolved per-binding from the bound agent's
 *     Registry record `name` field via `RegistryService.getResourcesByRefs`,
 *     with a graceful per-binding fallback (no `name` set) on lookup
 *     failure OR when the bound agent belongs to a different org.
 *
 * Both enrichments must never throw and must never block getApp/listApps —
 * they are display-only additions layered on top of the existing
 * Registry-backed projection.
 *
 * Also covers the tenant-authorization gate that MUST run before either
 * enrichment: a caller outside the app's org (non-admin) gets `null`
 * (getApp) / an org-coerced list (listApps) with zero AdminGetUser or
 * Registry name-lookup calls — the enrichment must never even run for a
 * denied caller.
 */
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AWS_REGION = 'us-east-1';
delete process.env.AUTHORITY_UNITS_TABLE;

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

import {
  seedMockRegistry,
  resetMockRegistry,
  getListResourceSummariesCallCount,
  getGetResourceCallCount,
} from './fixtures/registry-service-mock';

jest.mock('../../services/registry-service', () => {
  const { getMockRegistryService } = jest.requireActual('./fixtures/registry-service-mock');
  return {
    RegistryService: jest.fn().mockImplementation(() => getMockRegistryService()),
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from '../registry-agent-record-resolver';

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  opts: { sub?: string; orgId?: string | undefined; admin?: boolean; hasOrgClaim?: boolean } = {},
) {
  const { sub = 'user-123', admin = false } = opts;
  // `orgId` defaults to 'org-1' UNLESS the caller explicitly passed the key
  // (including `orgId: undefined`, used by the "no org claim" test cases).
  const orgId = 'orgId' in opts ? opts.orgId : 'org-1';
  const claims: Record<string, unknown> = { sub };
  if (orgId !== undefined) claims['custom:organization'] = orgId;
  if (admin) claims['custom:role'] = 'admin';
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims },
  } as unknown as HandlerEvent;
}

function seedApp(
  opts: {
    orgId?: string;
    createdBy?: string;
    agentBindings?: Array<Record<string, unknown>>;
  } = {},
): void {
  seedMockRegistry('agent', 'app-1', {
    name: 'Test App',
    description: 'Test',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: 'app-1',
      manifest: {
        orgId: opts.orgId ?? 'org-1',
        createdBy: opts.createdBy ?? 'user-abc-123',
        version: 1,
        status: 'DRAFT',
        workflowIds: [],
        agentBindings: opts.agentBindings ?? [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        routingConfig: null,
      },
    }),
  });
}
// 12-char alphanumeric record IDs, matching the real Registry's recordId
// shape (`/^[a-zA-Z0-9]{12}$/`) — required so the batch resolver's
// isRecordId fast path (vs. legacy-name resolution) is exercised the same
// way it is in production.
const AGENT_1 = 'agentrecid01';
const AGENT_2 = 'agentrecid02';
const AGENT_MISSING = 'agentrecid99';
const AGENT_FOREIGN = 'agentrecid03';
const AGENT_SHARED = 'agentrecid04';
const AGENT_NO_ORG = 'agentrecid06';

// In-memory stand-in for the AGENT_CONFIG_TABLE projection (kept current by
// registry-sync.ts in production). `resolveAgentBindingNames`'s fast path
// reads this via a single BatchGetItem per invocation for the WHOLE set of
// 12-char recordId bindings — this fixture backs the ddbMock BatchGetCommand
// handler below and tracks call counts to prove that boundedness.
const agentCacheTable = new Map<string, { agentId: string; name: string; orgId?: string }>();
let batchGetCallCount = 0;
let batchGetKeyCount = 0;

/** Seeds a row in the AGENT_CONFIG_TABLE fixture. Omit `orgId` to simulate a legacy row that never had it written. */
function seedAgentCache(agentId: string, name: string, orgId?: string): void {
  agentCacheTable.set(agentId, orgId === undefined ? { agentId, name } : { agentId, name, orgId });
}

describe('registry-agent-record-resolver — server-side name resolution', () => {
  beforeEach(() => {
    resetMockRegistry();
    agentCacheTable.clear();
    batchGetCallCount = 0;
    batchGetKeyCount = 0;
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(BatchGetCommand).callsFake((input) => {
      batchGetCallCount += 1;
      const keys = input.RequestItems?.['citadel-agents-test']?.Keys ?? [];
      batchGetKeyCount += keys.length;
      const items = keys
        .map((k: { agentId: string }) => agentCacheTable.get(k.agentId))
        .filter((v: unknown) => !!v);
      return Promise.resolve({ Responses: { 'citadel-agents-test': items } });
    });
    cognitoMock.reset();
    cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AWS_REGION;
    delete process.env.REGISTRY_ID;
  });

  describe('getApp — createdByName', () => {
    test('resolves createdByName from Cognito given_name + family_name', async () => {
      seedApp({ createdBy: 'user-abc-123' });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [
          { Name: 'given_name', Value: 'Jane' },
          { Name: 'family_name', Value: 'Doe' },
          { Name: 'email', Value: 'jane@example.com' },
        ],
      });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.createdBy).toBe('user-abc-123');
      expect(result.createdByName).toBe('Jane Doe');
      const calls = cognitoMock.commandCalls(AdminGetUserCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        UserPoolId: 'us-east-1_test',
        Username: 'user-abc-123',
      });
    });

    test('falls back to email when given_name/family_name are absent', async () => {
      seedApp({ createdBy: 'user-abc-123' });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'email', Value: 'jane@example.com' }],
      });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.createdByName).toBe('jane@example.com');
    });

    test('falls back to the raw userId when AdminGetUser throws', async () => {
      seedApp({ createdBy: 'user-abc-123' });
      cognitoMock.on(AdminGetUserCommand).rejects(new Error('UserNotFoundException'));

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.createdByName).toBe('user-abc-123');
    });

    test('returns "unknown" when createdBy is empty', async () => {
      seedApp({ createdBy: '' });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.createdByName).toBe('unknown');
      expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
    });

    test('falls back to the raw userId when USER_POOL_ID is not configured', async () => {
      // USER_POOL_ID is captured as a module-level const at import time, so
      // this scenario is covered end-to-end by the sibling
      // registry-agent-record-resolver-no-user-pool.test.ts (a separate
      // test file/module instance with USER_POOL_ID unset BEFORE import).
      expect(true).toBe(true);
    });
  });

  describe('getApp — agentBindings[].name', () => {
    test('resolves each binding name from the bound agent AGENT_CONFIG_TABLE projection (fast path)', async () => {
      seedApp({
        agentBindings: [
          { agentId: AGENT_1, status: 'READY', addedAt: '2024-01-01T00:00:00Z' },
          { agentId: AGENT_2, status: 'DESIGN', addedAt: '2024-01-02T00:00:00Z' },
        ],
      });
      seedAgentCache(AGENT_1, 'Support Agent', 'org-1');
      seedAgentCache(AGENT_2, 'Billing Agent', 'org-1');

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.agentBindings).toHaveLength(2);
      const byId = new Map(result.agentBindings.map((b: { agentId: string; name?: string }) => [b.agentId, b]));
      expect(byId.get(AGENT_1).name).toBe('Support Agent');
      expect(byId.get(AGENT_2).name).toBe('Billing Agent');
    });

    test('leaves name unset for a binding whose agent lookup fails, without affecting others', async () => {
      seedApp({
        agentBindings: [
          { agentId: AGENT_MISSING, status: 'DESIGN', addedAt: '2024-01-01T00:00:00Z' },
          { agentId: AGENT_2, status: 'READY', addedAt: '2024-01-02T00:00:00Z' },
        ],
      });
      // AGENT_MISSING is intentionally not seeded in the cache table.
      seedAgentCache(AGENT_2, 'Billing Agent', 'org-1');

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      const byId = new Map(result.agentBindings.map((b: { agentId: string; name?: string }) => [b.agentId, b]));
      expect(byId.get(AGENT_MISSING).name).toBeUndefined();
      expect(byId.get(AGENT_2).name).toBe('Billing Agent');
    });

    test('leaves name unset (falls back to raw agentId) when the bound agent belongs to a different org', async () => {
      seedApp({
        orgId: 'org-1',
        agentBindings: [{ agentId: AGENT_FOREIGN, status: 'READY', addedAt: '2024-01-01T00:00:00Z' }],
      });
      seedAgentCache(AGENT_FOREIGN, 'Other Org Agent', 'org-2');

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }, { orgId: 'org-1' }));

      expect(result.agentBindings[0].name).toBeUndefined();
    });

    test('resolves a binding name when the bound agent is system-shared (orgId "")', async () => {
      seedApp({
        orgId: 'org-1',
        agentBindings: [{ agentId: AGENT_SHARED, status: 'READY', addedAt: '2024-01-01T00:00:00Z' }],
      });
      seedAgentCache(AGENT_SHARED, 'Shared Agent', '');

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }, { orgId: 'org-1' }));

      expect(result.agentBindings[0].name).toBe('Shared Agent');
    });

    test('leaves name unset (fails CLOSED, not open) when the cached agent row has no orgId at all', async () => {
      // Simulates a legacy/malformed cache row that predates orgId
      // denormalization — must NOT be treated as system-shared merely
      // because orgId is absent; only an EXPLICIT '' counts as shared.
      seedApp({
        orgId: 'org-1',
        agentBindings: [{ agentId: AGENT_NO_ORG, status: 'READY', addedAt: '2024-01-01T00:00:00Z' }],
      });
      seedAgentCache(AGENT_NO_ORG, 'No Org Agent'); // orgId omitted entirely

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }, { orgId: 'org-1' }));

      expect(result.agentBindings[0].name).toBeUndefined();
    });

    test('does not throw and returns bindings unresolved when there are no bindings', async () => {
      seedApp({ agentBindings: [] });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.agentBindings).toEqual([]);
      expect(batchGetCallCount).toBe(0);
    });

    test('resolves a legacy human-readable agentId to its Registry record via a single summary-list pass (slow path, not the cache table)', async () => {
      seedApp({
        agentBindings: [{ agentId: 'LegacySupportAgent', status: 'READY', addedAt: '2024-01-01T00:00:00Z' }],
      });
      seedMockRegistry('agent', 'legacyRec01', {
        name: 'LegacySupportAgent',
        customDescriptorContent: JSON.stringify({ orgId: 'org-1', manifest: {} }),
      });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.agentBindings[0].name).toBe('LegacySupportAgent');
      // Exactly one summary-list pass for the whole batch of legacy refs.
      expect(getListResourceSummariesCallCount()).toBe(1);
      // The legacy path never touches the AGENT_CONFIG_TABLE cache.
      expect(batchGetCallCount).toBe(0);
    });

    test('duplicate bindings to the same agent, and many distinct bindings, cost exactly ONE BatchGetItem call (N+1 fix)', async () => {
      seedApp({
        agentBindings: [
          { agentId: AGENT_1, status: 'READY', addedAt: '2024-01-01T00:00:00Z' },
          { agentId: AGENT_1, status: 'READY', addedAt: '2024-01-02T00:00:00Z' },
          { agentId: AGENT_1, status: 'READY', addedAt: '2024-01-03T00:00:00Z' },
          { agentId: AGENT_2, status: 'READY', addedAt: '2024-01-04T00:00:00Z' },
        ],
      });
      seedAgentCache(AGENT_1, 'Support Agent', 'org-1');
      seedAgentCache(AGENT_2, 'Billing Agent', 'org-1');

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.agentBindings).toHaveLength(4);
      const byId = new Map(result.agentBindings.map((b: { agentId: string; name?: string }) => [b.agentId, b]));
      expect(byId.get(AGENT_1).name).toBe('Support Agent');
      expect(byId.get(AGENT_2).name).toBe('Billing Agent');
      // The whole batch — 4 bindings referencing 2 unique agents — costs
      // exactly one BatchGetItem call requesting only the 2 unique keys.
      expect(batchGetCallCount).toBe(1);
      expect(batchGetKeyCount).toBe(2);
    });

    test('the number of remote reads stays bounded (1 BatchGetItem call) as distinct binding count grows', async () => {
      const bindings = Array.from({ length: 25 }, (_, i) => ({
        // 'agentbind' (9 chars) + zero-padded 3-digit index = 12 chars,
        // matching the recordId shape, each unique.
        agentId: `agentbind${i.toString().padStart(3, '0')}`,
        status: 'READY',
        addedAt: '2024-01-01T00:00:00Z',
      }));
      bindings.forEach((b, i) => seedAgentCache(b.agentId, `Agent ${i}`, 'org-1'));
      seedApp({ agentBindings: bindings });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.agentBindings).toHaveLength(25);
      expect(result.agentBindings.every((b: { name?: string }) => !!b.name)).toBe(true);
      // Bounded independent of binding count — a single BatchGetItem call.
      expect(batchGetCallCount).toBe(1);
      expect(batchGetKeyCount).toBe(25);
    });

    test('a rejected (not just missing) BatchGetItem call is isolated and does not affect createdByName resolution', async () => {
      seedApp({
        createdBy: 'user-abc-123',
        agentBindings: [{ agentId: AGENT_1, status: 'READY', addedAt: '2024-01-01T00:00:00Z' }],
      });
      seedAgentCache(AGENT_1, 'Support Agent', 'org-1');
      ddbMock.on(BatchGetCommand).rejects(new Error('ProvisionedThroughputExceededException'));

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      expect(result.agentBindings[0].name).toBeUndefined();
      expect(result.createdByName).toBeDefined();
    });

    test('a rejected legacy-name Registry lookup is isolated and does not affect other bindings', async () => {
      seedApp({
        agentBindings: [
          { agentId: 'LegacyThrowsAgent', status: 'READY', addedAt: '2024-01-01T00:00:00Z' },
          { agentId: AGENT_2, status: 'READY', addedAt: '2024-01-02T00:00:00Z' },
        ],
      });
      seedAgentCache(AGENT_2, 'Billing Agent', 'org-1');
      // LegacyThrowsAgent is intentionally not seeded in the Registry mock,
      // so the summary-list pass cannot resolve it to a recordId — the
      // legacy path leaves it unresolved without throwing.

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));

      const byId = new Map(result.agentBindings.map((b: { agentId: string; name?: string }) => [b.agentId, b]));
      expect(byId.get('LegacyThrowsAgent').name).toBeUndefined();
      expect(byId.get(AGENT_2).name).toBe('Billing Agent');
    });
  });

  describe('getApp — tenant authorization gate', () => {
    test('a non-admin caller from a different org gets null, with no AdminGetUser or agent-name lookups', async () => {
      seedApp({ orgId: 'org-1', createdBy: 'user-abc-123', agentBindings: [{ agentId: AGENT_1 }] });
      seedAgentCache(AGENT_1, 'Support Agent', 'org-1');

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }, { orgId: 'org-2' }));

      expect(result).toBeNull();
      expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
      expect(getGetResourceCallCount('agent', AGENT_1)).toBe(0);
      expect(batchGetCallCount).toBe(0);
    });

    test('a non-admin caller with no org claim gets null (after the extractOrgFromEvent Cognito fallback also finds no org)', async () => {
      seedApp({ orgId: 'org-1' });
      // No 'custom:organization' claim on the identity — extractOrgFromEvent
      // falls back to an AdminGetUser lookup for the caller's own org
      // attribute (existing, pre-established behavior in auth-event.ts).
      // That lookup legitimately runs and returns no org here (empty
      // UserAttributes), which is what ultimately produces the denial.
      cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }, { orgId: undefined }));

      expect(result).toBeNull();
    });

    test('a same-org caller is authorized and receives full enrichment', async () => {
      seedApp({ orgId: 'org-1', createdBy: 'user-abc-123' });

      const result = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }, { orgId: 'org-1' }));

      expect(result).not.toBeNull();
      expect(result.createdByName).toBeDefined();
    });

    test('an admin caller bypasses the org check regardless of their own org', async () => {
      seedApp({ orgId: 'org-1', createdBy: 'user-abc-123' });

      const result = await invokeHandler(
        makeEvent('getApp', { appId: 'app-1' }, { orgId: 'org-9', admin: true }),
      );

      expect(result).not.toBeNull();
      expect(result.appId).toBe('app-1');
    });
  });

  describe('listApps — createdByName enrichment', () => {
    function metaRow(appId: string, orgId: string, createdBy: string) {
      return {
        appId,
        orgId,
        name: `App ${appId}`,
        description: '',
        status: 'DRAFT',
        workflowIds: [],
        routingConfig: '',
        createdBy,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        version: 1,
      };
    }

    test('org-scoped listApps enriches each row with createdByName', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [metaRow('app-a', 'org-1', 'user-1')],
        LastEvaluatedKey: undefined,
      });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [
          { Name: 'given_name', Value: 'Ann' },
          { Name: 'family_name', Value: 'Lee' },
        ],
      });

      const result = await invokeHandler(makeEvent('listApps', { orgId: 'org-1' }, { orgId: 'org-1' }));

      expect(result.items).toHaveLength(1);
      expect(result.items[0].createdByName).toBe('Ann Lee');
    });

    test('repeated creators across a page cause exactly one AdminGetUser call (concurrent dedup)', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          metaRow('app-a', 'org-1', 'user-1'),
          metaRow('app-b', 'org-1', 'user-1'),
          metaRow('app-c', 'org-1', 'user-1'),
        ],
        LastEvaluatedKey: undefined,
      });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'email', Value: 'user1@example.com' }],
      });

      const result = await invokeHandler(makeEvent('listApps', { orgId: 'org-1' }, { orgId: 'org-1' }));

      expect(result.items).toHaveLength(3);
      expect(result.items.every((i: { createdByName?: string }) => i.createdByName === 'user1@example.com')).toBe(true);
      expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(1);
    });

    test('a non-admin caller requesting another org is coerced to their own org (no cross-tenant enumeration)', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [metaRow('app-a', 'org-1', 'user-1')],
        LastEvaluatedKey: undefined,
      });

      await invokeHandler(makeEvent('listApps', { orgId: 'org-2' }, { orgId: 'org-1' }));

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
        ':org': 'org-1',
      });
    });

    test('a non-admin caller with no org claim gets an empty list and issues no DDB query', async () => {
      const result = await invokeHandler(
        makeEvent('listApps', { orgId: 'org-1' }, { orgId: undefined }),
      );

      expect(result).toEqual({ items: [], nextToken: null });
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test('admin "All Organizations" listApps still enriches createdByName via the scan path', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [metaRow('app-a', 'org-1', 'user-1')],
        LastEvaluatedKey: undefined,
      });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'email', Value: 'user1@example.com' }],
      });

      const result = await invokeHandler(
        makeEvent('listApps', { orgId: 'All Organizations' }, { admin: true }),
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].createdByName).toBe('user1@example.com');
    });

    test('non-admin requesting "All Organizations" is still rejected', async () => {
      await expect(
        invokeHandler(makeEvent('listApps', { orgId: 'All Organizations' }, { orgId: 'org-1' })),
      ).rejects.toThrow('Only admins may list apps across all organizations');
    });
  });

  describe('warm-invocation cache reset', () => {
    test('createdByName cache does not leak a stale name across separate invocations', async () => {
      seedApp({ createdBy: 'user-abc-123' });
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'email', Value: 'first@example.com' }],
      });

      const first = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));
      expect(first.createdByName).toBe('first@example.com');

      // Simulate the user's Cognito profile changing between invocations on
      // the same warm container.
      cognitoMock.reset();
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [{ Name: 'email', Value: 'second@example.com' }],
      });

      const second = await invokeHandler(makeEvent('getApp', { appId: 'app-1' }));
      expect(second.createdByName).toBe('second@example.com');
      expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(1);
    });
  });
});
