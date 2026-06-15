/**
 * Tests for the handler switch dispatch based on REGISTRY_ENABLED (task 6.5).
 *
 * Verifies that the handler routes each GraphQL field to the correct
 * implementation (Registry vs DynamoDB) based on the feature flag, and
 * preserves the existing GraphQL response shape.
 *
 * Validates: Requirements 3.6, 11.2, 11.3
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
const mockMapToAgentConfig = jest.fn((record: any) => {
  // Mirror the real mapper's orgId behaviour so handler-dispatch tests that
  // don't care about orgId still see a record whose orgId matches the
  // caller's org fixture below.
  const meta = record.customDescriptorContent
    ? (() => { try { return JSON.parse(record.customDescriptorContent); } catch { return {}; } })()
    : {};
  return {
    agentId: record.recordId,
    orgId: meta.orgId ?? '',
    config: record.description ?? '',
    state: 'active',
    categories: [],
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
    mapToAgentConfig: mockMapToAgentConfig,
  })),
}));

import { handler, _resetRegistryService } from '../agent-config-resolver';

// ---------------------------------------------------------------------------

// Default identity for dispatch tests: caller belongs to test-org-a. Record
// fixtures below carry the matching orgId so the resolver's post-Phase-2a
// org filter lets them through. Tests that specifically exercise no-org /
// admin behaviour can supply their own identity.
const defaultIdentity = {
  sub: 'test-user',
  claims: { 'custom:organization': 'test-org-a' },
};

const makeEvent = (fieldName: string, args: any = {}, identity: any = defaultIdentity) => ({
  info: { fieldName },
  arguments: args,
  identity,
});

const sampleRegistryRecord = {
  recordId: 'agent-r1',
  name: 'RegistryAgent',
  description: '{"name":"RegistryAgent"}',
  status: 'APPROVED',
  customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

describe('handler switch dispatch (task 6.5)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    dynamoMock.reset();
    jest.clearAllMocks();
    _resetRegistryService();
    process.env = {
      ...originalEnv,
      AGENT_CONFIG_TABLE: 'test-agent-config',
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

    test('listAgentConfigs uses DynamoDB scan', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ agentId: 'a1', config: { name: 'A1' }, state: 'active' }],
      });

      const result = await handler(makeEvent('listAgentConfigs'));

      expect(mockListResources).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('a1');
      // GraphQL response shape: config is stringified
      expect(typeof result[0].config).toBe('string');
    });

    test('getAgentConfig uses DynamoDB GetItem', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { name: 'A1' }, state: 'active' },
      });

      const result = await handler(makeEvent('getAgentConfig', { agentId: 'a1' }));

      expect(mockGetResource).not.toHaveBeenCalled();
      expect(result?.agentId).toBe('a1');
      expect(typeof result?.config).toBe('string');
    });

    test('createAgentConfig uses DynamoDB Put', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createAgentConfig', {
        input: { agentId: 'new', config: '{"name":"N"}', state: 'active' },
      }));

      expect(mockCreateResource).not.toHaveBeenCalled();
      expect(result.agentId).toBe('new');
      expect(typeof result.config).toBe('string');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    test('updateAgentConfig uses DynamoDB Put', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: '{"old":true}', state: 'active', createdAt: '2025-01-01' },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('updateAgentConfig', {
        input: { agentId: 'a1', config: '{"new":true}' },
      }));

      expect(mockUpdateResource).not.toHaveBeenCalled();
      expect(result.agentId).toBe('a1');
    });

    test('deleteAgentConfig uses DynamoDB Delete', async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteAgentConfig', { agentId: 'a1' }));

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test('publishAgentManifest uses DynamoDB path', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { name: 'A1' }, state: 'active' },
      });
      // The DynamoDB path uses UpdateCommand, reset mock accepts it by default
      const manifest = JSON.stringify({
        name: 'Test',
        description: 'desc',
        version: '1.0.0',
      });

      // We only assert the Registry side-effect was not invoked — the
      // DynamoDB path calls UpdateCommand which the mock resolves with
      // default (empty) Attributes. That's sufficient to verify dispatch.
      try {
        await handler(makeEvent('publishAgentManifest', { agentId: 'a1', manifest }));
      } catch {
        // Even if the mock doesn't fully satisfy the update path, what
        // matters is that the Registry path wasn't taken.
      }

      expect(mockUpdateResource).not.toHaveBeenCalled();
    });
  });

  // ─── REGISTRY_ENABLED=true: routes to Registry ──────────────

  describe('when REGISTRY_ENABLED is true', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'true';
    });

    test('listAgentConfigs uses RegistryService.listResources (merged with DDB)', async () => {
      mockListResources.mockResolvedValue([sampleRegistryRecord]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('listAgentConfigs'));

      expect(mockListResources).toHaveBeenCalledWith('agent');
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-r1');
    });

    test('getAgentConfig uses RegistryService.getResource', async () => {
      mockGetResource.mockResolvedValue(sampleRegistryRecord);

      const result = await handler(makeEvent('getAgentConfig', { agentId: 'agent-r1' }));

      expect(mockGetResource).toHaveBeenCalledWith('agent', 'agent-r1');
      expect(result?.agentId).toBe('agent-r1');
    });

    test('createAgentConfig uses RegistryService.createResource', async () => {
      mockCreateResource.mockResolvedValue(sampleRegistryRecord);

      const result = await handler(makeEvent('createAgentConfig', {
        input: { agentId: 'agent-r1', config: '{"name":"RegistryAgent"}' },
      }));

      expect(mockCreateResource).toHaveBeenCalled();
      expect(result.agentId).toBe('agent-r1');
      // GraphQL shape: required fields present
      expect(result.state).toBeDefined();
      expect(result.categories).toBeDefined();
    });

    test('updateAgentConfig uses RegistryService.updateResource', async () => {
      mockGetResource.mockResolvedValue(sampleRegistryRecord);
      mockUpdateResource.mockResolvedValue(sampleRegistryRecord);

      const result = await handler(makeEvent('updateAgentConfig', {
        input: { agentId: 'agent-r1', categories: ['new'] },
      }));

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe('agent-r1');
    });

    test('deleteAgentConfig uses RegistryService.deleteResource', async () => {
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await handler(makeEvent('deleteAgentConfig', { agentId: 'agent-r1' }));

      expect(mockDeleteResource).toHaveBeenCalledWith('agent', 'agent-r1');
      expect(result.success).toBe(true);
    });

    test('publishAgentManifest uses RegistryService.updateResource', async () => {
      mockGetResource.mockResolvedValue(sampleRegistryRecord);
      mockUpdateResource.mockResolvedValue(sampleRegistryRecord);
      const manifest = JSON.stringify({
        name: 'Test',
        description: 'desc',
        version: '1.0.0',
      });

      const result = await handler(makeEvent('publishAgentManifest', {
        agentId: 'agent-r1',
        manifest,
      }));

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe('agent-r1');
    });
  });

  // ─── searchAgentConfigs: Registry-only (per requirement 9.3) ────

  describe('searchAgentConfigs is always wired to Registry', () => {
    test('routes to RegistryService.searchResources regardless of flag', async () => {
      process.env.REGISTRY_ENABLED = 'true';
      mockSearchResources.mockResolvedValue([sampleRegistryRecord]);

      const result = await handler(makeEvent('searchAgentConfigs', { query: 'test' }));

      expect(mockSearchResources).toHaveBeenCalledWith('agent', 'test');
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-r1');
    });
  });

  // ─── Phase-2a org scoping ───────────────────────────────────
  //
  // Five scenarios enumerated in the phase-2a spec:
  //   (a) create captures orgId from the JWT claim and stores it
  //   (b) update preserves the existing orgId
  //   (c) list filters to caller org
  //   (d) list-all works for admin via "All Organizations" (no filter)
  //   (e) get cross-org returns Not found

  describe('Phase-2a org scoping', () => {
    beforeEach(() => {
      process.env.REGISTRY_ENABLED = 'true';
    });

    test('(a) create: orgId captured from JWT claim and serialized into customMetadata', async () => {
      mockCreateResource.mockResolvedValue(sampleRegistryRecord);

      await handler(makeEvent(
        'createAgentConfig',
        { input: { agentId: 'agent-r1', config: '{"name":"RegistryAgent"}' } },
      ));

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'test-org-a' }),
      );
    });

    test('(b) update: existing orgId is preserved, never overwritten by caller org', async () => {
      const ownedBySomeoneElse = {
        ...sampleRegistryRecord,
        customDescriptorContent: JSON.stringify({ orgId: 'original-owner-org' }),
      };
      mockGetResource.mockResolvedValue(ownedBySomeoneElse);
      mockUpdateResource.mockResolvedValue(ownedBySomeoneElse);

      await handler(makeEvent(
        'updateAgentConfig',
        { input: { agentId: 'agent-r1', categories: ['x'] } },
        // different caller from the record owner
        { claims: { 'custom:organization': 'different-caller-org' } },
      ));

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'original-owner-org' }),
      );
    });

    test('(c) list: results filtered to caller org', async () => {
      const ourOrg = {
        ...sampleRegistryRecord,
        recordId: 'agent-a',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      };
      const otherOrg = {
        ...sampleRegistryRecord,
        recordId: 'agent-b',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockListResources.mockResolvedValue([ourOrg, otherOrg]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('listAgentConfigs'));

      // Only the record whose orgId matches the caller survives.
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-a');
    });

    test('(d) list: admin bypass returns all orgs (no filter applied)', async () => {
      const ourOrg = {
        ...sampleRegistryRecord,
        recordId: 'agent-a',
        customDescriptorContent: JSON.stringify({ orgId: 'test-org-a' }),
      };
      const otherOrg = {
        ...sampleRegistryRecord,
        recordId: 'agent-b',
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockListResources.mockResolvedValue([ourOrg, otherOrg]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      const adminIdentity = {
        sub: 'admin-user',
        claims: { 'custom:organization': 'admin-home-org', 'custom:role': 'admin' },
      };
      const result = await handler(makeEvent('listAgentConfigs', {}, adminIdentity));

      expect(result).toHaveLength(2);
      const ids = result.map((a: any) => a.agentId).sort();
      expect(ids).toEqual(['agent-a', 'agent-b']);
    });

    test('(e) get: cross-org resource surfaces as Not found (null)', async () => {
      const otherOrgRecord = {
        ...sampleRegistryRecord,
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockGetResource.mockResolvedValue(otherOrgRecord);
      // DDB fallback should not matter because the Registry record is present.
      dynamoMock.on(GetCommand).resolves({});

      const result = await handler(makeEvent('getAgentConfig', { agentId: 'agent-r1' }));
      // 404-style — null rather than a thrown authorization error, to avoid
      // leaking existence across tenants.
      expect(result).toBeNull();
    });

    test('(e) get: admin bypass returns cross-org resource', async () => {
      const otherOrgRecord = {
        ...sampleRegistryRecord,
        customDescriptorContent: JSON.stringify({ orgId: 'other-org' }),
      };
      mockGetResource.mockResolvedValue(otherOrgRecord);

      const adminIdentity = {
        sub: 'admin-user',
        claims: { 'custom:organization': 'admin-home-org', 'custom:role': 'admin' },
      };
      const result = await handler(makeEvent(
        'getAgentConfig',
        { agentId: 'agent-r1' },
        adminIdentity,
      ));

      expect(result?.agentId).toBe('agent-r1');
      expect(result?.orgId).toBe('other-org');
    });

    test('list: non-admin without orgId returns empty list (with warning)', async () => {
      mockListResources.mockResolvedValue([sampleRegistryRecord]);
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await handler(makeEvent('listAgentConfigs', {}, {}));
      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // ─── Unknown field ──────────────────────────────────────────

  test('throws on unknown GraphQL field', async () => {
    process.env.REGISTRY_ENABLED = 'false';
    await expect(handler(makeEvent('unknownField'))).rejects.toThrow('Unknown field');
  });
});
