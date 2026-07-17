/**
 * Phase 3 Step 2 — AppsTable `#META` mirror writes.
 *
 * Asserts that every successful Registry create/update/delete in
 * registry-agent-record-resolver also fires the eventually-consistent
 * `apps-table-meta` helper for the matching `(appId, '#META')` row.
 *
 * Helper failures must NOT propagate (eventually-consistent contract). The
 * helpers themselves swallow errors and return false; this test fixes the
 * call sites so the OrgIndex projection (Step 3) stays current.
 */
// Env vars MUST be set BEFORE importing the resolver — see crud.test.ts.
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

type HandlerEvent = Parameters<typeof handler>[0];
type HandlerContext = Parameters<typeof handler>[1];
type HandlerCallback = Parameters<typeof handler>[2];

function makeEvent(fieldName: string, args: Record<string, unknown>, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as unknown as HandlerEvent;
}

function seedApp(opts: { version?: number; orgId?: string } = {}): void {
  seedMockRegistry('agent', 'app-1', {
    name: 'Test App',
    description: 'Test',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: 'app-1',
      manifest: {
        orgId: opts.orgId ?? 'org-1',
        version: opts.version ?? 1,
        status: 'DRAFT',
        workflowIds: [],
        agentBindings: [],
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

describe('registry-agent-record-resolver — AppsTable #META mirror writes', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ddbMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
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

  describe('createApp', () => {
    test('writes an UpdateCommand for the metadata row with full projection', async () => {
      const result = await handler(
        makeEvent('createApp', {
          input: {
            name: 'New App',
            description: 'A test app',
            orgId: 'org-1',
          },
        }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      // upsertAppMeta is now an UpdateCommand (not a Put) so it preserves
      // any attributes legacy writers may have set on the same row.
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metaUpdate = updateCalls.find(
        (c) =>
          c.args[0].input.TableName === 'citadel-apps-test' &&
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.appId === result.appId &&
          // Key must be appId only — no sortId in the key.
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.sortId === undefined,
      );
      expect(metaUpdate).toBeDefined();
      const values = metaUpdate!.args[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':v_orgId']).toBe('org-1');
      expect(values[':v_name']).toBe('New App');
      expect(values[':v_status']).toBe('DRAFT');
      expect(values[':v_version']).toBe(1);
      expect(values[':v_createdBy']).toBe('user-123');
      expect(values[':v_workflowIds']).toEqual([]);
      expect(typeof values[':v_createdAt']).toBe('string');
      expect(typeof values[':v_updatedAt']).toBe('string');
      // sortId is set as a data attribute (carried by the upsert), not as
      // part of the key.
      expect(values[':v_sortId']).toBe(APP_META_SORT_VALUE);
    });
  });

  describe('updateApp', () => {
    test('writes an UpdateCommand for the metadata row with only the changed fields', async () => {
      seedApp({ version: 1 });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, name: 'Renamed' },
        }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      // Find the AppsTable update keyed on appId only with no sortId in
      // the key — distinguishes it from any other UpdateCommand the
      // resolver may issue.
      const metaUpdate = updateCalls.find(
        (c) =>
          c.args[0].input.TableName === 'citadel-apps-test' &&
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.appId === 'app-1' &&
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.sortId === undefined,
      );
      expect(metaUpdate).toBeDefined();

      const values = metaUpdate!.args[0].input.ExpressionAttributeValues as Record<string, unknown>;
      // name was provided -> mirrored. status/description/routingConfig were
      // NOT provided -> must NOT be in the update.
      expect(values[':v_name']).toBe('Renamed');
      expect(values[':v_status']).toBeUndefined();
      expect(values[':v_description']).toBeUndefined();
      expect(values[':v_routingConfig']).toBeUndefined();
      // updatedAt and version are always written.
      expect(typeof values[':v_updatedAt']).toBe('string');
      expect(values[':v_version']).toBe(2);
    });

    test('mirrors a status change', async () => {
      seedApp({ version: 1 });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, status: 'APPROVED' },
        }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const metaUpdate = updateCalls.find(
        (c) =>
          c.args[0].input.TableName === 'citadel-apps-test' &&
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.appId === 'app-1' &&
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.sortId === undefined &&
          (c.args[0].input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[':v_status'] !==
            undefined,
      );
      expect(metaUpdate).toBeDefined();
      const values = metaUpdate!.args[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':v_status']).toBe('APPROVED');
      expect(values[':v_version']).toBe(2);
    });
  });

  describe('deleteApp', () => {
    test('writes a DeleteCommand for the metadata row keyed on appId only', async () => {
      seedApp();

      await handler(
        makeEvent('deleteApp', { appId: 'app-1' }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      const metaDelete = deleteCalls.find(
        (c) =>
          c.args[0].input.TableName === 'citadel-apps-test' &&
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.appId === 'app-1' &&
          // Key must be appId only — AppsTable has no sort key.
          (c.args[0].input.Key as Record<string, unknown> | undefined)?.sortId === undefined,
      );
      expect(metaDelete).toBeDefined();
    });
  });

  describe('eventually-consistent failure semantics', () => {
    test('createApp succeeds even if AppsTable UpdateCommand throws', async () => {
      ddbMock.on(UpdateCommand).rejects(new Error('AppsTable down'));

      // Helper swallows the error → handler must still resolve.
      await expect(
        handler(
          makeEvent('createApp', {
            input: { name: 'New App', orgId: 'org-1' },
          }),
          {} as HandlerContext,
          {} as HandlerCallback,
        ),
      ).resolves.toBeDefined();
    });

    test('deleteApp succeeds even if AppsTable DeleteCommand throws', async () => {
      seedApp();
      ddbMock.on(DeleteCommand).rejects(new Error('AppsTable down'));

      await expect(
        handler(
          makeEvent('deleteApp', { appId: 'app-1' }),
          {} as HandlerContext,
          {} as HandlerCallback,
        ),
      ).resolves.toBeDefined();
    });
  });
});
