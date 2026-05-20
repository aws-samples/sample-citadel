/**
 * Tests for Registry-backed CRUD functions in agent-config-resolver (task 6.4)
 *
 * Validates: Requirements 3.3, 3.4, 3.5, 3.7, 12.1, 12.2
 */
import {
  createAgentConfigRegistry,
  updateAgentConfigRegistry,
  deleteAgentConfigRegistry,
  publishAgentManifestRegistry,
  _resetRegistryService,
} from '../agent-config-resolver';

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------

const mockCreateResource = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockDeleteResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
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
    updateResourceStatus: mockUpdateResourceStatus,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
}));

describe('Registry-backed CRUD functions (task 6.4)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: 'true',
      REGISTRY_ID: 'test-registry',
      AGENT_CONFIG_TABLE: 'test-agents',
    };
    _resetRegistryService();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── createAgentConfigRegistry ──────────────────────────────

  describe('createAgentConfigRegistry', () => {
    const baseRecord = {
      recordId: 'agent-1',
      name: 'TestAgent',
      description: '{"name":"TestAgent"}',
      status: 'DRAFT',
      customDescriptorContent: '{}',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };

    test('creates a Registry resource with serialized custom metadata', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
        state: 'active',
        categories: ['cat1'],
        icon: 'icon.png',
      });

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith({
        categories: ['cat1'],
        icon: 'icon.png',
        state: 'active',
        appId: undefined,
      });
      expect(mockCreateResource).toHaveBeenCalledWith('agent', 'agent-1', {
        name: 'TestAgent',
        description: '{"name":"TestAgent"}',
        customMetadata: expect.any(String),
      });
    });

    test('updates status when initial state is provided', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
        state: 'active',
      });

      expect(mockToRegistryStatus).toHaveBeenCalledWith('active');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-1', 'APPROVED');
    });

    test('returns mapped AgentConfig', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      const result = await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
      });

      expect(mockMapToAgentConfig).toHaveBeenCalledWith(baseRecord);
      expect(result.agentId).toBe('agent-1');
    });

    test('handles object config input by stringifying', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: { name: 'TestAgent' },
      });

      expect(mockCreateResource).toHaveBeenCalledWith('agent', 'agent-1', expect.objectContaining({
        description: '{"name":"TestAgent"}',
      }));
    });

    test('defaults categories to empty array and icon to empty string', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
      });

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        categories: [],
        icon: '',
        state: 'active',
      }));
    });

    test('passes appId when provided', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
        appId: 'app-123',
      });

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        appId: 'app-123',
      }));
    });
  });

  // ─── updateAgentConfigRegistry ──────────────────────────────

  describe('updateAgentConfigRegistry', () => {
    const existingRecord = {
      recordId: 'agent-1',
      name: 'ExistingAgent',
      description: '{"name":"ExistingAgent"}',
      status: 'APPROVED',
      customDescriptorContent: JSON.stringify({
        categories: ['old-cat'],
        icon: 'old-icon.png',
        state: 'active',
      }),
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };

    const updatedRecord = {
      ...existingRecord,
      updatedAt: new Date('2025-01-02'),
    };

    test('throws when agent not found in Registry', async () => {
      mockGetResource.mockResolvedValue(null);

      await expect(
        updateAgentConfigRegistry({ agentId: 'missing' }),
      ).rejects.toThrow('Agent config not found: missing');
    });

    test('updates resource with merged metadata', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        categories: ['new-cat'],
      });

      expect(mockUpdateResource).toHaveBeenCalledWith('agent', 'agent-1', expect.objectContaining({
        customMetadata: expect.any(String),
      }));
    });

    test('updates Registry status when state changes', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        state: 'inactive',
      });

      expect(mockToRegistryStatus).toHaveBeenCalledWith('inactive');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-1', 'DEPRECATED');
    });

    test('does not update status when state is unchanged', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        categories: ['new-cat'],
      });

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test('preserves existing config when no new config provided', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        state: 'inactive',
      });

      expect(mockUpdateResource).toHaveBeenCalledWith('agent', 'agent-1', expect.objectContaining({
        description: '{"name":"ExistingAgent"}',
      }));
    });

    test('returns mapped AgentConfig', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      const result = await updateAgentConfigRegistry({
        agentId: 'agent-1',
        state: 'inactive',
      });

      expect(mockMapToAgentConfig).toHaveBeenCalledWith(updatedRecord);
      expect(result.agentId).toBe('agent-1');
    });
  });

  // ─── deleteAgentConfigRegistry ──────────────────────────────

  describe('deleteAgentConfigRegistry', () => {
    test('returns success on successful delete', async () => {
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await deleteAgentConfigRegistry('agent-1');

      expect(mockDeleteResource).toHaveBeenCalledWith('agent', 'agent-1');
      expect(result.success).toBe(true);
      expect(result.message).toContain('agent-1');
    });

    test('returns failure when delete throws', async () => {
      mockDeleteResource.mockRejectedValue(new Error('Registry error'));

      const result = await deleteAgentConfigRegistry('agent-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed');
    });
  });

  // ─── publishAgentManifestRegistry ───────────────────────────

  describe('publishAgentManifestRegistry', () => {
    const existingRecord = {
      recordId: 'agent-1',
      name: 'TestAgent',
      description: '{"name":"TestAgent"}',
      status: 'APPROVED',
      customDescriptorContent: JSON.stringify({
        categories: ['cat1'],
        icon: 'icon.png',
        state: 'active',
      }),
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    };

    const validManifest = {
      name: 'Test Agent',
      description: 'A test agent',
      version: '1.0.0',
    };

    test('throws on invalid JSON manifest', async () => {
      await expect(
        publishAgentManifestRegistry('agent-1', 'not-json'),
      ).rejects.toThrow('Invalid manifest JSON');
    });

    test('throws on manifest missing required fields', async () => {
      await expect(
        publishAgentManifestRegistry('agent-1', JSON.stringify({ name: 'Agent' })),
      ).rejects.toThrow('Manifest validation failed');
    });

    test('throws when agent not found in Registry', async () => {
      mockGetResource.mockResolvedValue(null);

      await expect(
        publishAgentManifestRegistry('agent-1', JSON.stringify(validManifest)),
      ).rejects.toThrow('Agent config not found');
    });

    test('updates custom metadata with new manifest', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(existingRecord);

      await publishAgentManifestRegistry('agent-1', JSON.stringify(validManifest));

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ manifest: validManifest }),
      );
      expect(mockUpdateResource).toHaveBeenCalledWith('agent', 'agent-1', expect.objectContaining({
        customMetadata: expect.any(String),
        description: existingRecord.description,
      }));
    });

    test('returns mapped AgentConfig', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(existingRecord);

      const result = await publishAgentManifestRegistry('agent-1', JSON.stringify(validManifest));

      expect(mockMapToAgentConfig).toHaveBeenCalledWith(existingRecord);
      expect(result.agentId).toBe('agent-1');
    });
  });
});
