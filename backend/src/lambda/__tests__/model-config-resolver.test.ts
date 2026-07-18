/**
 * Tests for model-config-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

// Stub the event emitter: publishEvent is a spy so we can assert emission;
// createProjectEvent/EventTypes keep faithful (pure) behaviour so the resolver
// builds a real event object without touching EventBridge.
const mockPublishEvent = jest.fn();
jest.mock('../../utils/events', () => ({
  publishEvent: mockPublishEvent,
  createProjectEvent: (
    eventType: string,
    projectId: string,
    payload: unknown,
    correlationId?: string,
  ) => ({ eventType, projectId, payload, correlationId }),
  EventTypes: {
    MODEL_CONFIG_CHANGED: 'model.config.changed',
    MODEL_CATALOG_SYNC_REQUESTED: 'model.catalog.sync_requested',
  },
}));

import { handler } from '../model-config-resolver';

describe('model-config-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    mockPublishEvent.mockReset().mockResolvedValue(undefined);
    process.env.MODEL_CONFIG_TABLE = 'test-model-config';
    process.env.MODEL_CATALOG_TABLE = 'test-model-catalog';
  });

  afterEach(() => {
    delete process.env.MODEL_CONFIG_TABLE;
    delete process.env.MODEL_CATALOG_TABLE;
  });

  // isAdminFromEvent is the REAL implementation (not mocked): admin via the
  // cognito:groups claim, and once via custom:role, prove both shapes work.
  const adminIdentity = { username: 'admin-user', 'cognito:groups': ['admin'] };
  const nonAdminIdentity = { username: 'dev-user', 'cognito:groups': ['developer'] };

  const makeEvent = (fieldName: string, args: unknown, identity?: unknown) => ({
    info: { fieldName },
    arguments: args,
    identity,
  });

  // Generic placeholder catalog entries — NO real model ids.
  const catalogEntry = (modelKey: string, status: string): Record<string, unknown> => ({
    modelKey,
    provider: 'vendor',
    baseModelId: `${modelKey}-base`,
    status,
    modality: 'text',
    invocationMode: 'on_demand',
    supportsTools: true,
    supportsSystemPrompt: true,
    supportsStreaming: true,
    regionProfiles: { 'us-east-1': { available: true } },
  });

  describe('listModelCatalog', () => {
    test('returns the scanned catalog items with regionProfiles as-is', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          catalogEntry('vendor.model-standard', 'enabled'),
          catalogEntry('vendor.model-lite', 'disabled'),
        ],
      });

      const result = await handler(makeEvent('listModelCatalog', {}));

      expect(result).toHaveLength(2);
      expect(result[0].modelKey).toBe('vendor.model-standard');
      expect(result[0].regionProfiles).toEqual({ 'us-east-1': { available: true } });
    });

    test('returns an empty array when the catalog is empty', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const result = await handler(makeEvent('listModelCatalog', {}));
      expect(result).toEqual([]);
    });
  });

  describe('getModelConfig', () => {
    test('returns the stored config item', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          scope: 'platform',
          globalDefaultKey: 'vendor.model-standard',
          slotDefaults: {},
          orgDefaults: {},
          agentOverrides: {},
          localityMode: 'regional_preferred',
        },
      });

      const result = await handler(makeEvent('getModelConfig', { scope: 'platform' }));

      expect(result.scope).toBe('platform');
      expect(result.globalDefaultKey).toBe('vendor.model-standard');
      expect(result.localityMode).toBe('regional_preferred');
    });

    test('returns a default skeleton when absent', async () => {
      dynamoMock.on(GetCommand).resolves({});
      const result = await handler(makeEvent('getModelConfig', {}));
      expect(result).toEqual({
        scope: 'platform',
        globalDefaultKey: null,
        slotDefaults: {},
        orgDefaults: {},
        agentOverrides: {},
        localityMode: 'off',
      });
    });
  });

  describe('updateModelConfig', () => {
    test('admin + enabled globalDefaultKey → puts, publishes, returns merged', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [catalogEntry('vendor.model-standard', 'enabled')],
      });
      dynamoMock.on(GetCommand).resolves({}); // no existing config → skeleton
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent(
          'updateModelConfig',
          { input: { globalDefaultKey: 'vendor.model-standard', localityMode: 'strict' } },
          adminIdentity,
        ),
      );

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
      expect(mockPublishEvent.mock.calls[0][0]).toMatchObject({
        eventType: 'model.config.changed',
        projectId: 'platform',
      });
      expect(result.globalDefaultKey).toBe('vendor.model-standard');
      expect(result.localityMode).toBe('strict');
      expect(result.updatedBy).toBe('admin-user');
      expect(result.updatedAt).toBeDefined();
    });

    test('validates every slotDefaults value against the catalog', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          catalogEntry('vendor.model-standard', 'enabled'),
          catalogEntry('vendor.model-fast', 'enabled'),
        ],
      });
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent(
          'updateModelConfig',
          { input: { slotDefaults: { chat: 'vendor.model-standard', code: 'vendor.model-fast' } } },
          adminIdentity,
        ),
      );

      expect(result.slotDefaults).toEqual({
        chat: 'vendor.model-standard',
        code: 'vendor.model-fast',
      });
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    test('non-admin → throws Only administrators (no write)', async () => {
      await expect(
        handler(
          makeEvent(
            'updateModelConfig',
            { input: { globalDefaultKey: 'vendor.model-standard' } },
            nonAdminIdentity,
          ),
        ),
      ).rejects.toThrow('Only administrators');
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('globalDefaultKey not in catalog → throws Unknown model', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [catalogEntry('vendor.model-standard', 'enabled')],
      });
      await expect(
        handler(
          makeEvent('updateModelConfig', { input: { globalDefaultKey: 'vendor.missing' } }, adminIdentity),
        ),
      ).rejects.toThrow('Unknown model: vendor.missing');
    });

    test('disabled model → throws Model not enabled', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [catalogEntry('vendor.model-standard', 'disabled')],
      });
      await expect(
        handler(
          makeEvent(
            'updateModelConfig',
            { input: { globalDefaultKey: 'vendor.model-standard' } },
            adminIdentity,
          ),
        ),
      ).rejects.toThrow('Model not enabled: vendor.model-standard');
    });

    test('invalid localityMode → throws', async () => {
      await expect(
        handler(makeEvent('updateModelConfig', { input: { localityMode: 'bogus' } }, adminIdentity)),
      ).rejects.toThrow('Invalid localityMode');
    });
  });

  describe('setModelCatalogEntryStatus', () => {
    test('admin + valid status → puts, publishes, returns updated', async () => {
      dynamoMock.on(GetCommand).resolves({ Item: catalogEntry('vendor.model-standard', 'enabled') });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent(
          'setModelCatalogEntryStatus',
          { modelKey: 'vendor.model-standard', status: 'disabled' },
          adminIdentity,
        ),
      );

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
      expect(mockPublishEvent.mock.calls[0][0]).toMatchObject({
        eventType: 'model.config.changed',
        projectId: 'catalog',
      });
      expect(result.status).toBe('disabled');
      expect(result.modelKey).toBe('vendor.model-standard');
    });

    test('admin via custom:role is also authorised', async () => {
      dynamoMock.on(GetCommand).resolves({ Item: catalogEntry('vendor.model-standard', 'enabled') });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent(
          'setModelCatalogEntryStatus',
          { modelKey: 'vendor.model-standard', status: 'deprecated' },
          { username: 'role-admin', 'custom:role': 'admin' },
        ),
      );

      expect(result.status).toBe('deprecated');
    });

    test('invalid status → throws', async () => {
      await expect(
        handler(
          makeEvent(
            'setModelCatalogEntryStatus',
            { modelKey: 'vendor.model-standard', status: 'bogus' },
            adminIdentity,
          ),
        ),
      ).rejects.toThrow('Invalid status');
    });

    test('unknown modelKey → throws Unknown model', async () => {
      dynamoMock.on(GetCommand).resolves({});
      await expect(
        handler(
          makeEvent(
            'setModelCatalogEntryStatus',
            { modelKey: 'vendor.missing', status: 'enabled' },
            adminIdentity,
          ),
        ),
      ).rejects.toThrow('Unknown model: vendor.missing');
    });

    test('non-admin → throws Only administrators (no write)', async () => {
      await expect(
        handler(
          makeEvent(
            'setModelCatalogEntryStatus',
            { modelKey: 'vendor.model-standard', status: 'enabled' },
            nonAdminIdentity,
          ),
        ),
      ).rejects.toThrow('Only administrators');
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe('syncModelCatalog', () => {
    test('admin → publishes sync_requested and returns triggered', async () => {
      const result = await handler(makeEvent('syncModelCatalog', {}, adminIdentity));

      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
      expect(mockPublishEvent.mock.calls[0][0]).toMatchObject({
        eventType: 'model.catalog.sync_requested',
        projectId: 'catalog',
        payload: { requestedBy: 'admin-user' },
      });
      expect(result).toEqual({
        triggered: true,
        message: 'Model catalog sync started',
      });
    });

    test('non-admin → throws and does not publish', async () => {
      await expect(
        handler(makeEvent('syncModelCatalog', {}, nonAdminIdentity)),
      ).rejects.toThrow('Only administrators can trigger a model catalog sync');
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
