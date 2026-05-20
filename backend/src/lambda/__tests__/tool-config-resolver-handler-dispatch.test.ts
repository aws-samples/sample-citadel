/**
 * Tests for the tool-config-resolver handler switch dispatch based on
 * REGISTRY_ENABLED (task 7.5).
 *
 * Verifies that the handler routes each GraphQL field to the correct
 * implementation (Registry vs DynamoDB) based on the feature flag, and
 * preserves the existing GraphQL response shape including integrationBindings
 * and dataStoreBindings.
 *
 * Validates: Requirements 4.6, 11.2, 11.3
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock RegistryService so we can observe which code path was taken.
// ---------------------------------------------------------------------------

const mockListResources = jest.fn();
const mockGetResource = jest.fn();
const mockCreateResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockDeleteResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSearchResources = jest.fn();
const mockSerializeCustomMetadata = jest.fn((meta: any) => JSON.stringify(meta));
const mockDeserializeCustomMetadata = jest.fn((json: string | null, defaults: any) => {
  if (!json) return defaults;
  try {
    return { ...defaults, ...JSON.parse(json) };
  } catch {
    return defaults;
  }
});
const mockToRegistryStatus = jest.fn((state: string) => {
  const map: Record<string, string> = { active: 'APPROVED', inactive: 'DEPRECATED', maintenance: 'DRAFT' };
  return map[state] || 'DEPRECATED';
});
const mockToInternalState = jest.fn((status: string) => {
  const map: Record<string, string> = { APPROVED: 'active', DEPRECATED: 'inactive', DRAFT: 'maintenance' };
  return map[status] || 'inactive';
});
const mockMapToToolConfig = jest.fn((record: any) => {
  const meta = record.customDescriptorContent
    ? (() => { try { return JSON.parse(record.customDescriptorContent); } catch { return {}; } })()
    : {};
  return {
    toolId: record.recordId,
    config: record.description || '',
    state: mockToInternalState(record.status),
    categories: meta.categories || [],
    integrationBindings: meta.integrationBindings || null,
    dataStoreBindings: meta.dataStoreBindings || null,
    createdAt: record.createdAt?.toISOString?.() ?? record.createdAt,
    updatedAt: record.updatedAt?.toISOString?.() ?? record.updatedAt,
  };
});

jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => 'test-registry',
    listResources: mockListResources,
    getResource: mockGetResource,
    createResource: mockCreateResource,
    updateResource: mockUpdateResource,
    deleteResource: mockDeleteResource,
    updateResourceStatus: mockUpdateResourceStatus,
    searchResources: mockSearchResources,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    toInternalState: mockToInternalState,
    mapToToolConfig: mockMapToToolConfig,
  })),
}));

import { handler, _resetRegistryService } from '../tool-config-resolver';

// ---------------------------------------------------------------------------

const makeEvent = (fieldName: string, args: any = {}) => ({
  info: { fieldName },
  arguments: args,
});

const sampleRegistryRecord = {
  recordId: 'tool-r1',
  name: 'RegistryTool',
  description: '{"name":"RegistryTool"}',
  status: 'APPROVED',
  customDescriptorContent: JSON.stringify({
    categories: ['cat1'],
    icon: 'icon.png',
    state: 'active',
    integrationBindings: [
      { integrationId: 'int1', integrationType: 'SLACK', direction: 'OUTPUT' },
    ],
    dataStoreBindings: [
      { dataStoreId: 'ds1', dataStoreType: 'S3', direction: 'BIDIRECTIONAL' },
    ],
  }),
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

describe('tool-config-resolver handler switch dispatch (task 7.5)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    dynamoMock.reset();
    jest.clearAllMocks();
    _resetRegistryService();
    process.env = {
      ...originalEnv,
      TOOLS_CONFIG_TABLE: 'test-tools-config',
      REGISTRY_ID: 'test-registry',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── REGISTRY_ENABLED=false: routes to DynamoDB ──────────────

  describe('when REGISTRY_ENABLED is false', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'false';
    });

    test('listToolConfigs uses DynamoDB scan', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            toolId: 't1',
            config: { name: 'T1' },
            state: 'active',
            integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK', direction: 'output' }],
            dataStoreBindings: [{ dataStoreId: 'ds1', dataStoreType: 'S3', direction: 'bidirectional' }],
          },
        ],
      });

      const result = await handler(makeEvent('listToolConfigs'));

      expect(mockListResources).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
      // GraphQL response shape: config is a JSON string
      expect(typeof result[0].config).toBe('string');
      // Bindings preserved (direction normalised to upper case by the resolver)
      expect(result[0].integrationBindings).toHaveLength(1);
      expect(result[0].integrationBindings[0].direction).toBe('OUTPUT');
      expect(result[0].dataStoreBindings).toHaveLength(1);
      expect(result[0].dataStoreBindings[0].direction).toBe('BIDIRECTIONAL');
    });

    test('getToolConfig uses DynamoDB GetItem', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: 't1',
          config: { name: 'T1' },
          state: 'active',
          integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
        },
      });

      const result = await handler(makeEvent('getToolConfig', { toolId: 't1' }));

      expect(mockGetResource).not.toHaveBeenCalled();
      expect(result?.toolId).toBe('t1');
      expect(typeof result?.config).toBe('string');
      // Bindings preserved in the response shape
      expect(result?.integrationBindings).toHaveLength(1);
    });

    test('createToolConfig uses DynamoDB Put', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createToolConfig', {
        input: {
          toolId: 'new',
          config: '{"name":"N"}',
          state: 'active',
          integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
        },
      }));

      expect(mockCreateResource).not.toHaveBeenCalled();
      expect(result.toolId).toBe('new');
      expect(typeof result.config).toBe('string');
      expect(result.integrationBindings).toHaveLength(1);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    test('updateToolConfig uses DynamoDB Put', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          toolId: 't1',
          config: '{"old":true}',
          state: 'active',
          createdAt: '2025-01-01',
        },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('updateToolConfig', {
        input: { toolId: 't1', config: '{"new":true}' },
      }));

      expect(mockUpdateResource).not.toHaveBeenCalled();
      expect(result.toolId).toBe('t1');
      expect(typeof result.config).toBe('string');
    });

    test('deleteToolConfig uses DynamoDB Delete', async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteToolConfig', { toolId: 't1' }));

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test('listIntegrationOperations is flag-independent', async () => {
      const result = await handler(makeEvent('listIntegrationOperations', { integrationType: 'SLACK' }));
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ─── REGISTRY_ENABLED=true: routes to Registry ──────────────

  describe('when REGISTRY_ENABLED is true', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'true';
    });

    test('listToolConfigs uses RegistryService.listResources (merged with DDB)', async () => {
      mockListResources.mockResolvedValue([sampleRegistryRecord]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('listToolConfigs'));

      expect(mockListResources).toHaveBeenCalledWith('tool');
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('tool-r1');
      // Bindings preserved in the GraphQL response shape from Registry mapping
      expect(result[0].integrationBindings).toHaveLength(1);
      expect(result[0].dataStoreBindings).toHaveLength(1);
    });

    test('getToolConfig uses RegistryService.getResource', async () => {
      mockGetResource.mockResolvedValue(sampleRegistryRecord);

      const result = await handler(makeEvent('getToolConfig', { toolId: 'tool-r1' }));

      expect(mockGetResource).toHaveBeenCalledWith('tool', 'tool-r1');
      expect(result?.toolId).toBe('tool-r1');
      expect(result?.integrationBindings).toHaveLength(1);
    });

    test('createToolConfig uses RegistryService.createResource', async () => {
      mockCreateResource.mockResolvedValue(sampleRegistryRecord);

      const result = await handler(makeEvent('createToolConfig', {
        input: {
          toolId: 'tool-r1',
          config: '{"name":"RegistryTool"}',
          integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
          dataStoreBindings: [{ dataStoreId: 'ds1', dataStoreType: 'S3' }],
        },
      }));

      expect(mockCreateResource).toHaveBeenCalled();
      expect(result.toolId).toBe('tool-r1');
      // GraphQL response preserves bindings
      expect(result.integrationBindings).toHaveLength(1);
      expect(result.dataStoreBindings).toHaveLength(1);
    });

    test('updateToolConfig uses RegistryService.updateResource', async () => {
      mockGetResource.mockResolvedValue(sampleRegistryRecord);
      mockUpdateResource.mockResolvedValue(sampleRegistryRecord);

      const result = await handler(makeEvent('updateToolConfig', {
        input: { toolId: 'tool-r1', categories: ['new-cat'] },
      }));

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.toolId).toBe('tool-r1');
    });

    test('deleteToolConfig uses RegistryService.deleteResource', async () => {
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await handler(makeEvent('deleteToolConfig', { toolId: 'tool-r1' }));

      expect(mockDeleteResource).toHaveBeenCalledWith('tool', 'tool-r1');
      expect(result.success).toBe(true);
    });

    test('listIntegrationOperations is flag-independent', async () => {
      const result = await handler(makeEvent('listIntegrationOperations', { integrationType: 'SLACK' }));
      expect(Array.isArray(result)).toBe(true);
      // Registry APIs should not have been called for this field
      expect(mockListResources).not.toHaveBeenCalled();
      expect(mockGetResource).not.toHaveBeenCalled();
    });
  });

  // ─── searchToolConfigs: Registry-only (per requirement 9.3) ─────

  describe('searchToolConfigs is always wired to Registry', () => {
    test('routes to RegistryService.searchResources regardless of flag', async () => {
      process.env.REGISTRY_ENABLED = 'true';
      mockSearchResources.mockResolvedValue([sampleRegistryRecord]);

      const result = await handler(makeEvent('searchToolConfigs', { query: 'test' }));

      expect(mockSearchResources).toHaveBeenCalledWith('tool', 'test');
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('tool-r1');
    });
  });

  // ─── Unknown field ──────────────────────────────────────────

  test('throws on unknown GraphQL field (flag off)', async () => {
    process.env.REGISTRY_ENABLED = 'false';
    await expect(handler(makeEvent('unknownField'))).rejects.toThrow('Unknown field');
  });

  test('throws on unknown GraphQL field (flag on)', async () => {
    process.env.REGISTRY_ENABLED = 'true';
    await expect(handler(makeEvent('unknownField'))).rejects.toThrow('Unknown field');
  });
});
