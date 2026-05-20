/**
 * Tests for Registry-backed CRUD functions in tool-config-resolver (tasks 7.2–7.6)
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 9.3, 11.2, 11.3, 12.3, 12.4, 13.3
 */
import {
  listToolConfigsRegistry,
  getToolConfigRegistry,
  createToolConfigRegistry,
  updateToolConfigRegistry,
  deleteToolConfigRegistry,
  _resetRegistryService,
  handler,
} from '../tool-config-resolver';

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------

const mockCreateResource = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockDeleteResource = jest.fn();
const mockListResources = jest.fn();
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
const mockMapToAgentConfig = jest.fn((record: any) => ({
  agentId: record.recordId,
  config: record.description || '',
  state: 'active',
  categories: [],
  createdAt: record.createdAt?.toISOString?.() ?? record.createdAt,
  updatedAt: record.updatedAt?.toISOString?.() ?? record.updatedAt,
}));

jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => 'test-registry',
    createResource: mockCreateResource,
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    deleteResource: mockDeleteResource,
    listResources: mockListResources,
    updateResourceStatus: mockUpdateResourceStatus,
    searchResources: mockSearchResources,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    toInternalState: mockToInternalState,
    mapToToolConfig: mockMapToToolConfig,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
}));

// Mock DynamoDB for fallback paths
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
const dynamoMock = mockClient(DynamoDBDocumentClient);

describe('Registry-backed CRUD functions (tasks 7.2–7.6)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: 'true',
      REGISTRY_ID: 'test-registry',
      TOOLS_CONFIG_TABLE: 'test-tools',
    };
    _resetRegistryService();
    jest.clearAllMocks();
    dynamoMock.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  // ─── listToolConfigsRegistry (task 7.2) ─────────────────────

  describe('listToolConfigsRegistry', () => {
    test('merges Registry and DynamoDB records', async () => {
      mockListResources.mockResolvedValue([
        { recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: '{}' },
      ]);
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't2', config: { name: 'Tool2' }, state: 'active' },
        ],
      });

      const result = await listToolConfigsRegistry();
      expect(result).toHaveLength(2);
      expect(result[0].toolId).toBe('t1');
      expect(result[1].toolId).toBe('t2');
    });

    test('Registry wins on duplicate toolIds', async () => {
      mockListResources.mockResolvedValue([
        { recordId: 't1', name: 'RegistryTool', description: '{"name":"Registry"}', status: 'APPROVED', customDescriptorContent: '{}' },
      ]);
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't1', config: { name: 'DynamoTool' }, state: 'active' },
        ],
      });

      const result = await listToolConfigsRegistry();
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
      // The mapped config comes from Registry
      expect(mockMapToToolConfig).toHaveBeenCalled();
    });

    test('returns only DynamoDB records when Registry is empty', async () => {
      mockListResources.mockResolvedValue([]);
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't1', config: { name: 'Tool1' }, state: 'active' },
        ],
      });

      const result = await listToolConfigsRegistry();
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
    });

    test('returns only Registry records when DynamoDB is empty', async () => {
      mockListResources.mockResolvedValue([
        { recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: '{}' },
      ]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await listToolConfigsRegistry();
      expect(result).toHaveLength(1);
    });
  });

  // ─── getToolConfigRegistry (task 7.3) ───────────────────────

  describe('getToolConfigRegistry', () => {
    test('returns Registry record when found', async () => {
      mockGetResource.mockResolvedValue({
        recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: '{}',
      });

      const result = await getToolConfigRegistry('t1');
      expect(result).toBeDefined();
      expect(result!.toolId).toBe('t1');
      expect(mockGetResource).toHaveBeenCalledWith('tool', 't1');
    });

    test('falls back to DynamoDB when not in Registry', async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: 't1', config: { name: 'Tool1' }, state: 'active' },
      });

      const result = await getToolConfigRegistry('t1');
      expect(result).toBeDefined();
      expect(result!.toolId).toBe('t1');
    });

    test('returns null when not found in either source', async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({});

      const result = await getToolConfigRegistry('missing');
      expect(result).toBeNull();
    });
  });

  // ─── createToolConfigRegistry (task 7.4) ────────────────────

  describe('createToolConfigRegistry', () => {
    const baseRecord = {
      recordId: 'tool-1',
      name: 'TestTool',
      description: '{"name":"TestTool"}',
      status: 'DRAFT',
      customDescriptorContent: '{}',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };

    test('creates a Registry resource with serialized custom metadata', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"TestTool"}',
        state: 'active',
        categories: ['cat1'],
        icon: 'icon.png',
      });

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith({
        categories: ['cat1'],
        icon: 'icon.png',
        state: 'active',
        integrationBindings: undefined,
        dataStoreBindings: undefined,
        appId: undefined,
      });
      expect(mockCreateResource).toHaveBeenCalledWith('tool', 'tool-1', {
        name: 'TestTool',
        description: '{"name":"TestTool"}',
        customMetadata: expect.any(String),
      });
    });

    test('validates integrationBindings before Registry write', async () => {
      await expect(
        createToolConfigRegistry({
          toolId: 'tool-1',
          config: '{"name":"TestTool"}',
          integrationBindings: [{ integrationType: 'SLACK' }], // missing integrationId
        }),
      ).rejects.toThrow('integrationBinding missing required field "integrationId"');
    });

    test('validates dataStoreBindings before Registry write', async () => {
      await expect(
        createToolConfigRegistry({
          toolId: 'tool-1',
          config: '{"name":"TestTool"}',
          dataStoreBindings: [{ dataStoreId: 'ds1' }], // missing dataStoreType
        }),
      ).rejects.toThrow('dataStoreBinding missing required field "dataStoreType"');
    });

    test('updates status when initial state is provided', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"TestTool"}',
        state: 'active',
      });

      expect(mockToRegistryStatus).toHaveBeenCalledWith('active');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('tool', 'tool-1', 'APPROVED');
    });

    test('includes bindings in custom metadata', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"TestTool"}',
        integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
        dataStoreBindings: [{ dataStoreId: 'ds1', dataStoreType: 'S3' }],
      });

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
        dataStoreBindings: [{ dataStoreId: 'ds1', dataStoreType: 'S3' }],
      }));
    });

    test('returns mapped ToolConfig', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      const result = await createToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"TestTool"}',
      });

      expect(mockMapToToolConfig).toHaveBeenCalledWith(baseRecord);
      expect(result.toolId).toBe('tool-1');
    });
  });

  // ─── updateToolConfigRegistry (task 7.4) ────────────────────

  describe('updateToolConfigRegistry', () => {
    const existingRecord = {
      recordId: 'tool-1',
      name: 'ExistingTool',
      description: '{"name":"ExistingTool"}',
      status: 'APPROVED',
      customDescriptorContent: JSON.stringify({
        categories: ['old-cat'],
        icon: 'old-icon.png',
        state: 'active',
        integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
      }),
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };

    const updatedRecord = {
      ...existingRecord,
      updatedAt: new Date('2025-01-02'),
    };

    test('throws when tool not found in Registry', async () => {
      mockGetResource.mockResolvedValue(null);

      await expect(
        updateToolConfigRegistry({ toolId: 'missing' }),
      ).rejects.toThrow('Tool config not found: missing');
    });

    test('updates resource with merged metadata', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        categories: ['new-cat'],
      });

      expect(mockUpdateResource).toHaveBeenCalledWith('tool', 'tool-1', expect.objectContaining({
        customMetadata: expect.any(String),
      }));
    });

    test('updates Registry status when state changes', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        state: 'inactive',
      });

      expect(mockToRegistryStatus).toHaveBeenCalledWith('inactive');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('tool', 'tool-1', 'DEPRECATED');
    });

    test('does not update status when state is unchanged', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        categories: ['new-cat'],
      });

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test('preserves existing bindings when not provided in input', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        state: 'inactive',
      });

      // Should preserve existing integrationBindings from metadata
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        integrationBindings: [{ integrationId: 'int1', integrationType: 'SLACK' }],
      }));
    });

    test('validates new bindings before Registry write', async () => {
      mockGetResource.mockResolvedValue(existingRecord);

      await expect(
        updateToolConfigRegistry({
          toolId: 'tool-1',
          integrationBindings: [{ integrationType: 'JIRA' }], // missing integrationId
        }),
      ).rejects.toThrow('integrationBinding missing required field "integrationId"');
    });

    test('returns mapped ToolConfig', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      const result = await updateToolConfigRegistry({
        toolId: 'tool-1',
        state: 'inactive',
      });

      expect(mockMapToToolConfig).toHaveBeenCalledWith(updatedRecord);
      expect(result.toolId).toBe('tool-1');
    });
  });

  // ─── deleteToolConfigRegistry (task 7.4) ────────────────────

  describe('deleteToolConfigRegistry', () => {
    test('returns success on successful delete', async () => {
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await deleteToolConfigRegistry('tool-1');

      expect(mockDeleteResource).toHaveBeenCalledWith('tool', 'tool-1');
      expect(result.success).toBe(true);
      expect(result.message).toContain('tool-1');
    });

    test('returns failure when delete throws', async () => {
      mockDeleteResource.mockRejectedValue(new Error('Registry error'));

      const result = await deleteToolConfigRegistry('tool-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed');
    });
  });

  // ─── Handler dispatch (task 7.5) ────────────────────────────

  describe('handler dispatch with REGISTRY_ENABLED=true', () => {
    test('listToolConfigs dispatches to Registry path', async () => {
      mockListResources.mockResolvedValue([]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('listToolConfigs', {}));
      expect(mockListResources).toHaveBeenCalledWith('tool');
      expect(result).toEqual([]);
    });

    test('getToolConfig dispatches to Registry path', async () => {
      mockGetResource.mockResolvedValue({
        recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: '{}',
      });

      const result = await handler(makeEvent('getToolConfig', { toolId: 't1' }));
      expect(mockGetResource).toHaveBeenCalledWith('tool', 't1');
      expect(result.toolId).toBe('t1');
    });

    test('listIntegrationOperations still works unchanged', async () => {
      const result = await handler(makeEvent('listIntegrationOperations', { integrationType: 'SLACK' }));
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('handler dispatch with REGISTRY_ENABLED=false', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'false';
    });

    test('listToolConfigs dispatches to DynamoDB path', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ toolId: 't1', config: { name: 'Tool1' }, state: 'active' }],
      });

      const result = await handler(makeEvent('listToolConfigs', {}));
      expect(mockListResources).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    test('getToolConfig dispatches to DynamoDB path', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: 't1', config: { name: 'Tool1' }, state: 'active' },
      });

      const result = await handler(makeEvent('getToolConfig', { toolId: 't1' }));
      expect(mockGetResource).not.toHaveBeenCalled();
      expect(result.toolId).toBe('t1');
    });
  });

  // ─── Search handlers (task 7.6) ─────────────────────────────

  describe('searchToolConfigs handler', () => {
    test('calls searchResources with tool type and returns mapped results', async () => {
      mockSearchResources.mockResolvedValue([
        { recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: '{}' },
      ]);

      const result = await handler(makeEvent('searchToolConfigs', { query: 'test' }));
      expect(mockSearchResources).toHaveBeenCalledWith('tool', 'test');
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
    });

    test('returns empty array when no results', async () => {
      mockSearchResources.mockResolvedValue([]);

      const result = await handler(makeEvent('searchToolConfigs', { query: 'nothing' }));
      expect(result).toEqual([]);
    });
  });
});
