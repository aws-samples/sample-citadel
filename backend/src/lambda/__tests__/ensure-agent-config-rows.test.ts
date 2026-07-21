/**
 * Tests for ensure-agent-config-rows — the self-healing AGENT_CONFIG_TABLE
 * materializer for the intake orchestration path (Bug B, dual-store gap).
 *
 * Fabricated agents exist ONLY in the AgentCore Registry (the fabricator
 * writes registry-only), so workflow-resolver's verifyAgentsExist BatchGet
 * against the agents table fails for every node → permanent AGENTS_SYNCING.
 * ensureAgentConfigRows heals at the moment of need: for every referenced
 * registry recordId with no agents-table row, it synthesizes the row from
 * the registry record using the SAME mapping registry-sync.ts uses
 * (buildAgentCacheRecord + toInternalState) and creates it with a
 * creation-only conditional Put (existing rows are NEVER touched).
 */

// Env before import — table name is read at call time, but keep parity with
// the registry-sync test conventions.
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';

import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

jest.mock('../agent-config-resolver', () => ({
  getRegistryService: jest.fn(),
}));

import { getRegistryService } from '../agent-config-resolver';
import {
  ensureAgentConfigRows,
  extractAgentIdsFromDefinition,
} from '../ensure-agent-config-rows';

const ddbMock = mockClient(DynamoDBDocumentClient);
const getRegistryServiceMock = getRegistryService as jest.MockedFunction<
  typeof getRegistryService
>;

const TABLE = 'citadel-agents-test';

interface FakeRegistryRecord {
  recordId: string;
  name: string;
  description?: string;
  status: string;
  customDescriptorContent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

function registryRecord(overrides: Partial<FakeRegistryRecord> = {}): FakeRegistryRecord {
  return {
    recordId: 'xL0K6QlfKkEx',
    name: 'ap-billing-agent-v1',
    description: 'Billing agent',
    status: 'APPROVED',
    customDescriptorContent: JSON.stringify({
      categories: ['fabricated'],
      icon: '',
      state: 'active',
      manifest: { name: 'ap-billing-agent-v1', version: '1.0.0' },
      sourceProjectId: 'sess-1',
    }),
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    updatedAt: new Date('2026-07-20T01:00:00.000Z'),
    ...overrides,
  };
}

function mockRegistry(records: Record<string, FakeRegistryRecord | null>): jest.Mock {
  const getResource = jest.fn(async (_type: string, id: string) => records[id] ?? null);
  getRegistryServiceMock.mockReturnValue({
    getResource,
  } as unknown as ReturnType<typeof getRegistryService>);
  return getResource;
}

/** BatchGet responds with rows for exactly these agentIds. */
function mockBatchGetExisting(existingIds: string[]): void {
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const keys = (input.RequestItems?.[TABLE]?.Keys ?? []) as { agentId: string }[];
    const found = keys
      .filter((k) => existingIds.includes(k.agentId))
      .map((k) => ({ agentId: k.agentId }));
    return { Responses: { [TABLE]: found } };
  });
}

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
});

describe('extractAgentIdsFromDefinition', () => {
  it('returns the unique non-empty node agentIds', () => {
    const definition = JSON.stringify({
      nodes: [
        { id: 'a', agentId: 'rec-1' },
        { id: 'b', agentId: 'rec-2' },
        { id: 'c', agentId: 'rec-1' }, // duplicate
        { id: 'd', agentId: '' }, // empty — ignored
        { id: 'e' }, // absent — ignored
      ],
      edges: [],
    });

    expect(extractAgentIdsFromDefinition(definition)).toEqual(['rec-1', 'rec-2']);
  });

  it('returns [] for malformed JSON and non-array nodes', () => {
    expect(extractAgentIdsFromDefinition('not json')).toEqual([]);
    expect(extractAgentIdsFromDefinition(JSON.stringify({ nodes: 'nope' }))).toEqual([]);
  });
});

describe('ensureAgentConfigRows', () => {
  it('creates a missing row synthesized from the registry record with the registry-sync mapping', async () => {
    mockBatchGetExisting([]);
    const getResource = mockRegistry({ xL0K6QlfKkEx: registryRecord() });
    ddbMock.on(PutCommand).resolves({});

    const result = await ensureAgentConfigRows(['xL0K6QlfKkEx']);

    expect(result.ensured).toEqual(['xL0K6QlfKkEx']);
    expect(result.existing).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(getResource).toHaveBeenCalledWith('agent', 'xL0K6QlfKkEx');

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const input = puts[0].args[0].input;
    expect(input.TableName).toBe(TABLE);
    // Creation-only: existing rows must never be clobbered.
    expect(input.ConditionExpression).toBe('attribute_not_exists(agentId)');
    // SAME row mapping as registry-sync.buildAgentCacheRecord.
    expect(input.Item).toMatchObject({
      agentId: 'xL0K6QlfKkEx',
      config: 'Billing agent',
      state: 'active', // APPROVED → active
      categories: ['fabricated'],
      icon: '',
      manifest: { name: 'ap-billing-agent-v1', version: '1.0.0' },
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T01:00:00.000Z',
    });
  });

  it('derives state from the registry record status, not the metadata state (DRAFT → maintenance)', async () => {
    mockBatchGetExisting([]);
    // Metadata claims active, but the record status is DRAFT — the row must
    // NOT come out active (state=active only when the status warrants).
    mockRegistry({ 'rec-draft': registryRecord({ recordId: 'rec-draft', status: 'DRAFT' }) });
    ddbMock.on(PutCommand).resolves({});

    await ensureAgentConfigRows(['rec-draft']);

    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item?.state).toBe('maintenance');
  });

  it('leaves existing rows untouched (no Put)', async () => {
    mockBatchGetExisting(['rec-existing']);
    const getResource = mockRegistry({});

    const result = await ensureAgentConfigRows(['rec-existing']);

    expect(result.existing).toEqual(['rec-existing']);
    expect(result.ensured).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(getResource).not.toHaveBeenCalled();
  });

  it('is idempotent: a concurrent create (conditional failure) counts as existing, never throws', async () => {
    mockBatchGetExisting([]);
    mockRegistry({ 'rec-race': registryRecord({ recordId: 'rec-race' }) });
    ddbMock
      .on(PutCommand)
      .rejects(
        Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        }),
      );

    const result = await ensureAgentConfigRows(['rec-race']);

    expect(result.existing).toEqual(['rec-race']);
    expect(result.ensured).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('double-call is a no-op once the row exists', async () => {
    // First call creates; second call sees the row via BatchGet.
    mockRegistry({ 'rec-1': registryRecord({ recordId: 'rec-1' }) });
    mockBatchGetExisting([]);
    ddbMock.on(PutCommand).resolves({});
    const first = await ensureAgentConfigRows(['rec-1']);
    expect(first.ensured).toEqual(['rec-1']);

    mockBatchGetExisting(['rec-1']);
    const second = await ensureAgentConfigRows(['rec-1']);

    expect(second.existing).toEqual(['rec-1']);
    expect(second.ensured).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1); // only the first call wrote
  });

  it('reports ids with no registry record as failed without writing', async () => {
    mockBatchGetExisting([]);
    mockRegistry({});

    const result = await ensureAgentConfigRows(['rec-ghost']);

    expect(result.failed).toEqual(['rec-ghost']);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('never throws — a hard DynamoDB failure lands in failed', async () => {
    mockBatchGetExisting([]);
    mockRegistry({ 'rec-err': registryRecord({ recordId: 'rec-err' }) });
    ddbMock.on(PutCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(ensureAgentConfigRows(['rec-err'])).resolves.toMatchObject({
      failed: ['rec-err'],
    });
  });

  it('returns empty results for an empty id list without touching DynamoDB', async () => {
    mockRegistry({});

    const result = await ensureAgentConfigRows([]);

    expect(result).toEqual({ ensured: [], existing: [], failed: [] });
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });
});
