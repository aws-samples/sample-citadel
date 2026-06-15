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
    orgId: meta.orgId ?? '',
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
  // Fixture identity that carries a tenant claim the same way AppSync
  // delivers it in production. Tests pass this to the registry-path
  // functions as the third arg so extractOrgFromEvent resolves without
  // falling back to Cognito.
  const eventWithOrg = {
    identity: { claims: { 'custom:organization': 'test-org-a' } },
  };

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

  const makeEvent = (fieldName: string, args: any, identity?: any) => ({
    info: { fieldName },
    arguments: args,
    identity: identity ?? {
      sub: 'test-user',
      claims: { 'custom:organization': 'test-org-a' },
    },
  });

  // ─── listToolConfigsRegistry (task 7.2) ─────────────────────

  describe('listToolConfigsRegistry', () => {
    test('merges Registry and DynamoDB records', async () => {
      mockListResources.mockResolvedValue([
        { recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }) },
      ]);
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't2', config: { name: 'Tool2' }, state: 'active', orgId: 'test-org-a' },
        ],
      });

      const result = await listToolConfigsRegistry(eventWithOrg);
      expect(result).toHaveLength(2);
      expect(result[0].toolId).toBe('t1');
      expect(result[1].toolId).toBe('t2');
    });

    test('Registry wins on duplicate toolIds', async () => {
      // Updated for 420d0ae name-based dedup: post-420d0ae, registry toolId is
      // a recordId (not the name), so dedupe now keys off config.name. The two
      // rows below share name "SharedTool" across Registry and DDB.
      mockListResources.mockResolvedValue([
        { recordId: 't1', name: 'SharedTool', description: '{"name":"SharedTool"}', status: 'APPROVED', customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }) },
      ]);
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't1', config: { name: 'SharedTool' }, state: 'active', orgId: 'test-org-a' },
        ],
      });

      const result = await listToolConfigsRegistry(eventWithOrg);
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
      // The mapped config comes from Registry
      expect(mockMapToToolConfig).toHaveBeenCalled();
    });

    test('returns only DynamoDB records when Registry is empty', async () => {
      mockListResources.mockResolvedValue([]);
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't1', config: { name: 'Tool1' }, state: 'active', orgId: 'test-org-a' },
        ],
      });

      const result = await listToolConfigsRegistry(eventWithOrg);
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
    });

    test('returns only Registry records when DynamoDB is empty', async () => {
      mockListResources.mockResolvedValue([
        { recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED', customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }) },
      ]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await listToolConfigsRegistry(eventWithOrg);
      expect(result).toHaveLength(1);
    });
  });

  // ─── getToolConfigRegistry (task 7.3) ───────────────────────

  describe('getToolConfigRegistry', () => {
    test('returns Registry record when found', async () => {
      mockGetResource.mockResolvedValue({
        recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      });

      const result = await getToolConfigRegistry('t1', eventWithOrg);
      expect(result).toBeDefined();
      expect(result!.toolId).toBe('t1');
      expect(mockGetResource).toHaveBeenCalledWith('tool', 't1');
    });

    test('falls back to DynamoDB when not in Registry', async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: 't1', config: { name: 'Tool1' }, state: 'active', orgId: 'test-org-a' },
      });

      const result = await getToolConfigRegistry('t1', eventWithOrg);
      expect(result).toBeDefined();
      expect(result!.toolId).toBe('t1');
    });

    test('returns null when not found in either source', async () => {
      mockGetResource.mockResolvedValue(null);
      dynamoMock.on(GetCommand).resolves({});

      const result = await getToolConfigRegistry('missing', eventWithOrg);
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
        config: '{"name":"TestTool","description":"A tool for testing"}',
        state: 'active',
        categories: ['cat1'],
        icon: 'icon.png',
      }, 'unknown', eventWithOrg);

      // New contract: customMetadata now carries the full config JSON plus
      // createdBy (defaulted to 'unknown' when no caller id is threaded) and
      // orgId sourced from the JWT claim.
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith({
        categories: ['cat1'],
        icon: 'icon.png',
        state: 'active',
        integrationBindings: undefined,
        dataStoreBindings: undefined,
        appId: undefined,
        config: '{"name":"TestTool","description":"A tool for testing"}',
        createdBy: 'unknown',
        orgId: 'test-org-a',
      });
      // Registry `description` now holds the plain human string, not the
      // full JSON blob.
      expect(mockCreateResource).toHaveBeenCalledWith('tool', 'tool-1', {
        name: 'TestTool',
        description: 'A tool for testing',
        customMetadata: expect.any(String),
      });
    });

    test('createResource is called with plain description when config.description is absent', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"TestTool"}',
      }, 'unknown', eventWithOrg);

      // No `description` field in the config → pass empty string, never the
      // full JSON blob.
      expect(mockCreateResource).toHaveBeenCalledWith('tool', 'tool-1', {
        name: 'TestTool',
        description: '',
        customMetadata: expect.any(String),
      });
    });

    test('threads caller userId into customMetadata.createdBy', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry(
        { toolId: 'tool-1', config: '{"name":"TestTool"}' },
        'test-user-abc',
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'test-user-abc' }),
      );
    });

    test('validates integrationBindings before Registry write', async () => {
      await expect(
        createToolConfigRegistry({
          toolId: 'tool-1',
          config: '{"name":"TestTool"}',
          integrationBindings: [{ integrationType: 'SLACK' }], // missing integrationId
        }, 'unknown', eventWithOrg),
      ).rejects.toThrow('integrationBinding missing required field "integrationId"');
    });

    test('validates dataStoreBindings before Registry write', async () => {
      await expect(
        createToolConfigRegistry({
          toolId: 'tool-1',
          config: '{"name":"TestTool"}',
          dataStoreBindings: [{ dataStoreId: 'ds1' }], // missing dataStoreType
        }, 'unknown', eventWithOrg),
      ).rejects.toThrow('dataStoreBinding missing required field "dataStoreType"');
    });

    test('updates status when initial state is provided', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"TestTool"}',
        state: 'active',
      }, 'unknown', eventWithOrg);

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
      }, 'unknown', eventWithOrg);

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
      }, 'unknown', eventWithOrg);

      expect(mockMapToToolConfig).toHaveBeenCalledWith(baseRecord);
      expect(result.toolId).toBe('tool-1');
    });

    // ── Phase-2a: orgId captured from JWT, not from input ──
    test('(a) orgId captured from the JWT claim and stored in customMetadata', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createToolConfigRegistry(
        { toolId: 'tool-1', config: '{"name":"TestTool"}' },
        'unknown',
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'test-org-a' }),
      );
    });

    test('throws when caller has no organization claim', async () => {
      await expect(
        createToolConfigRegistry(
          { toolId: 'tool-1', config: '{"name":"TestTool"}' },
          'unknown',
          {}, // empty event, no identity
        ),
      ).rejects.toThrow('Cannot determine caller organization');
      expect(mockCreateResource).not.toHaveBeenCalled();
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
        updateToolConfigRegistry({ toolId: 'missing' }, 'unknown', eventWithOrg),
      ).rejects.toThrow('Tool config not found: missing');
    });

    test('updates resource with merged metadata', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        categories: ['new-cat'],
      }, 'unknown', eventWithOrg);

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
      }, 'unknown', eventWithOrg);

      expect(mockToRegistryStatus).toHaveBeenCalledWith('inactive');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('tool', 'tool-1', 'DEPRECATED');
    });

    test('does not update status when state is unchanged', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        categories: ['new-cat'],
      }, 'unknown', eventWithOrg);

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test('preserves existing bindings when not provided in input', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        state: 'inactive',
      }, 'unknown', eventWithOrg);

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
        }, 'unknown', eventWithOrg),
      ).rejects.toThrow('integrationBinding missing required field "integrationId"');
    });

    test('returns mapped ToolConfig', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      // No state change → no refetch, mapToToolConfig receives the
      // updateResource response directly.
      const result = await updateToolConfigRegistry({
        toolId: 'tool-1',
        categories: ['new-cat'],
      }, 'unknown', eventWithOrg);

      expect(mockMapToToolConfig).toHaveBeenCalledWith(updatedRecord);
      expect(result.toolId).toBe('tool-1');
    });

    test('updateResource receives plain description from config.description', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({
        toolId: 'tool-1',
        config: '{"name":"ExistingTool","description":"Updated desc"}',
      }, 'unknown', eventWithOrg);

      // Registry `description` now holds only the plain human string, while
      // the full config payload is routed through customMetadata.config.
      expect(mockUpdateResource).toHaveBeenCalledWith('tool', 'tool-1', expect.objectContaining({
        name: 'ExistingTool',
        description: 'Updated desc',
        customMetadata: expect.any(String),
      }));
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        config: '{"name":"ExistingTool","description":"Updated desc"}',
      }));
    });

    test('preserves existing createdBy when updating a record', async () => {
      const recordWithCreator = {
        ...existingRecord,
        customDescriptorContent: JSON.stringify({
          categories: ['old-cat'],
          icon: 'old-icon.png',
          state: 'active',
          createdBy: 'original-creator',
        }),
      };
      mockGetResource.mockResolvedValue(recordWithCreator);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({ toolId: 'tool-1', categories: ['new-cat'] }, 'different-user', eventWithOrg);

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        createdBy: 'original-creator',
      }));
    });

    test('assigns caller userId to legacy record missing createdBy', async () => {
      mockGetResource.mockResolvedValue(existingRecord); // no createdBy in existingRecord
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({ toolId: 'tool-1', categories: ['new-cat'] }, 'editor-user', eventWithOrg);

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        createdBy: 'editor-user',
      }));
    });

    test('re-fetches resource after updateResourceStatus so returned state reflects post-transition record', async () => {
      const refreshedRecord = {
        ...existingRecord,
        status: 'DEPRECATED',
        updatedAt: new Date('2025-01-03'),
      };
      // First getResource → existing (for merge); Second getResource → refreshed (after status change).
      mockGetResource
        .mockResolvedValueOnce(existingRecord)
        .mockResolvedValueOnce(refreshedRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry({ toolId: 'tool-1', state: 'inactive' }, 'unknown', eventWithOrg);

      // getResource must be called twice: once before updateResource, once AFTER updateResourceStatus.
      expect(mockGetResource).toHaveBeenCalledTimes(2);
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('tool', 'tool-1', 'DEPRECATED');
      // mapToToolConfig receives the refreshed record (not the stale updatedRecord).
      expect(mockMapToToolConfig).toHaveBeenCalledWith(refreshedRecord);

      // Verify call ordering: updateResourceStatus fired before the second getResource.
      const statusOrder = mockUpdateResourceStatus.mock.invocationCallOrder[0];
      const getOrder = mockGetResource.mock.invocationCallOrder[1];
      expect(getOrder).toBeGreaterThan(statusOrder);
    });

    // ── Phase-2a: update preserves existingMeta.orgId, never derives from input ──
    test('(b) preserves existingMeta.orgId on update (never replaces it with caller org)', async () => {
      const recordWithOrg = {
        ...existingRecord,
        customDescriptorContent: JSON.stringify({
          categories: ['c'],
          icon: '',
          state: 'active',
          orgId: 'original-owner-org',
        }),
      };
      mockGetResource.mockResolvedValue(recordWithOrg);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry(
        { toolId: 'tool-1', categories: ['new-cat'] },
        'unknown',
        { identity: { claims: { 'custom:organization': 'different-caller-org' } } },
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'original-owner-org' }),
      );
    });

    test('falls back to caller JWT org when legacy record is missing orgId', async () => {
      // existingRecord has no orgId in customDescriptorContent → legacy path.
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateToolConfigRegistry(
        { toolId: 'tool-1', categories: ['new-cat'] },
        'unknown',
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'test-org-a' }),
      );
    });
  });

  // ─── Legacy fallback & new contract mapping ─────────────────

  describe('mapToToolConfig contract (registry-service)', () => {
    const { RegistryService: ActualRegistryService } = jest.requireActual(
      '../../services/registry-service',
    );
    let realService: any;

    beforeEach(() => {
      realService = new ActualRegistryService({
        registryId: 'test-registry',
        region: 'us-east-1',
      });
    });

    test('new contract: config sourced from customMetadata.config', () => {
      const record = {
        recordId: 'tool-new',
        name: 'NewTool',
        description: 'A plain human description',
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({
          categories: ['c1'],
          icon: '',
          state: 'active',
          config: '{"name":"NewTool","description":"A plain human description"}',
          createdBy: 'creator-1',
        }),
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const mapped = realService.mapToToolConfig(record);
      // config comes from meta.config, NOT record.description
      expect(mapped.config).toBe('{"name":"NewTool","description":"A plain human description"}');
    });

    test('legacy fallback: config sourced from record.description when meta.config is absent', () => {
      const record = {
        recordId: 'tool-legacy',
        name: 'LegacyTool',
        description: '{"name":"X"}', // full JSON blob in description — legacy layout
        status: 'APPROVED',
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: '',
          state: 'active',
          // no config field
        }),
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      };

      const mapped = realService.mapToToolConfig(record);
      expect(mapped.config).toBe('{"name":"X"}');
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
        recordId: 't1', name: 'Tool1', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
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

  // ── Phase-2a org scoping via the handler ───────────────────────
  describe('Phase-2a org scoping (handler)', () => {
    test('(c) list filters results to caller org', async () => {
      const ours = {
        recordId: 'tool-a', name: 'OurTool', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      };
      const theirs = {
        recordId: 'tool-b', name: 'OtherTool', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockListResources.mockResolvedValue([ours, theirs]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('listToolConfigs', {}));
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('tool-a');
    });

    test('(d) admin list returns all orgs unfiltered', async () => {
      const ours = {
        recordId: 'tool-a', name: 'OurTool', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      };
      const theirs = {
        recordId: 'tool-b', name: 'OtherTool', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockListResources.mockResolvedValue([ours, theirs]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const adminIdentity = {
        sub: 'admin',
        claims: { 'custom:organization': 'admin-home', 'custom:role': 'admin' },
      };
      const result = await handler(makeEvent('listToolConfigs', {}, adminIdentity));
      expect(result).toHaveLength(2);
    });

    test('(e) get cross-org surfaces as Not found (null)', async () => {
      mockGetResource.mockResolvedValue({
        recordId: 'tool-x', name: 'X', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      });
      dynamoMock.on(GetCommand).resolves({});

      const result = await handler(makeEvent('getToolConfig', { toolId: 'tool-x' }));
      expect(result).toBeNull();
    });

    test('(e) admin bypasses cross-org check on get', async () => {
      mockGetResource.mockResolvedValue({
        recordId: 'tool-x', name: 'X', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      });

      const adminIdentity = {
        sub: 'admin',
        claims: { 'custom:organization': 'admin-home', 'custom:role': 'admin' },
      };
      const result = await handler(makeEvent('getToolConfig', { toolId: 'tool-x' }, adminIdentity));
      expect(result?.toolId).toBe('tool-x');
      expect(result?.orgId).toBe('other-org');
    });

    test('list: non-admin without orgId returns empty list', async () => {
      mockListResources.mockResolvedValue([{
        recordId: 't1', name: 'T', description: '{}', status: 'APPROVED',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      }]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await handler(makeEvent('listToolConfigs', {}, {}));
      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
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
