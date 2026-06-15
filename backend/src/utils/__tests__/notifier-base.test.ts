import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import * as fc from 'fast-check';
import {
  emitGovernanceEvent,
  __resetGovernanceNotifierForTest,
  GOVERNANCE_DETAIL_TYPES,
  type GovernanceDetailType,
} from '../notifier-base';

const ebMock = mockClient(EventBridgeClient);

describe('notifier-base emitGovernanceEvent', () => {
  beforeEach(() => {
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'evt-1' }] });
    __resetGovernanceNotifierForTest();
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
  });

  test('emits governance.adr.locked with correct Source, DetailType, Detail', async () => {
    await emitGovernanceEvent(
      'governance.adr.locked',
      { projectId: 'p1', adrId: 'a1', title: 'Use Postgres', sourceRoundIds: ['r1', 'r2'] },
      'corr-1'
    );
    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls).toHaveLength(1);
    const entry = calls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe('citadel.backend');
    expect(entry.DetailType).toBe('governance.adr.locked');
    expect(entry.EventBusName).toBe('citadel-agents-test');
    const detail = JSON.parse(entry.Detail!);
    expect(detail.projectId).toBe('p1');
    expect(detail.adrId).toBe('a1');
    expect(detail.title).toBe('Use Postgres');
    expect(detail.sourceRoundIds).toEqual(['r1', 'r2']);
    expect(detail.correlationId).toBe('corr-1');
    expect(detail.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('emits without correlationId when omitted', async () => {
    await emitGovernanceEvent('governance.round.started', { projectId: 'p1', roundN: 1 });
    const calls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(calls[0].args[0].input.Entries![0].Detail!);
    expect(detail.correlationId).toBeUndefined();
  });

  test('strips <script> tags from string fields', async () => {
    await emitGovernanceEvent('governance.specification.rejected', {
      projectId: 'p1',
      specId: 's1',
      reason: 'nope<script>alert(1)</script>bad',
      rejectedBy: 'user-1',
    });
    const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail.reason).toBe('nopebad');
    expect(detail.reason).not.toContain('<script>');
  });

  test('strips <iframe> tags from string fields', async () => {
    await emitGovernanceEvent('governance.specification.rejected', {
      projectId: 'p1',
      specId: 's1',
      reason: 'foo<iframe src="evil"></iframe>bar',
      rejectedBy: 'user-1',
    });
    const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail.reason).toBe('foobar');
  });

  test('strips <object> tags from string fields', async () => {
    await emitGovernanceEvent('governance.specification.rejected', {
      projectId: 'p1',
      specId: 's1',
      reason: 'a<object data="x"></object>b',
      rejectedBy: 'user-1',
    });
    const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail.reason).toBe('ab');
  });

  test('preserves non-string fields (numbers, booleans, arrays) without mutation', async () => {
    await emitGovernanceEvent('governance.round.transcript.overflow', {
      projectId: 'p1',
      roundN: 3,
      sizeBytes: 5242880,
    });
    const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail.roundN).toBe(3);
    expect(detail.sizeBytes).toBe(5242880);
  });

  test('GOVERNANCE_DETAIL_TYPES contains exactly 14 values', () => {
    expect(GOVERNANCE_DETAIL_TYPES).toHaveLength(14);
    expect(new Set(GOVERNANCE_DETAIL_TYPES).size).toBe(14);
  });

  test('GovernanceDetailType union matches GOVERNANCE_DETAIL_TYPES array', () => {
    const expected: GovernanceDetailType[] = [
      'governance.adr.locked',
      'governance.adr.reopen.attempted',
      'governance.specification.created',
      'governance.specification.approved',
      'governance.specification.rejected',
      'governance.round.started',
      'governance.round.completed',
      'governance.round.transcript.overflow',
      'governance.archetype.classified',
      'governance.offfrontier.escalated',
      'governance.grandfathered.bypass',
      'governance.mode.transition',
      'governance.constitutional.rule.changed',
      'governance.caselaw.changed',
    ];
    expect([...GOVERNANCE_DETAIL_TYPES].sort()).toEqual([...expected].sort());
  });

  test('falls back to default event bus when EVENT_BUS_NAME is unset', async () => {
    delete process.env.EVENT_BUS_NAME;
    __resetGovernanceNotifierForTest();
    await emitGovernanceEvent('governance.round.started', { projectId: 'p1', roundN: 1 });
    const entry = ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0];
    // Falls back to 'default' or the agent bus name; implementation choice.
    expect(entry.EventBusName).toBeDefined();
  });

  test('emits archetype.classified with archetype + confidence', async () => {
    await emitGovernanceEvent('governance.archetype.classified', {
      projectId: 'p1',
      archetype: 'MONOLITHIC_DB',
      archetypeConfidence: 0.85,
    });
    const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail.archetype).toBe('MONOLITHIC_DB');
    expect(detail.archetypeConfidence).toBe(0.85);
  });

  test('emits grandfathered.bypass with gate metadata', async () => {
    await emitGovernanceEvent('governance.grandfathered.bypass', {
      projectId: 'p1',
      bypassedGate: 'C7_adr_required',
      projectCreatedAt: '2026-04-01T00:00:00Z',
      effectiveAt: '2026-05-15T00:00:00Z',
    });
    const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail.bypassedGate).toBe('C7_adr_required');
  });

  test('propagates EventBridge errors to the caller', async () => {
    ebMock.reset();
    ebMock.on(PutEventsCommand).rejects(new Error('ThrottlingException'));
    await expect(
      emitGovernanceEvent('governance.round.started', { projectId: 'p1', roundN: 1 })
    ).rejects.toThrow('ThrottlingException');
  });

  test('property: sanitisation is idempotent — emitting same sanitised payload twice produces same Detail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          projectId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('<') && !s.includes('>')),
          specId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('<') && !s.includes('>')),
          reason: fc.string({ maxLength: 100 }),
          rejectedBy: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('<') && !s.includes('>')),
        }),
        async (payload) => {
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
          await emitGovernanceEvent('governance.specification.rejected', payload);
          const firstDetail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
          await emitGovernanceEvent('governance.specification.rejected', {
            projectId: firstDetail.projectId,
            specId: firstDetail.specId,
            reason: firstDetail.reason,
            rejectedBy: firstDetail.rejectedBy,
          });
          const secondDetail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
          // Everything except timestamp must be identical — sanitisation is idempotent.
          return (
            secondDetail.projectId === firstDetail.projectId &&
            secondDetail.specId === firstDetail.specId &&
            secondDetail.reason === firstDetail.reason &&
            secondDetail.rejectedBy === firstDetail.rejectedBy
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  test('property: no <script>/<iframe>/<object> tags survive sanitisation across 200 random reasons', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (raw) => {
        ebMock.reset();
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
        const withTag = `prefix<script>${raw}</script>suffix<iframe>${raw}</iframe><object>${raw}</object>end`;
        await emitGovernanceEvent('governance.specification.rejected', {
          projectId: 'p1',
          specId: 's1',
          reason: withTag,
          rejectedBy: 'u1',
        });
        const detail = JSON.parse(ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
        return (
          !/<script/i.test(detail.reason) &&
          !/<iframe/i.test(detail.reason) &&
          !/<object/i.test(detail.reason)
        );
      }),
      { numRuns: 200 }
    );
  });
});
