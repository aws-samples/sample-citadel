/**
 * Governance activation gate tests for agent-config-resolver (US-IMP).
 *
 * The gate fires ONLY on the APPROVED (activation) transition for an
 * IMPORTED (governanceAttestation present), NOT-YET-ATTESTED Registry record.
 * Every other path — non-imported agents, deactivation, metadata-only
 * updates, already-attested records — must behave exactly as before.
 *
 * RegistryService, getGovernanceEnforce and publishEvent are all mocked so the
 * gate logic is exercised without touching the AgentCore Registry SDK, SSM, or
 * EventBridge.
 */
import {
  updateAgentConfigRegistry,
  activateProjectAgents,
  _resetRegistryService,
} from '../agent-config-resolver';

// ── Mock RegistryService ──────────────────────────────────────────────────
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockListResources = jest.fn();
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
  const map: Record<string, string> = {
    active: 'APPROVED',
    inactive: 'DEPRECATED',
    maintenance: 'DRAFT',
  };
  return map[state] || 'DEPRECATED';
});
const mockMapToAgentConfig = jest.fn((record: { recordId: string; description?: string }) => ({
  agentId: record.recordId,
  config: record.description || '',
  state: 'active',
  categories: [],
}));

jest.mock('../../services/registry-service', () => ({
  __esModule: true,
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    updateResourceStatus: mockUpdateResourceStatus,
    listResources: mockListResources,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
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

// ── Mock the governance rollout flag reader (reads SSM; never AWS) ──────────
const mockGetGovernanceEnforce = jest.fn();
jest.mock('../../utils/governance-flag', () => ({
  __esModule: true,
  getGovernanceEnforce: (...args: unknown[]) => mockGetGovernanceEnforce(...args),
}));

// ── Mock the EventBridge publisher (best-effort gate telemetry) ────────────
const mockPublishEvent = jest.fn();
jest.mock('../../utils/events', () => ({
  __esModule: true,
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

/** AppSync identity carrying a tenant claim (so extractOrgFromEvent resolves). */
const eventWithOrg = {
  identity: { claims: { 'custom:organization': 'test-org-a' } },
};

const importedMeta = (status: 'pending' | 'attested') => ({
  categories: [],
  icon: '',
  state: 'active',
  orgId: 'test-org-a',
  governanceAttestation: {
    status,
    enforcementMode: 'permissive',
    authorityRequested: true,
    requestedAt: '2026-01-01T00:00:00.000Z',
  },
});

const importedRecord = (
  status: 'pending' | 'attested',
  recordStatus = 'PENDING_APPROVAL',
) => ({
  recordId: 'agent-imp-1',
  name: 'ImportedAgent',
  description: '{"name":"ImportedAgent"}',
  status: recordStatus,
  customDescriptorContent: JSON.stringify(importedMeta(status)),
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
});

const nonImportedRecord = (recordStatus = 'PENDING_APPROVAL') => ({
  recordId: 'agent-plain-1',
  name: 'PlainAgent',
  description: '{"name":"PlainAgent"}',
  status: recordStatus,
  customDescriptorContent: JSON.stringify({
    categories: [],
    icon: '',
    state: 'active',
    orgId: 'test-org-a',
  }),
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
});

describe('agent-config-resolver governance activation gate (US-IMP)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: 'true',
      REGISTRY_ID: 'test-registry',
      AGENT_CONFIG_TABLE: 'test-agents',
      ENVIRONMENT: 'dev',
    };
    _resetRegistryService();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── updateAgentConfigRegistry ─────────────────────────────────────────

  describe('updateAgentConfigRegistry', () => {
    test('imported + pending + strict → THROWS and does NOT write APPROVED status', async () => {
      mockGetResource.mockResolvedValue(importedRecord('pending'));
      mockUpdateResource.mockResolvedValue(importedRecord('pending'));
      mockGetGovernanceEnforce.mockResolvedValue('strict');

      await expect(
        updateAgentConfigRegistry({ agentId: 'agent-imp-1', state: 'active' }, eventWithOrg),
      ).rejects.toThrow(/Activation blocked.*agent-imp-1/);

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test.each(['shadow', 'permissive'])(
      'imported + pending + %s → activation PROCEEDS and emits a gate event',
      async (mode) => {
        mockGetResource.mockResolvedValue(importedRecord('pending'));
        mockUpdateResource.mockResolvedValue(importedRecord('pending'));
        mockGetGovernanceEnforce.mockResolvedValue(mode);

        await updateAgentConfigRegistry(
          { agentId: 'agent-imp-1', state: 'active' },
          eventWithOrg,
        );

        expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-imp-1', 'APPROVED');
        expect(mockPublishEvent).toHaveBeenCalledTimes(1);
        const evt = mockPublishEvent.mock.calls[0][0];
        expect(evt.payload).toMatchObject({
          agentId: 'agent-imp-1',
          attestationStatus: 'pending',
          mode,
        });
      },
    );

    test.each(['strict', 'shadow', 'permissive'])(
      'imported + attested + %s → activation PROCEEDS, no gate event, flag never read',
      async (mode) => {
        mockGetResource.mockResolvedValue(importedRecord('attested'));
        mockUpdateResource.mockResolvedValue(importedRecord('attested'));
        mockGetGovernanceEnforce.mockResolvedValue(mode);

        await updateAgentConfigRegistry(
          { agentId: 'agent-imp-1', state: 'active' },
          eventWithOrg,
        );

        expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-imp-1', 'APPROVED');
        expect(mockPublishEvent).not.toHaveBeenCalled();
        expect(mockGetGovernanceEnforce).not.toHaveBeenCalled();
      },
    );

    test('REGRESSION: non-imported + strict → activation unchanged, gate never fires', async () => {
      mockGetResource.mockResolvedValue(nonImportedRecord());
      mockUpdateResource.mockResolvedValue(nonImportedRecord());
      mockGetGovernanceEnforce.mockResolvedValue('strict');

      await updateAgentConfigRegistry(
        { agentId: 'agent-plain-1', state: 'active' },
        eventWithOrg,
      );

      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-plain-1', 'APPROVED');
      expect(mockGetGovernanceEnforce).not.toHaveBeenCalled();
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    test('imported + pending + strict + DEACTIVATION (state→inactive) → gate does NOT fire', async () => {
      // Record is currently APPROVED; transition target is DEPRECATED, not APPROVED.
      mockGetResource.mockResolvedValue(importedRecord('pending', 'APPROVED'));
      mockUpdateResource.mockResolvedValue(importedRecord('pending', 'APPROVED'));
      mockGetGovernanceEnforce.mockResolvedValue('strict');

      await updateAgentConfigRegistry(
        { agentId: 'agent-imp-1', state: 'inactive' },
        eventWithOrg,
      );

      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'agent-imp-1', 'DEPRECATED');
      expect(mockGetGovernanceEnforce).not.toHaveBeenCalled();
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    test('imported + pending + strict + METADATA-ONLY (no state) → gate does NOT fire', async () => {
      mockGetResource.mockResolvedValue(importedRecord('pending', 'PENDING_APPROVAL'));
      mockUpdateResource.mockResolvedValue(importedRecord('pending', 'PENDING_APPROVAL'));
      mockGetGovernanceEnforce.mockResolvedValue('strict');

      await updateAgentConfigRegistry(
        { agentId: 'agent-imp-1', categories: ['x'] },
        eventWithOrg,
      );

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      expect(mockGetGovernanceEnforce).not.toHaveBeenCalled();
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });
  });

  // ─── activateProjectAgents (batch APPROVED path) ───────────────────────

  describe('activateProjectAgents', () => {
    const importedBatchRecord = {
      recordId: 'imp-1',
      name: 'Imported',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        sourceProjectId: 'proj-1',
        ...importedMeta('pending'),
      }),
    };
    const plainBatchRecord = {
      recordId: 'plain-1',
      name: 'Plain',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        sourceProjectId: 'proj-1',
        categories: [],
        icon: '',
        state: 'active',
      }),
    };

    test('strict → imported-unattested agent lands in failed without aborting the batch', async () => {
      mockListResources.mockResolvedValue([importedBatchRecord, plainBatchRecord]);
      mockGetGovernanceEnforce.mockResolvedValue('strict');

      const res = await activateProjectAgents('proj-1');

      expect(res.failed).toContain('Imported');
      expect(res.activated).toContain('Plain');
      // Only the non-imported agent's APPROVED write happened; the gate blocked
      // the imported one before its write.
      expect(mockUpdateResourceStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'plain-1', 'APPROVED');
    });

    test('shadow → imported-unattested agent activates and emits a gate event', async () => {
      mockListResources.mockResolvedValue([importedBatchRecord]);
      mockGetGovernanceEnforce.mockResolvedValue('shadow');

      const res = await activateProjectAgents('proj-1');

      expect(res.activated).toContain('Imported');
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'imp-1', 'APPROVED');
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    });
  });
});
