/**
 * Identity-chain regression tests for registry-agent-record-resolver.
 *
 * Root cause under test: the AgentCore Registry assigns its OWN 12-char
 * recordId on createResource (the uuid the resolver passes in is discarded
 * — see registry-service.ts createResource). The resolver persists
 * everything (registry record, AppsTable #META mirror, authority unit,
 * app.created event) keyed by record.recordId, but `projectAgentAppShape`
 * lets the ORIGINAL UUID embedded in customDescriptorContent OVERRIDE the
 * projected appId. A caller that create-then-reads (e.g. importBlueprint's
 * GetItem on the returned appId) therefore misses deterministically:
 * "App not found".
 *
 * getApp already normalizes (`projected.appId = appId`). These tests pin
 * the same normalization onto createApp and every sibling mutation path
 * that returns a projection of a record whose descriptor may embed a
 * stale UUID.
 *
 * Unlike the shared fixtures/registry-service-mock (whose createResource
 * honours the caller-supplied id), the bespoke mock here mimics the REAL
 * registry: createResource ignores the passed id and assigns
 * REGISTRY_ASSIGNED_ID.
 */
// Env vars MUST be set BEFORE importing the resolver — module captures them
// at load time (see crud.test.ts).
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AWS_REGION = 'us-east-1';
// Keep authority grant/revoke as no-ops (no DDB mock needed for that path).
delete process.env.AUTHORITY_UNITS_TABLE;

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

/** The 12-char id the (mocked) registry assigns, ignoring the caller's uuid. */
const REGISTRY_ASSIGNED_ID = 'rec123456789';
/** Stale client-side UUID embedded in seeded descriptors for sweep tests. */
const STALE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

jest.mock('../../services/registry-service', () => {
  interface MockRegistryRecord {
    recordId: string;
    name?: string;
    description?: string;
    status?: string;
    customDescriptorContent?: string;
    createdAt?: Date;
    updatedAt?: Date;
  }
  const records = new Map<string, MockRegistryRecord>();
  const svc = {
    async getResource(type: string, id: string) {
      return records.get(`${type}:${id}`) ?? null;
    },
    async createResource(
      type: string,
      _callerId: string,
      input: { name?: string; description?: string; customMetadata?: string },
    ) {
      // Mimic the real registry: the caller-supplied id is DISCARDED and a
      // registry-assigned 12-char recordId is used instead.
      const record = {
        recordId: 'rec123456789',
        name: input.name,
        description: input.description,
        status: 'DRAFT',
        customDescriptorContent: input.customMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      records.set(`${type}:${record.recordId}`, record);
      return record;
    },
    async updateResource(
      type: string,
      id: string,
      input: { name?: string; description?: string; customMetadata?: string },
    ) {
      const existing = records.get(`${type}:${id}`);
      if (!existing) throw new Error(`Record not found: ${type}:${id}`);
      const updated = {
        ...existing,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.customMetadata !== undefined && {
          customDescriptorContent: input.customMetadata,
        }),
        recordId: id,
        updatedAt: new Date(),
      };
      records.set(`${type}:${id}`, updated);
      return updated;
    },
    async updateResourceStatus(type: string, id: string, status: string) {
      const existing = records.get(`${type}:${id}`);
      if (!existing) throw new Error(`Record not found: ${type}:${id}`);
      const updated = { ...existing, status, updatedAt: new Date() };
      records.set(`${type}:${id}`, updated);
      return updated;
    },
    async deleteResource(type: string, id: string) {
      records.delete(`${type}:${id}`);
    },
    async resolveRecordId(_type: string, id: string) {
      return id;
    },
  };
  class TypeMismatchError extends Error {}
  return {
    RegistryService: jest.fn().mockImplementation(() => svc),
    getRegistryService: jest.fn(() => svc),
    isRegistryEnabled: jest.fn(() => true),
    TypeMismatchError,
    __seed: (type: string, id: string, rec: MockRegistryRecord) => records.set(`${type}:${id}`, rec),
    __get: (type: string, id: string) => records.get(`${type}:${id}`),
    __reset: () => records.clear(),
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from '../registry-agent-record-resolver';
import type { Context } from 'aws-lambda';

import * as registryServiceMockedModule from '../../services/registry-service';

interface SeededRegistryRecord {
  recordId: string;
  name?: string;
  description?: string;
  status?: string;
  customDescriptorContent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// jest.mock above replaces the module, so this namespace import resolves to
// the mock factory's return value (which carries the __seed/__get/__reset
// test hooks not present on the real module's type).
const registryMock = registryServiceMockedModule as unknown as {
  __seed: (type: string, id: string, rec: SeededRegistryRecord) => void;
  __get: (type: string, id: string) => SeededRegistryRecord | undefined;
  __reset: () => void;
};

const mockContext = {} as unknown as Context;

type HandlerEvent = Parameters<typeof handler>[0];

function makeEvent(fieldName: string, args: Record<string, unknown>, sub = 'user-123'): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as unknown as HandlerEvent;
}

/**
 * Seeds a record whose recordId ('app-1') DIFFERS from the appId embedded
 * in its customDescriptorContent (a stale UUID) — the exact persisted state
 * a real createApp leaves behind.
 */
function seedAppWithStaleDescriptorId(manifest: Record<string, unknown> = {}): void {
  registryMock.__seed('agent', 'app-1', {
    recordId: 'app-1',
    name: 'Test App',
    description: 'Test',
    status: 'DRAFT',
    createdAt: new Date(),
    updatedAt: new Date(),
    customDescriptorContent: JSON.stringify({
      appId: STALE_UUID,
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
        ...manifest,
      },
    }),
  });
}

/** Returns the UpdateCommand calls that hit the AppsTable #META row. */
function metaUpdateCalls() {
  return ddbMock
    .commandCalls(UpdateCommand)
    .filter((c) => (c.args[0].input as { TableName?: string }).TableName === 'citadel-apps-test');
}

describe('registry-agent-record-resolver — appId identity chain', () => {
  beforeEach(() => {
    registryMock.__reset();
    ebMock.reset();
    ddbMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.REGISTRY_ID;
  });

  describe('createApp', () => {
    test('returns the registry-assigned recordId as appId, not the original UUID from customDescriptorContent', async () => {
      const result = (await handler(
        makeEvent('createApp', {
          input: { name: 'New App', description: 'A test app', orgId: 'org-1' },
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;

      // The persisted record's descriptor still embeds the original UUID.
      const persisted = registryMock.__get('agent', REGISTRY_ASSIGNED_ID);
      expect(persisted).toBeDefined();
      const descriptor = JSON.parse(persisted.customDescriptorContent);
      expect(descriptor.appId).not.toBe(REGISTRY_ASSIGNED_ID); // uuid, discarded by registry

      // The RETURNED appId must be the recordId — the key everything is
      // persisted under — not the descriptor's UUID.
      expect(result.appId).toBe(REGISTRY_ASSIGNED_ID);
      expect(result.appId).not.toBe(descriptor.appId);
    });

    test('returned appId agrees with the AppsTable #META mirror key', async () => {
      const result = (await handler(
        makeEvent('createApp', {
          input: { name: 'New App', description: 'A test app', orgId: 'org-1' },
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;

      const calls = metaUpdateCalls();
      expect(calls).toHaveLength(1);
      const mirrorKey = (calls[0].args[0].input as { Key: { appId?: string } }).Key.appId;
      expect(mirrorKey).toBe(REGISTRY_ASSIGNED_ID);
      // Create-then-import identity chain: the id handed back to the caller
      // must be the same id the mirror row is keyed by.
      expect(result.appId).toBe(mirrorKey);
    });

    test('logs an error with appId and tableName when the #META mirror write fails', async () => {
      ddbMock.on(UpdateCommand).rejects(new Error('provisioning boom'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await handler(
          makeEvent('createApp', {
            input: { name: 'New App', description: 'A test app', orgId: 'org-1' },
          }),
          mockContext,
          jest.fn(),
        );

        const mirrorFailureLogs = errorSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('#META mirror write failed'),
        );
        expect(mirrorFailureLogs).toHaveLength(1);
        expect(mirrorFailureLogs[0][1]).toEqual(
          expect.objectContaining({
            appId: REGISTRY_ASSIGNED_ID,
            tableName: 'citadel-apps-test',
          }),
        );
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('sibling mutation paths return recordId when the descriptor embeds a stale UUID', () => {
    test('updateApp', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('updateApp', { input: { appId: 'app-1', name: 'Renamed' } }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('bindWorkflowToApp (new binding)', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('bindWorkflowToApp', { appId: 'app-1', workflowId: 'wf-1' }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('bindWorkflowToApp (idempotent early return)', async () => {
      seedAppWithStaleDescriptorId({ workflowIds: ['wf-1'] });
      const result = (await handler(
        makeEvent('bindWorkflowToApp', { appId: 'app-1', workflowId: 'wf-1' }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('unbindWorkflowFromApp', async () => {
      seedAppWithStaleDescriptorId({ workflowIds: ['wf-1'] });
      const result = (await handler(
        makeEvent('unbindWorkflowFromApp', { appId: 'app-1', workflowId: 'wf-1' }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('updateAgentBinding', async () => {
      seedAppWithStaleDescriptorId({
        agentBindings: [{ agentId: 'agent-x', status: 'DESIGN' }],
      });
      const result = (await handler(
        makeEvent('updateAgentBinding', {
          input: { appId: 'app-1', agentId: 'agent-x', systemPromptAddition: 'hi' },
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('addAppComponent', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: { type: 'agent', data: JSON.stringify({ agentId: 'agent-y' }) },
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('removeAppComponent', async () => {
      seedAppWithStaleDescriptorId({
        agentBindings: [{ agentId: 'agent-x', status: 'DESIGN' }],
      });
      const result = (await handler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'agent',
          componentId: 'agent-x',
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('setAppConfigSchema', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify({ type: 'object' }),
          version: 1,
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('setAppConfigValues', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify({}),
          version: 1,
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('setAppAuthConfig', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('setAppAuthConfig', {
          appId: 'app-1',
          authConfig: JSON.stringify({ mode: 'NONE' }),
        }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('grantAppAccess', async () => {
      seedAppWithStaleDescriptorId();
      const result = (await handler(
        makeEvent('grantAppAccess', { appId: 'app-1', userId: 'user-2', role: 'viewer' }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });

    test('revokeAppAccess', async () => {
      seedAppWithStaleDescriptorId({
        access: { 'user-2': { role: 'viewer', grantedAt: 'x', grantedBy: 'y' } },
      });
      const result = (await handler(
        makeEvent('revokeAppAccess', { appId: 'app-1', userId: 'user-2' }),
        mockContext,
        jest.fn(),
      )) as Record<string, unknown>;
      expect(result.appId).toBe('app-1');
    });
  });
});
