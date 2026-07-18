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
const mockSerializeCustomMetadata = jest.fn((meta: unknown) => JSON.stringify(meta));
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null, defaults: Record<string, unknown>) => {
    if (!json) return defaults;
    try {
      return { ...defaults, ...JSON.parse(json) };
    } catch {
      return defaults;
    }
  },
);
const mockToRegistryStatus = jest.fn((state: string) => {
  const map: Record<string, string> = { active: 'APPROVED', inactive: 'DEPRECATED', maintenance: 'DRAFT' };
  return map[state] || 'DEPRECATED';
});
const mockToInternalState = jest.fn((status: string) => {
  const map: Record<string, string> = { APPROVED: 'active', DEPRECATED: 'inactive', DRAFT: 'maintenance' };
  return map[status] || 'inactive';
});

/** Registry record fixture shape consumed by the mock mapper. */
interface RegistryRecordFixture {
  recordId: string;
  name?: string;
  description?: string;
  status: string;
  customDescriptorContent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const mockMapToToolConfig = jest.fn((record: RegistryRecordFixture) => {
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

const defaultIdentity = {
  sub: 'test-user',
  claims: { 'custom:organization': 'test-org-a' },
};

const makeEvent = (
  fieldName: string,
  args: Record<string, unknown> = {},
  identity: Record<string, unknown> = defaultIdentity,
) => ({
  info: { fieldName },
  arguments: args,
  identity,
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
    orgId: 'test-org-a',
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

  // ─── Phase-2a org scoping ───────────────────────────────────
  describe('Phase-2a org scoping (handler)', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'true';
    });

    test('(a) create: orgId captured from JWT claim and serialized into customMetadata', async () => {
      mockCreateResource.mockResolvedValue(sampleRegistryRecord);

      await handler(makeEvent(
        'createToolConfig',
        { input: { toolId: 'tool-r1', config: '{"name":"RegistryTool"}' } },
      ));

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'test-org-a' }),
      );
    });

    test('(b) update: existing orgId is preserved', async () => {
      const owned = {
        ...sampleRegistryRecord,
        customDescriptorContent: JSON.stringify({ orgId: 'original-owner-org' }),
      };
      mockGetResource.mockResolvedValue(owned);
      mockUpdateResource.mockResolvedValue(owned);

      await handler(makeEvent(
        'updateToolConfig',
        { input: { toolId: 'tool-r1', categories: ['x'] } },
        { sub: 'u', claims: { 'custom:organization': 'different-caller-org' } },
      ));

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'original-owner-org' }),
      );
    });

    test('(c) list filters to caller org', async () => {
      const ours = {
        ...sampleRegistryRecord,
        recordId: 'tool-a',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      };
      const theirs = {
        ...sampleRegistryRecord,
        recordId: 'tool-b',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockListResources.mockResolvedValue([ours, theirs]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('listToolConfigs'));
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('tool-a');
    });

    test('(d) admin list returns all orgs', async () => {
      const ours = {
        ...sampleRegistryRecord,
        recordId: 'tool-a',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      };
      const theirs = {
        ...sampleRegistryRecord,
        recordId: 'tool-b',
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

    test('(e) get cross-org returns Not found (null)', async () => {
      mockGetResource.mockResolvedValue({
        ...sampleRegistryRecord,
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      });
      dynamoMock.on(GetCommand).resolves({});

      const result = await handler(makeEvent('getToolConfig', { toolId: 'tool-r1' }));
      expect(result).toBeNull();
    });
  });

  // ─── Caller identity threading ──────────────────────────────
  //
  // Mirror the fabricator-request-resolver identity tests: the handler must
  // pluck identity.sub (Cognito) with a fallback to identity.username (IAM)
  // and 'unknown' when nothing is present, then forward that value through
  // to createToolConfigRegistry / updateToolConfigRegistry as userId. The
  // value is observed via the customMetadata object passed to
  // serializeCustomMetadata, which is where the resolver stores it as
  // `createdBy`.

  describe('caller identity is threaded into createToolConfigRegistry', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'true';
      mockCreateResource.mockResolvedValue(sampleRegistryRecord);
    });

    test('uses identity.sub when provided (Cognito auth mode)', async () => {
      await handler(
        makeEvent(
          'createToolConfig',
          { input: { toolId: 'tool-r1', config: '{"name":"X"}' } },
          {
            sub: 'test-user-abc',
            username: 'ignored-when-sub-present',
            claims: { 'custom:organization': 'test-org-a' },
          },
        ),
      );
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'test-user-abc' }),
      );
    });

    test('falls back to identity.username when no sub is present (IAM auth mode)', async () => {
      await handler(
        makeEvent(
          'createToolConfig',
          { input: { toolId: 'tool-r1', config: '{"name":"X"}' } },
          {
            username: 'iam-caller',
            claims: { 'custom:organization': 'test-org-a' },
          },
        ),
      );
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'iam-caller' }),
      );
    });

    test("falls back to 'unknown' when event.identity is undefined", async () => {
      // When identity is undefined the resolver must still refuse to create —
      // Phase-2a mandates an orgId on every new record. We assert by
      // providing an identity that carries only the org claim (so the pre-
      // existing behaviour of falling back to 'unknown' for createdBy is
      // observable) and leaving sub/username unset.
      await handler(
        makeEvent(
          'createToolConfig',
          { input: { toolId: 'tool-r1', config: '{"name":"X"}' } },
          { claims: { 'custom:organization': 'test-org-a' } },
        ),
      );
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'unknown' }),
      );
    });
  });

  describe('caller identity is threaded into updateToolConfigRegistry', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'true';
      mockGetResource.mockResolvedValue(sampleRegistryRecord);
      mockUpdateResource.mockResolvedValue(sampleRegistryRecord);
    });

    test('uses identity.sub when provided', async () => {
      await handler(
        makeEvent(
          'updateToolConfig',
          { input: { toolId: 'tool-r1', categories: ['x'] } },
          { sub: 'editor-sub-id', claims: { 'custom:organization': 'test-org-a' } },
        ),
      );
      // sampleRegistryRecord has no createdBy in customDescriptorContent, so
      // the caller's sub becomes the record's createdBy on first edit.
      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'editor-sub-id' }),
      );
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
