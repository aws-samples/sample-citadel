/**
 * Tests for listAgentConfigsRegistry org scoping — orgId='' as system-shared.
 *
 * Seeded system agents (e.g. demo-echo-agent) carry orgId '' and must be
 * visible to every org-scoped (non-admin) caller alongside that caller's
 * own-org agents, on BOTH the Registry filter path and the legacy-DynamoDB
 * merge path. Admin behavior (sees all), the non-admin-without-orgId
 * empty-list behavior, cross-org isolation, and dedupe-by-name are locked
 * down as regression guards.
 */
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock RegistryService — only the members used by listAgentConfigsRegistry.
// mapToAgentConfig mirrors the real mapping's org handling: orgId comes from
// the deserialized customDescriptorContent, defaulting to '' when absent.
// ---------------------------------------------------------------------------

interface TestRegistryRecord {
  recordId: string;
  name: string;
  status: string;
  description: string;
  customDescriptorContent: string;
}

const mockListResources = jest.fn();
const mockMapToAgentConfig = jest.fn((record: TestRegistryRecord) => {
  const meta = JSON.parse(record.customDescriptorContent) as { orgId?: string };
  return {
    agentId: record.recordId,
    name: record.name,
    orgId: typeof meta.orgId === 'string' ? meta.orgId : '',
    config: record.description,
    state: 'active',
    categories: [] as string[],
  };
});

jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
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

import { listAgentConfigsRegistry, _resetRegistryService } from '../agent-config-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const registryRecord = (recordId: string, name: string, orgId: string): TestRegistryRecord => ({
  recordId,
  name,
  status: 'APPROVED',
  description: JSON.stringify({ name }),
  customDescriptorContent: JSON.stringify({ orgId }),
});

// Registry records: one own-org, one system-shared (orgId ''), one other-org.
const REGISTRY_RECORDS: TestRegistryRecord[] = [
  registryRecord('reg-own', 'OwnOrgAgent', 'org-a'),
  registryRecord('reg-system', 'Echo Demo Agent', ''),
  registryRecord('reg-other', 'OtherOrgAgent', 'org-b'),
];

// Legacy DynamoDB items: one own-org, one system-shared (no orgId → maps to
// ''), one other-org. Names are distinct from the Registry ones so the
// dedupe-by-name step does not interfere with the scoping assertions.
const DYNAMO_ITEMS = [
  { agentId: 'dyn-own', orgId: 'org-a', config: '{"name":"LegacyOwn"}', state: 'active' },
  { agentId: 'dyn-system', config: '{"name":"LegacyShared"}', state: 'active' },
  { agentId: 'dyn-other', orgId: 'org-b', config: '{"name":"LegacyOther"}', state: 'active' },
];

const nonAdminEvent = (orgId: string) => ({
  identity: { claims: { 'custom:organization': orgId } },
});
const adminEvent = { identity: { claims: { 'custom:role': 'admin' } } };
const noOrgEvent = { identity: {} };

const agentIdsOf = (configs: Array<{ agentId: string }>): string[] =>
  configs.map((c) => c.agentId).sort();

describe('listAgentConfigsRegistry — orgId scoping with system-shared agents', () => {
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
    dynamoMock.reset();
    mockListResources.mockResolvedValue(REGISTRY_RECORDS);
    dynamoMock.on(ScanCommand).resolves({ Items: DYNAMO_ITEMS });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('(a) non-admin with orgId sees own-org registry agents', async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent('org-a'));

    expect(agentIdsOf(result)).toContain('reg-own');
  });

  test("(b) non-admin with orgId also sees system-shared (orgId='') registry agents", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent('org-a'));

    expect(agentIdsOf(result)).toContain('reg-system');
  });

  test('(c) non-admin with orgId never sees other-org agents (registry or legacy)', async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent('org-a'));

    const ids = agentIdsOf(result);
    expect(ids).not.toContain('reg-other');
    expect(ids).not.toContain('dyn-other');
  });

  test('(d) admin sees all agents across all orgs, including system-shared (unchanged)', async () => {
    const result = await listAgentConfigsRegistry(adminEvent);

    expect(agentIdsOf(result)).toEqual(
      ['reg-own', 'reg-system', 'reg-other', 'dyn-own', 'dyn-system', 'dyn-other'].sort(),
    );
  });

  test('(e) non-admin without orgId still gets an empty list and no registry fetch', async () => {
    const result = await listAgentConfigsRegistry(noOrgEvent);

    expect(result).toEqual([]);
    expect(mockListResources).not.toHaveBeenCalled();
  });

  test("(f) legacy-Dynamo merge path: non-admin with orgId sees own-org AND system-shared (orgId='') legacy agents", async () => {
    const result = await listAgentConfigsRegistry(nonAdminEvent('org-a'));

    const ids = agentIdsOf(result);
    expect(ids).toContain('dyn-own');
    expect(ids).toContain('dyn-system');
    // Full expected visibility for org-a: own-org + system-shared from both sources.
    expect(ids).toEqual(['dyn-own', 'dyn-system', 'reg-own', 'reg-system'].sort());
  });

  test('(g) dedupe-by-name still holds when a system-shared registry agent and a legacy agent share a name', async () => {
    // Legacy duplicate of the system-shared registry agent, sharing the
    // config name 'Echo Demo Agent'. Registry must win; the legacy row
    // must be dropped from the merged result.
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        ...DYNAMO_ITEMS,
        { agentId: 'dyn-echo-dup', config: '{"name":"Echo Demo Agent"}', state: 'active' },
      ],
    });

    const result = await listAgentConfigsRegistry(nonAdminEvent('org-a'));

    const ids = agentIdsOf(result);
    expect(ids).toContain('reg-system');
    expect(ids).not.toContain('dyn-echo-dup');
  });
});
