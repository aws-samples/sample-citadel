/**
 * Unit tests for the registry-native AgentApp-shape resolver CRUD + list
 * operations. PR 6a replacement for `agent-app-shim-resolver.test.ts` and
 * `agent-app-shim-listapps.test.ts` (tests ported verbatim; only the import
 * path, describe label, and resolver file name differ).
 *
 * Registry-backed contract: the resolver reads and writes AgentApp state
 * through RegistryService's customDescriptorContent JSON. Tests seed records
 * via `seedApp()` → `seedMockRegistry('agent', 'app-1', { customDescriptorContent })`
 * then assert on (a) handler return-shape projection, (b) thrown errors, and
 * (c) EventBridge entries captured by `ebMock`.
 */
// Env vars MUST be set BEFORE `import { handler }` — the resolver captures
// EVENT_BUS_NAME / APPS_TABLE / DEFAULT_REGION at module-load time, so a
// `beforeAll` assignment would be too late.
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AWS_REGION = 'us-east-1';
// Leave AUTHORITY_UNITS_TABLE unset so grantFabricatorAuthority /
// revokeFabricatorAuthority become no-ops inside createApp / deleteApp and
// we do not need to mock a DynamoDB client for the authority write path.
delete process.env.AUTHORITY_UNITS_TABLE;

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  seedMockRegistry,
  resetMockRegistry,
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
import { APP_META_SORT_VALUE } from '../../utils/apps-table-meta';
import type { Context } from 'aws-lambda';

// Typed Lambda invocation stub — the resolver ignores context/callback, so a
// cast-through-unknown Context (plus a jest.fn() callback) keeps handler calls
// type-correct without `any` (mirrors seed-blueprints.test.ts convention).
const mockContext = {} as unknown as Context;

function makeEvent(fieldName: string, args: any, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as any;
}

/**
 * Event helper for callers who need the admin role claim to pass the
 * `listApps` "All Organizations" gate introduced by Phase 1 org-scoping.
 * Mirrors `makeEvent` but sets `custom:role = 'admin'` on the identity.
 */
function makeAdminEvent(fieldName: string, args: any, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      sub,
      'custom:role': 'admin',
      claims: { sub, 'custom:role': 'admin' },
    },
  } as any;
}

function seedApp(
  opts: {
    status?: string;
    version?: number;
    orgId?: string;
    manifest?: Record<string, any>;
  } = {},
): void {
  seedMockRegistry('agent', 'app-1', {
    name: 'Test App',
    description: 'Test',
    status: opts.status ?? 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: 'app-1',
      manifest: {
        orgId: opts.orgId ?? 'org-1',
        version: opts.version ?? 1,
        status: opts.status ?? 'DRAFT',
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        routingConfig: null,
        ...(opts.manifest ?? {}),
      },
    }),
  });
}

describe('registry-agent-record-resolver — CRUD', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    // Default DDB behaviour: meta-mirror writes succeed silently. listApps
    // tests override these with QueryCommand / ScanCommand mocks below.
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
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

  // ─── getApp ────────────────────────────────────────────────────

  describe('getApp', () => {
    test('returns item when caller orgId matches', async () => {
      seedApp({ orgId: 'org-1' });

      const result = await handler(
        makeEvent('getApp', { appId: 'app-1' }),
        mockContext,
        jest.fn(),
      );

      expect(result.appId).toBe('app-1');
      expect(result.name).toBe('Test App');
    });
  });

  // ─── listApps ──────────────────────────────────────────────────
  //
  // Phase 3: listApps reads from AppsTable.OrgIndex (GSI Query) for org-scoped
  // calls and ScanCommand+filter for the admin "All Organizations" path. The
  // tests below mock the DocumentClient directly — `seedAgentApp` (Registry)
  // is no longer relevant to the listApps read path.

  /** Build a metadata row as it would appear in the AppsTable / OrgIndex. */
  function metaRow(over: Partial<Record<string, any>> = {}): Record<string, any> {
    return {
      appId: 'app-1',
      sortId: APP_META_SORT_VALUE,
      orgId: 'org-1',
      name: 'App 1',
      description: '',
      status: 'DRAFT',
      workflowIds: [],
      routingConfig: '',
      createdBy: 'user-123',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      version: 1,
      ...over,
    };
  }

  describe('listApps — "All Organizations" scope', () => {
    test('returns every #META row regardless of orgId (admin caller, ScanCommand)', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          metaRow({ appId: 'app-1', orgId: 'org-a', name: 'App A' }),
          metaRow({ appId: 'app-2', orgId: 'org-b', name: 'App B' }),
          metaRow({ appId: 'app-3', orgId: 'org-c', name: 'App C' }),
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await handler(
        makeAdminEvent('listApps', { orgId: 'All Organizations' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toHaveLength(3);
      const ids = result.items.map((a: any) => a.appId).sort();
      expect(ids).toEqual(['app-1', 'app-2', 'app-3']);
      expect(result.nextToken).toBeNull();

      // Sanity: the admin path uses Scan, not Query.
      expect(ddbMock.commandCalls(ScanCommand).length).toBeGreaterThanOrEqual(1);
      expect(ddbMock.commandCalls(QueryCommand).length).toBe(0);
    });

    test('Scan is filtered to metadata rows only via FilterExpression', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

      await handler(
        makeAdminEvent('listApps', { orgId: 'All Organizations' }),
        mockContext,
        jest.fn(),
      );

      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls.length).toBe(1);
      const input = scanCalls[0].args[0].input as any;
      expect(input.TableName).toBe('citadel-apps-test');
      expect(input.FilterExpression).toBe('sortId = :meta');
      expect(input.ExpressionAttributeValues[':meta']).toBe(APP_META_SORT_VALUE);
    });

    test('returns empty items array when AppsTable is empty (admin caller)', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

      const result = await handler(
        makeAdminEvent('listApps', { orgId: 'All Organizations' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toEqual([]);
      expect(result.nextToken).toBeNull();
    });

    test('rejects non-admin callers with an "Only admins …" error (no DDB call)', async () => {
      await expect(
        handler(
          makeEvent('listApps', { orgId: 'All Organizations' }),
          mockContext,
          jest.fn(),
        ),
      ).rejects.toThrow(/Only admins/i);

      // Admin gate must short-circuit before any DDB read.
      expect(ddbMock.commandCalls(ScanCommand).length).toBe(0);
      expect(ddbMock.commandCalls(QueryCommand).length).toBe(0);
    });
  });

  describe('listApps — specific orgId scope', () => {
    test('queries OrgIndex for the requested orgId and returns the projected rows', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          metaRow({ appId: 'app-1', orgId: 'org-1', name: 'App 1' }),
          metaRow({ appId: 'app-2', orgId: 'org-1', name: 'App 2' }),
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toHaveLength(2);
      const ids = result.items.map((a: any) => a.appId).sort();
      expect(ids).toEqual(['app-1', 'app-2']);
      for (const app of result.items) {
        expect(app.orgId).toBe('org-1');
      }

      // Org-scoped path must use Query against OrgIndex, not Scan.
      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls.length).toBe(1);
      const input = queryCalls[0].args[0].input as any;
      expect(input.TableName).toBe('citadel-apps-test');
      expect(input.IndexName).toBe('OrgIndex');
      expect(input.KeyConditionExpression).toBe('orgId = :org');
      // OrgIndex GSI auto-excludes non-metadata rows by construction (they
      // lack `orgId` or `createdAt`), so no FilterExpression is needed.
      expect(input.FilterExpression).toBeUndefined();
      expect(input.ExpressionAttributeValues[':org']).toBe('org-1');
      expect(input.ExpressionAttributeValues[':meta']).toBeUndefined();
      expect(ddbMock.commandCalls(ScanCommand).length).toBe(0);
    });

    test('returns empty items when OrgIndex Query returns no rows', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-other' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toEqual([]);
      expect(result.nextToken).toBeNull();
    });

    test('each item is projected onto the listApps response shape', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          metaRow({
            appId: 'app-1',
            orgId: 'org-1',
            name: 'My App',
            status: 'DRAFT',
            version: 1,
            workflowIds: [],
          }),
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toHaveLength(1);
      const app = result.items[0];
      expect(app.appId).toBe('app-1');
      expect(app.orgId).toBe('org-1');
      expect(app.name).toBe('My App');
      expect(app.status).toBe('DRAFT');
      expect(app.version).toBe(1);
      expect(app.workflowIds).toEqual([]);
    });

    test('projects each #META row to the listApps response shape via metaRowToAppShape (defaults applied for missing fields)', async () => {
      // A sparse row simulating an old #META written before all fields existed.
      // metaRowToAppShape must fill in safe defaults so callers see a complete shape.
      ddbMock.on(QueryCommand).resolves({
        Items: [{ appId: 'sparse-1', sortId: APP_META_SORT_VALUE, orgId: 'org-1' }],
        LastEvaluatedKey: undefined,
      });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toHaveLength(1);
      const app = result.items[0];
      expect(app.appId).toBe('sparse-1');
      expect(app.orgId).toBe('org-1');
      expect(app.name).toBe('');
      expect(app.description).toBe('');
      expect(app.status).toBe('DRAFT');
      expect(app.workflowIds).toEqual([]);
      expect(app.routingConfig).toBe('');
      expect(app.createdBy).toBe('');
      expect(app.createdAt).toBe('');
      expect(app.updatedAt).toBe('');
      expect(app.version).toBe(1);
    });

    test('paginates via LastEvaluatedKey across multiple Query pages and concatenates items', async () => {
      const page1Cursor = { orgId: 'org-1', createdAt: '2025-01-01' };
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({
          Items: [metaRow({ appId: 'app-1', orgId: 'org-1', name: 'Page1 A' })],
          LastEvaluatedKey: page1Cursor,
        })
        .resolvesOnce({
          Items: [metaRow({ appId: 'app-2', orgId: 'org-1', name: 'Page2 A' })],
          LastEvaluatedKey: undefined,
        });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        mockContext,
        jest.fn(),
      );

      expect(result.items).toHaveLength(2);
      expect(result.items.map((a: any) => a.appId)).toEqual(['app-1', 'app-2']);
      // External cursor is not surfaced — pagination is fully drained internally.
      expect(result.nextToken).toBeNull();

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls.length).toBe(2);
      // First call has no cursor; second call carries the page1 cursor.
      expect((queryCalls[0].args[0].input as any).ExclusiveStartKey).toBeUndefined();
      expect((queryCalls[1].args[0].input as any).ExclusiveStartKey).toEqual(page1Cursor);
    });
  });

  // ─── createApp ─────────────────────────────────────────────────

  describe('createApp', () => {
    test('sets version=1, status=DRAFT, workflowIds=[], generates UUID', async () => {
      const result = await handler(
        makeEvent('createApp', {
          input: {
            name: 'New App',
            description: 'A test app',
            orgId: 'org-1',
          },
        }),
        mockContext,
        jest.fn(),
      );

      expect(result).toMatchObject({
        name: 'New App',
        orgId: 'org-1',
        status: 'DRAFT',
        version: 1,
        workflowIds: [],
      });
      expect(typeof result.appId).toBe('string');
    });

    test('emits app.created event', async () => {
      await handler(
        makeEvent('createApp', {
          input: { name: 'EB Test App', orgId: 'org-1' },
        }),
        mockContext,
        jest.fn(),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const createdEvents = allEntries.filter(
        (e) =>
          e?.DetailType === 'app.created' && e?.Source === 'citadel.apps',
      );
      expect(createdEvents.length).toBe(1);
    });
  });

  // ─── updateApp ─────────────────────────────────────────────────

  describe('updateApp', () => {
    test('succeeds with correct version (optimistic lock)', async () => {
      seedApp({ version: 1, orgId: 'org-1' });

      await expect(
        handler(
          makeEvent('updateApp', {
            input: { appId: 'app-1', version: 1, name: 'Updated Name' },
          }),
          mockContext,
          jest.fn(),
        ),
      ).resolves.toBeDefined();

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const updatedEvents = allEntries.filter(
        (e) => e?.DetailType === 'app.updated',
      );
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('throws conflict error when version is stale', async () => {
      seedApp({ version: 3 });

      await expect(
        handler(
          makeEvent('updateApp', {
            input: { appId: 'app-1', name: 'Stale', version: 1 },
          }),
          mockContext,
          jest.fn(),
        ),
      ).rejects.toThrow(/Conflict/);
    });

    test('emits app.updated event', async () => {
      seedApp({ version: 1 });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', name: 'Updated', version: 1 },
        }),
        mockContext,
        jest.fn(),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const updatedEvents = allEntries.filter(
        (e) => e?.DetailType === 'app.updated',
      );
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── deleteApp ─────────────────────────────────────────────────

  describe('deleteApp', () => {
    test('deletes and emits app.deleted', async () => {
      seedApp({ manifest: { workflowIds: ['wf-1', 'wf-2'] } });

      const result = await handler(
        makeEvent('deleteApp', { appId: 'app-1' }),
        mockContext,
        jest.fn(),
      );

      expect(result.success).toBe(true);

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const deletedEvents = allEntries.filter(
        (e) => e?.DetailType === 'app.deleted',
      );
      expect(deletedEvents.length).toBe(1);
    });

    test('emits app.deleted event on simple delete', async () => {
      seedApp();

      await handler(
        makeEvent('deleteApp', { appId: 'app-1' }),
        mockContext,
        jest.fn(),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const deletedEvents = allEntries.filter(
        (e) => e?.DetailType === 'app.deleted',
      );
      expect(deletedEvents.length).toBe(1);
    });
  });

  // ─── sourceProjectId propagation (US-ARB-017) ─────────────────

  describe('sourceProjectId propagation (US-ARB-017)', () => {
    test('projects sourceProjectId onto createApp result when provided', async () => {
      const result = await handler(
        makeEvent('createApp', {
          input: {
            name: 'Governed App',
            description: 'An app with a governance source',
            orgId: 'org-1',
            sourceProjectId: 'proj-1',
          },
        }),
        mockContext,
        jest.fn(),
      );

      expect(result.sourceProjectId).toBe('proj-1');
      expect(result.status).toBe('DRAFT');
      expect(result.version).toBe(1);
      expect(result.orgId).toBe('org-1');
    });

    test('returns sourceProjectId as null when not provided', async () => {
      const result = await handler(
        makeEvent('createApp', {
          input: {
            name: 'Ungoverned App',
            description: 'No source project',
            orgId: 'org-1',
          },
        }),
        mockContext,
        jest.fn(),
      );

      expect(result.sourceProjectId == null).toBe(true);
    });

    test('updateApp succeeds with sourceProjectId in input', async () => {
      seedApp({ version: 1 });

      await expect(
        handler(
          makeEvent('updateApp', {
            input: {
              appId: 'app-1',
              version: 1,
              sourceProjectId: 'proj-2',
            },
          }),
          mockContext,
          jest.fn(),
        ),
      ).resolves.toBeDefined();

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const updatedEvents = allEntries.filter(
        (e) => e?.DetailType === 'app.updated',
      );
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('updateApp succeeds without sourceProjectId (regression)', async () => {
      seedApp({ version: 1 });

      await expect(
        handler(
          makeEvent('updateApp', {
            input: {
              appId: 'app-1',
              name: 'Renamed',
              version: 1,
            },
          }),
          mockContext,
          jest.fn(),
        ),
      ).resolves.toBeDefined();

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const updatedEvents = allEntries.filter(
        (e) => e?.DetailType === 'app.updated',
      );
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
