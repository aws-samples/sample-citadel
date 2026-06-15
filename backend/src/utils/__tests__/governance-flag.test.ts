import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  getGovernanceEnforce,
  getGovernanceEffectiveAt,
  __resetGovernanceFlagCacheForTest,
  type GovernanceEnforce,
} from '../governance-flag';

const ssmMock = mockClient(SSMClient);

describe('governance-flag', () => {
  const ENV = 'dev';

  beforeEach(() => {
    ssmMock.reset();
    __resetGovernanceFlagCacheForTest();
  });

  test('returns permissive when parameter value is "permissive"', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'permissive' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '' } });
    expect(await getGovernanceEnforce(ENV)).toBe('permissive');
  });

  test('returns shadow with a populated effective_at', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'shadow' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '2026-05-15T00:00:00Z' } });
    expect(await getGovernanceEnforce(ENV)).toBe('shadow');
    expect(await getGovernanceEffectiveAt(ENV)).toBe('2026-05-15T00:00:00Z');
  });

  test('returns strict', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'strict' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '2026-05-15T00:00:00Z' } });
    expect(await getGovernanceEnforce(ENV)).toBe('strict');
  });

  test('falls back to permissive on SSM error', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('ParameterNotFound'));
    expect(await getGovernanceEnforce(ENV)).toBe('permissive');
  });

  test('falls back to permissive for unrecognised value', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'anarchy' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '' } });
    expect(await getGovernanceEnforce(ENV)).toBe('permissive');
  });

  test('effective_at null when empty', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'permissive' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '' } });
    expect(await getGovernanceEffectiveAt(ENV)).toBeNull();
  });

  test('effective_at null when absent (SSM error)', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'permissive' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .rejects(new Error('ParameterNotFound'));
    expect(await getGovernanceEffectiveAt(ENV)).toBeNull();
  });

  test('cache hit within TTL produces only one SSM batch', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'shadow' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '2026-05-15T00:00:00Z' } });

    await getGovernanceEnforce(ENV);
    await getGovernanceEnforce(ENV);
    await getGovernanceEffectiveAt(ENV);

    expect(ssmMock.calls().length).toBe(2);
  });

  test('__resetGovernanceFlagCacheForTest forces reload', async () => {
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/enforce/${ENV}` })
      .resolves({ Parameter: { Value: 'permissive' } });
    ssmMock.on(GetParameterCommand, { Name: `/citadel/governance/effective_at/${ENV}` })
      .resolves({ Parameter: { Value: '' } });

    await getGovernanceEnforce(ENV);
    __resetGovernanceFlagCacheForTest();
    await getGovernanceEnforce(ENV);

    expect(ssmMock.calls().length).toBe(4);
  });

  test('GovernanceEnforce permits three literals', () => {
    const valid: GovernanceEnforce[] = ['permissive', 'shadow', 'strict'];
    expect(valid).toHaveLength(3);
  });
});
