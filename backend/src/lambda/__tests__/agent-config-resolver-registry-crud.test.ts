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
  // The activation gate (US-IMP) guards on RegistryRecordStatusValues.APPROVED;
  // the real registry-service exports these enum values, so the test double
  // must export them too (mirrors agent-config-resolver.test.ts).
  RegistryRecordStatusValues: {
    DRAFT: 'DRAFT',
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    DEPRECATED: 'DEPRECATED',
    CREATING: 'CREATING',
    UPDATING: 'UPDATING',
    CREATE_FAILED: 'CREATE_FAILED',
    UPDATE_FAILED: 'UPDATE_FAILED',
  },
}));

describe('Registry-backed CRUD functions (task 6.4)', () => {
  const originalEnv = process.env;
  // Fixture identity that carries a tenant claim the same way AppSync
  // delivers it in production. Tests pass this to the registry-path
  // functions as the second arg so extractOrgFromEvent resolves without
  // falling back to Cognito.
  const eventWithOrg = {
    identity: { claims: { 'custom:organization': 'test-org-a' } },
  };

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
      mockGetResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
        state: 'active',
        categories: ['cat1'],
        icon: 'icon.png',
      }, eventWithOrg);

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith({
        categories: ['cat1'],
        icon: 'icon.png',
        state: 'active',
        appId: undefined,
        orgId: 'test-org-a',
      });
      expect(mockCreateResource).toHaveBeenCalledWith('agent', 'agent-1', {
        name: 'TestAgent',
        description: '{"name":"TestAgent"}',
        customMetadata: expect.any(String),
      });
    });

    test('updates status when initial state is provided', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);
      mockGetResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
        state: 'active',
      }, eventWithOrg);

      expect(mockToRegistryStatus).toHaveBeenCalledWith('active');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-1', 'APPROVED');
    });

    test('returns mapped AgentConfig', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      const result = await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
      }, eventWithOrg);

      expect(mockMapToAgentConfig).toHaveBeenCalledWith(baseRecord);
      expect(result.agentId).toBe('agent-1');
    });

    test('handles object config input by stringifying', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: { name: 'TestAgent' },
      }, eventWithOrg);

      expect(mockCreateResource).toHaveBeenCalledWith('agent', 'agent-1', expect.objectContaining({
        description: '{"name":"TestAgent"}',
      }));
    });

    test('defaults categories to empty array and icon to empty string', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry({
        agentId: 'agent-1',
        config: '{"name":"TestAgent"}',
      }, eventWithOrg);

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
      }, eventWithOrg);

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(expect.objectContaining({
        appId: 'app-123',
      }));
    });

    // ── D1(a): orgId captured from JWT, not from input ─────────────────
    test('captures orgId from the JWT claim and stores it in customMetadata', async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry(
        { agentId: 'agent-1', config: '{"name":"TestAgent"}' },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'test-org-a' }),
      );
    });

    test('throws when caller has no organization claim and no Cognito fallback', async () => {
      // No identity → extractOrgFromEvent returns null → we must refuse to
      // create a tenant-owned record without a tenant.
      await expect(
        createAgentConfigRegistry(
          { agentId: 'agent-1', config: '{"name":"TestAgent"}' },
          {},
        ),
      ).rejects.toThrow('Cannot determine caller organization');
      expect(mockCreateResource).not.toHaveBeenCalled();
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
        updateAgentConfigRegistry({ agentId: 'missing' }, eventWithOrg),
      ).rejects.toThrow('Agent config not found: missing');
    });

    test('updates resource with merged metadata', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        categories: ['new-cat'],
      }, eventWithOrg);

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
      }, eventWithOrg);

      expect(mockToRegistryStatus).toHaveBeenCalledWith('inactive');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-1', 'DEPRECATED');
    });

    test('does not update status when state is unchanged', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        categories: ['new-cat'],
      }, eventWithOrg);

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test('preserves existing config when no new config provided', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry({
        agentId: 'agent-1',
        state: 'inactive',
      }, eventWithOrg);

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
      }, eventWithOrg);

      // After the state-change refetch, mapToAgentConfig is called with the
      // record returned by the second getResource call (here existingRecord).
      expect(mockMapToAgentConfig).toHaveBeenCalledWith(existingRecord);
      expect(result.agentId).toBe('agent-1');
    });

    // ── Phase-2a: update preserves existingMeta.orgId, never derives from input ──
    test('preserves existingMeta.orgId on update (never replaces it with caller org)', async () => {
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

      await updateAgentConfigRegistry(
        { agentId: 'agent-1', categories: ['new-cat'] },
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

      await updateAgentConfigRegistry(
        { agentId: 'agent-1', categories: ['new-cat'] },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'test-org-a' }),
      );
    });

    test('when input.state changes, re-fetches the record after updateResourceStatus and returns the post-transition state', async () => {
      const draftRecord = {
        recordId: 'agent-1',
        name: 'ExistingAgent',
        description: '{"name":"ExistingAgent"}',
        status: 'DRAFT',
        customDescriptorContent: JSON.stringify({ state: 'inactive', manifest: {} }),
      };
      const pendingRecord = {
        recordId: 'agent-1',
        name: 'ExistingAgent',
        description: '{"name":"ExistingAgent"}',
        status: 'PENDING_APPROVAL',
        customDescriptorContent: JSON.stringify({ state: 'active', manifest: {} }),
      };

      // 1st getResource call → DRAFT (existing), 2nd call (refetch) → PENDING_APPROVAL
      mockGetResource
        .mockResolvedValueOnce(draftRecord)
        .mockResolvedValueOnce(pendingRecord);
      // updateResource returns the stale DRAFT record — simulating the bug
      mockUpdateResource.mockResolvedValue(draftRecord);
      mockUpdateResourceStatus.mockResolvedValue(undefined);

      // Stub mapToAgentConfig to map status → state using the same logic as
      // the real implementation for the statuses this test exercises.
      mockMapToAgentConfig.mockImplementation((record: any) => ({
        agentId: record.recordId,
        config: record.description || '',
        state: record.status === 'PENDING_APPROVAL' || record.status === 'APPROVED'
          ? 'active'
          : record.status === 'DRAFT'
            ? 'maintenance'
            : 'inactive',
        categories: [],
      }));

      const result = await updateAgentConfigRegistry({
        agentId: 'agent-1',
        state: 'active',
      }, eventWithOrg);

      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-1', 'APPROVED');
      expect(mockGetResource).toHaveBeenCalledTimes(2);
      expect(mockMapToAgentConfig).toHaveBeenLastCalledWith(pendingRecord);
      expect(result.state).toBe('active');
    });

    test('when input.state is unchanged, does not call updateResourceStatus and does not refetch', async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      const result = await updateAgentConfigRegistry({
        agentId: 'agent-1',
        // existingRecord.customDescriptorContent state is 'active'
        state: 'active',
      }, eventWithOrg);

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      // Only the initial pre-mutation fetch; no refetch.
      expect(mockGetResource).toHaveBeenCalledTimes(1);
      // Returns the record from updateResource, not a refetched one.
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
