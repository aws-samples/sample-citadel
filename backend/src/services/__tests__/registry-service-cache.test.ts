/**
 * Unit tests for RegistryService.resolveRecordId LRU caching:
 * - 12-char recordId fast path bypasses cache (no list call)
 * - Name lookup populates cache; second call avoids the list
 * - TTL expiry forces a re-list
 * - LRU eviction at capacity (oldest insertion drops first)
 * - Manual clearRecordIdCache() empties the cache
 *
 * The cache is per-instance and bounded by size + TTL. These tests stub
 * `listResources` directly so the assertions focus on caching behaviour
 * rather than the SDK pagination/filtering already covered elsewhere.
 */

import { RegistryService, RegistryRecord } from '../registry-service';

jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
  SubmitRegistryRecordForApprovalCommand: jest.fn(),
  DescriptorType: { CUSTOM: 'CUSTOM' },
  RegistryRecordStatus: {},
}));

function makeRecord(name: string, recordId: string): RegistryRecord {
  return {
    recordId,
    name,
    status: 'APPROVED',
  };
}

describe('RegistryService.resolveRecordId — LRU cache', () => {
  let service: RegistryService;
  let listSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new RegistryService({
      registryId: 'test-registry',
      region: 'us-east-1',
    });
    listSpy = jest.spyOn(service, 'listResources');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns 12-char recordIds directly without calling listResources', async () => {
    const result = await service.resolveRecordId('agent', 'agt000000001');

    expect(result).toBe('agt000000001');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('populates cache on name lookup; second call does not list again', async () => {
    listSpy.mockResolvedValue([
      makeRecord('email_validator_agent', 'agt000000001'),
    ]);

    const first = await service.resolveRecordId('agent', 'email_validator_agent');
    expect(first).toBe('agt000000001');
    expect(listSpy).toHaveBeenCalledTimes(1);

    const second = await service.resolveRecordId('agent', 'email_validator_agent');
    expect(second).toBe('agt000000001');
    // Cache hit — no additional list call.
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries per resource type', async () => {
    listSpy.mockImplementation(async (type) => {
      if (type === 'agent') return [makeRecord('shared_name', 'agt000000001')];
      return [makeRecord('shared_name', 'tol000000001')];
    });

    const agentId = await service.resolveRecordId('agent', 'shared_name');
    const toolId = await service.resolveRecordId('tool', 'shared_name');
    expect(agentId).toBe('agt000000001');
    expect(toolId).toBe('tol000000001');
    // Two distinct cache keys → two list calls.
    expect(listSpy).toHaveBeenCalledTimes(2);

    // Repeats served from cache.
    await service.resolveRecordId('agent', 'shared_name');
    await service.resolveRecordId('tool', 'shared_name');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('re-lists after the TTL expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    listSpy.mockResolvedValue([
      makeRecord('email_validator_agent', 'agt000000001'),
    ]);

    await service.resolveRecordId('agent', 'email_validator_agent');
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Advance past the 60s TTL.
    jest.setSystemTime(new Date('2026-01-01T00:01:01Z'));

    await service.resolveRecordId('agent', 'email_validator_agent');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry when capacity is exceeded', async () => {
    // Default cache max is 500. Seed 501 distinct names; the first one
    // inserted ("agent_0") must fall out when entry 500 ("agent_500") goes in.
    const records = Array.from({ length: 501 }, (_, i) =>
      makeRecord(`agent_${i}`, `rec${String(i).padStart(9, '0')}`),
    );

    listSpy.mockResolvedValue(records);

    for (let i = 0; i < 501; i++) {
      await service.resolveRecordId('agent', `agent_${i}`);
    }
    const callsAfterSeed = listSpy.mock.calls.length;
    expect(callsAfterSeed).toBe(501);

    // `agent_1` was inserted second and should still be cached → no new call.
    await service.resolveRecordId('agent', 'agent_1');
    expect(listSpy).toHaveBeenCalledTimes(callsAfterSeed);

    // `agent_0` was the oldest insertion and must have been evicted →
    // a fresh list call is required.
    await service.resolveRecordId('agent', 'agent_0');
    expect(listSpy).toHaveBeenCalledTimes(callsAfterSeed + 1);
  });

  it('clearRecordIdCache() forces a re-list on the next call', async () => {
    listSpy.mockResolvedValue([
      makeRecord('email_validator_agent', 'agt000000001'),
    ]);

    await service.resolveRecordId('agent', 'email_validator_agent');
    expect(listSpy).toHaveBeenCalledTimes(1);

    service.clearRecordIdCache();

    await service.resolveRecordId('agent', 'email_validator_agent');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('does not cache misses — a missing name re-lists on retry', async () => {
    listSpy.mockResolvedValue([]);

    await expect(
      service.resolveRecordId('agent', 'missing_agent'),
    ).rejects.toThrow('Registry record not found for agent: missing_agent');
    await expect(
      service.resolveRecordId('agent', 'missing_agent'),
    ).rejects.toThrow('Registry record not found for agent: missing_agent');

    // No cache entry was written, so both calls hit listResources.
    expect(listSpy).toHaveBeenCalledTimes(2);
  });
});
