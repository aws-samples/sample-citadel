/**
 * Unit tests for registry-native resolver access/auth surfaces.
 * PR 6a — covers setAppAuthConfig, grantAppAccess, revokeAppAccess, and
 * listAppAccessEntries. The first three mutate the registry manifest; the
 * last delegates to `app-access-control#listAppAccessEntries` (preserved
 * DDB-backed path) — we mock that helper to isolate the resolver's shape
 * wrapper from its storage backing.
 */

process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';
process.env.AWS_REGION = 'us-east-1';

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);

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

const mockListAppAccessEntriesImpl = jest.fn();
jest.mock('../app-access-control', () => ({
  listAppAccessEntries: (...args: unknown[]) => mockListAppAccessEntriesImpl(...args),
}));

import { handler } from '../registry-agent-record-resolver';

type HandlerEvent = Parameters<typeof handler>[0];
type HandlerContext = Parameters<typeof handler>[1];
type HandlerCallback = Parameters<typeof handler>[2];

function makeEvent(fieldName: string, args: Record<string, unknown>) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as unknown as HandlerEvent;
}

function seedApp(): void {
  seedMockRegistry('agent', 'app-1', {
    name: 'Test App',
    description: 'Test',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: 'app-1',
      manifest: {
        orgId: 'org-1',
        version: 1,
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

describe('registry-agent-record-resolver — access / auth surfaces', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    mockListAppAccessEntriesImpl.mockReset();
  });

  // ─── setAppAuthConfig ────────────────────────────────────────

  describe('setAppAuthConfig', () => {
    test('succeeds and emits app.auth.config.set event', async () => {
      seedApp();

      await handler(
        makeEvent('setAppAuthConfig', {
          appId: 'app-1',
          authConfig: JSON.stringify({ provider: 'cognito', userPoolId: 'up-1' }),
        }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const set = entries.find((e) => e?.DetailType === 'app.auth.config.set');
      expect(set).toBeDefined();
      expect(set!.Source).toBe('citadel.apps');
    });

    test('throws when app not found', async () => {
      await expect(
        handler(
          makeEvent('setAppAuthConfig', {
            appId: 'nonexistent',
            authConfig: JSON.stringify({ provider: 'cognito' }),
          }),
          {} as HandlerContext,
          {} as HandlerCallback,
        ),
      ).rejects.toThrow('App not found');
    });
  });

  // ─── grantAppAccess ───────────────────────────────────────────

  describe('grantAppAccess', () => {
    test('succeeds and emits app.access.granted event with grantedBy user id', async () => {
      seedApp();

      await handler(
        makeEvent('grantAppAccess', {
          appId: 'app-1',
          userId: 'target-user',
          role: 'editor',
        }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const granted = entries.find((e) => e?.DetailType === 'app.access.granted');
      expect(granted).toBeDefined();

      const detail = JSON.parse(granted!.Detail!);
      expect(detail.appId).toBe('app-1');
      expect(detail.userId).toBe('target-user');
      expect(detail.role).toBe('editor');
      expect(detail.grantedBy).toBe('user-123');
    });

    test('throws when app not found', async () => {
      await expect(
        handler(
          makeEvent('grantAppAccess', {
            appId: 'nonexistent',
            userId: 'target-user',
            role: 'editor',
          }),
          {} as HandlerContext,
          {} as HandlerCallback,
        ),
      ).rejects.toThrow('App not found');
    });
  });

  // ─── revokeAppAccess ──────────────────────────────────────────

  describe('revokeAppAccess', () => {
    test('succeeds and emits app.access.revoked event with revokedBy user id', async () => {
      seedApp();

      await handler(
        makeEvent('revokeAppAccess', {
          appId: 'app-1',
          userId: 'target-user',
        }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const revoked = entries.find((e) => e?.DetailType === 'app.access.revoked');
      expect(revoked).toBeDefined();

      const detail = JSON.parse(revoked!.Detail!);
      expect(detail.appId).toBe('app-1');
      expect(detail.userId).toBe('target-user');
      expect(detail.revokedBy).toBe('user-123');
    });

    test('throws when app not found', async () => {
      await expect(
        handler(
          makeEvent('revokeAppAccess', {
            appId: 'nonexistent',
            userId: 'target-user',
          }),
          {} as HandlerContext,
          {} as HandlerCallback,
        ),
      ).rejects.toThrow('App not found');
    });
  });

  // ─── listAppAccessEntries ────────────────────────────────────

  describe('listAppAccessEntries', () => {
    test('delegates to app-access-control#listAppAccessEntries with the deps struct', async () => {
      const entries = [
        { userId: 'u1', role: 'editor', grantedBy: 'admin', grantedAt: '2024-01-01T00:00:00Z' },
        { userId: 'u2', role: 'viewer', grantedBy: 'admin', grantedAt: '2024-01-02T00:00:00Z' },
      ];
      mockListAppAccessEntriesImpl.mockResolvedValueOnce(entries);

      const result = await handler(
        makeEvent('listAppAccessEntries', { appId: 'app-1' }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      expect(result).toEqual(entries);
      expect(mockListAppAccessEntriesImpl).toHaveBeenCalledTimes(1);
      const call = mockListAppAccessEntriesImpl.mock.calls[0];
      expect(call[0]).toBe('app-1');
      // Second arg is the shared deps struct containing docClient + appsTable.
      expect(call[1]).toEqual(
        expect.objectContaining({ appsTable: 'citadel-apps-test' }),
      );
    });

    test('returns empty array when no access entries exist', async () => {
      mockListAppAccessEntriesImpl.mockResolvedValueOnce([]);

      const result = await handler(
        makeEvent('listAppAccessEntries', { appId: 'app-empty' }),
        {} as HandlerContext,
        {} as HandlerCallback,
      );

      expect(result).toEqual([]);
    });
  });
});
