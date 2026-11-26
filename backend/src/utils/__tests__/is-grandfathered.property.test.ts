/**
 * Tests for the grandfathering bypass helper (tasks 3.7 + 3.8).
 *
 * Covers:
 *   - Pure helper `isGrandfatheredPure` — exhaustive deterministic + 500-iter property tests.
 *   - I/O wrapper `isGrandfathered(project, env)` — SSM effective_at wiring.
 *   - Telemetry helper `emitGrandfatheredBypass` — governance.grandfathered.bypass emit.
 */

import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import * as fc from 'fast-check';
import {
  isGrandfathered,
  isGrandfatheredPure,
  emitGrandfatheredBypass,
  type GrandfatheredBypassedGate,
} from '../is-grandfathered';
import { __resetGovernanceFlagCacheForTest } from '../governance-flag';
import { __resetGovernanceNotifierForTest } from '../notifier-base';

const ssmMock = mockClient(SSMClient);
const ebMock = mockClient(EventBridgeClient);

describe('is-grandfathered', () => {
  beforeEach(() => {
    ssmMock.reset();
    ebMock.reset();
    __resetGovernanceFlagCacheForTest();
    __resetGovernanceNotifierForTest();
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e' }] });
  });

  // -------------------------------------------------------------------------
  // Pure helper — pre-shadow-flip (null / empty effectiveAt)
  // Backlog AC 3 — everyone grandfathered until effective_at is written.
  // -------------------------------------------------------------------------
  describe('isGrandfatheredPure: pre-shadow-flip (no cutoff)', () => {
    test('null effectiveAt with normal createdAt → true', () => {
      expect(isGrandfatheredPure('2026-05-10T00:00:00Z', null)).toBe(true);
    });

    test('empty-string effectiveAt with normal createdAt → true', () => {
      expect(isGrandfatheredPure('2026-05-10T00:00:00Z', '')).toBe(true);
    });

    test('distant-future createdAt + null cutoff still grandfathered', () => {
      expect(isGrandfatheredPure('9999-12-31T23:59:59Z', null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pure helper — ISO-8601 lexicographic comparison
  // Backlog AC 1 — createdAt strictly before cutoff is grandfathered;
  // exact cutoff is NOT; after cutoff is NOT.
  // -------------------------------------------------------------------------
  describe('isGrandfatheredPure: ISO-8601 comparisons', () => {
    test('createdAt before effectiveAt → true', () => {
      expect(
        isGrandfatheredPure('2026-05-10T00:00:00Z', '2026-05-15T00:00:00Z'),
      ).toBe(true);
    });

    test('createdAt exactly equal to effectiveAt → false (cutoff is NOT grandfathered)', () => {
      expect(
        isGrandfatheredPure('2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z'),
      ).toBe(false);
    });

    test('createdAt after effectiveAt → false', () => {
      expect(
        isGrandfatheredPure('2026-05-20T00:00:00Z', '2026-05-15T00:00:00Z'),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Pure helper — conservative bypass on malformed createdAt
  // Phase-1 must not convert a data defect into a hard failure. Bypass, don't block.
  // -------------------------------------------------------------------------
  describe('isGrandfatheredPure: malformed createdAt → conservative bypass', () => {
    test('undefined createdAt → true', () => {
      expect(isGrandfatheredPure(undefined, '2026-05-15T00:00:00Z')).toBe(true);
    });

    test('null createdAt → true', () => {
      expect(isGrandfatheredPure(null, '2026-05-15T00:00:00Z')).toBe(true);
    });

    test('empty-string createdAt → true', () => {
      expect(isGrandfatheredPure('', '2026-05-15T00:00:00Z')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Property tests — backlog AC 4 demands ≥500 iterations.
  // Pure function, synchronous callback, no mocks touched inside.
  // -------------------------------------------------------------------------
  describe('isGrandfatheredPure: property tests (500 iters)', () => {
    test('matches createdAt < effectiveAt exactly', () => {
      // noInvalidDate: true guarantees fc.date will not produce Invalid Date
      // (e.g. from NaN timestamps), so .toISOString() is always safe.
      const dateArb = fc.date({
        min: new Date('2020-01-01T00:00:00Z'),
        max: new Date('2030-12-31T23:59:59Z'),
        noInvalidDate: true,
      });
      fc.assert(
        fc.property(
          dateArb,
          dateArb,
          (createdAtDate, effectiveAtDate) => {
            const createdAt = createdAtDate.toISOString();
            const effectiveAt = effectiveAtDate.toISOString();
            const expected = createdAt < effectiveAt;
            return isGrandfatheredPure(createdAt, effectiveAt) === expected;
          },
        ),
        { numRuns: 500 },
      );
    });

    test('empty or null effectiveAt ALWAYS grandfathers, for any createdAt shape', () => {
      fc.assert(
        fc.property(
          // Keep string lengths short to avoid uniform-character payloads (QB-003-1 ReDoS lesson).
          fc.oneof(
            fc.string({ maxLength: 32 }),
            fc.constant(null),
            fc.constant(undefined),
          ),
          (createdAt) => {
            return (
              isGrandfatheredPure(createdAt as string | null | undefined, '') === true &&
              isGrandfatheredPure(createdAt as string | null | undefined, null) === true
            );
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // I/O wrapper — isGrandfathered(project, env)
  // -------------------------------------------------------------------------
  describe('isGrandfathered (I/O wrapper)', () => {
    // Use consistent SSM param naming matching governance-flag.ts.
    const enforceParam = (env: string) => `/citadel/governance/enforce/${env}`;
    const effectiveAtParam = (env: string) => `/citadel/governance/effective_at/${env}`;

    test('project createdAt before SSM effective_at → true', async () => {
      ssmMock
        .on(GetParameterCommand, { Name: enforceParam('dev') })
        .resolves({ Parameter: { Value: 'shadow' } });
      ssmMock
        .on(GetParameterCommand, { Name: effectiveAtParam('dev') })
        .resolves({ Parameter: { Value: '2026-05-15T00:00:00Z' } });

      const result = await isGrandfathered(
        { createdAt: '2026-05-10T00:00:00Z' },
        'dev',
      );
      expect(result).toBe(true);
    });

    test('project createdAt after SSM effective_at → false', async () => {
      ssmMock
        .on(GetParameterCommand, { Name: enforceParam('dev') })
        .resolves({ Parameter: { Value: 'shadow' } });
      ssmMock
        .on(GetParameterCommand, { Name: effectiveAtParam('dev') })
        .resolves({ Parameter: { Value: '2026-05-15T00:00:00Z' } });

      const result = await isGrandfathered(
        { createdAt: '2026-05-20T00:00:00Z' },
        'dev',
      );
      expect(result).toBe(false);
    });

    test('empty SSM effective_at → true for any createdAt', async () => {
      ssmMock
        .on(GetParameterCommand, { Name: enforceParam('dev') })
        .resolves({ Parameter: { Value: 'permissive' } });
      ssmMock
        .on(GetParameterCommand, { Name: effectiveAtParam('dev') })
        .resolves({ Parameter: { Value: '' } });

      expect(
        await isGrandfathered({ createdAt: '2026-05-20T00:00:00Z' }, 'dev'),
      ).toBe(true);
      expect(
        await isGrandfathered({ createdAt: '2099-01-01T00:00:00Z' }, 'dev'),
      ).toBe(true);
    });

    test('throws when neither env arg nor process.env.ENVIRONMENT is set', async () => {
      const prevEnv = process.env.ENVIRONMENT;
      delete process.env.ENVIRONMENT;
      try {
        await expect(
          isGrandfathered({ createdAt: '2026-05-10T00:00:00Z' }),
        ).rejects.toThrow(/env argument or process\.env\.ENVIRONMENT must be set/);
      } finally {
        if (prevEnv !== undefined) process.env.ENVIRONMENT = prevEnv;
      }
    });

    test('explicit env argument overrides process.env.ENVIRONMENT', async () => {
      const prevEnv = process.env.ENVIRONMENT;
      process.env.ENVIRONMENT = 'prod';
      try {
        ssmMock
          .on(GetParameterCommand, { Name: enforceParam('dev') })
          .resolves({ Parameter: { Value: 'shadow' } });
        ssmMock
          .on(GetParameterCommand, { Name: effectiveAtParam('dev') })
          .resolves({ Parameter: { Value: '2026-05-15T00:00:00Z' } });

        const result = await isGrandfathered(
          { createdAt: '2026-05-10T00:00:00Z' },
          'dev',
        );
        expect(result).toBe(true);

        // Assert both calls targeted the dev-scoped params (not prod).
        const calls = ssmMock.commandCalls(GetParameterCommand);
        const names = calls.map((c) => c.args[0].input.Name);
        expect(names).toContain(effectiveAtParam('dev'));
        expect(names).not.toContain(effectiveAtParam('prod'));
      } finally {
        if (prevEnv === undefined) delete process.env.ENVIRONMENT;
        else process.env.ENVIRONMENT = prevEnv;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Telemetry helper — emitGrandfatheredBypass
  // -------------------------------------------------------------------------
  describe('emitGrandfatheredBypass', () => {
    test('emits exactly one PutEventsCommand with correct Source + DetailType', async () => {
      process.env.EVENT_BUS_NAME = 'citadel-agents-test';
      await emitGrandfatheredBypass(
        'proj-123',
        'C3_assessment_required',
        '2026-05-10T00:00:00Z',
        '2026-05-15T00:00:00Z',
      );

      const calls = ebMock.commandCalls(PutEventsCommand);
      expect(calls).toHaveLength(1);
      const entry = calls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.backend');
      expect(entry.DetailType).toBe('governance.grandfathered.bypass');
    });

    test('Detail field parses to JSON with matching payload fields', async () => {
      await emitGrandfatheredBypass(
        'proj-xyz',
        'C7_adr_required',
        '2026-01-02T03:04:05Z',
        '2026-05-15T00:00:00Z',
      );

      const entry = ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0];
      const detail = JSON.parse(entry.Detail!);
      expect(detail.projectId).toBe('proj-xyz');
      expect(detail.bypassedGate).toBe('C7_adr_required');
      expect(detail.projectCreatedAt).toBe('2026-01-02T03:04:05Z');
      expect(detail.effectiveAt).toBe('2026-05-15T00:00:00Z');
      // notifier-base stamps a timestamp into every envelope.
      expect(detail.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('accepts all three GrandfatheredBypassedGate literal values', async () => {
      const gates: GrandfatheredBypassedGate[] = [
        'C3_assessment_required',
        'C7_adr_required',
        'C10_spec_required',
      ];
      for (const gate of gates) {
        await emitGrandfatheredBypass(
          'proj-a',
          gate,
          '2026-05-10T00:00:00Z',
          '2026-05-15T00:00:00Z',
        );
      }
      const calls = ebMock.commandCalls(PutEventsCommand);
      expect(calls).toHaveLength(3);
      const gatesSeen = calls.map(
        (c) => JSON.parse(c.args[0].input.Entries![0].Detail!).bypassedGate,
      );
      expect(gatesSeen).toEqual([
        'C3_assessment_required',
        'C7_adr_required',
        'C10_spec_required',
      ]);
    });

    test('propagates correlationId into the emitted envelope', async () => {
      await emitGrandfatheredBypass(
        'proj-c',
        'C10_spec_required',
        '2026-05-10T00:00:00Z',
        '2026-05-15T00:00:00Z',
        'corr-xyz-42',
      );
      const detail = JSON.parse(
        ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!,
      );
      expect(detail.correlationId).toBe('corr-xyz-42');
    });

    test('omitting correlationId produces no correlationId field', async () => {
      await emitGrandfatheredBypass(
        'proj-d',
        'C3_assessment_required',
        '2026-05-10T00:00:00Z',
        '2026-05-15T00:00:00Z',
      );
      const detail = JSON.parse(
        ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!,
      );
      expect(detail.correlationId).toBeUndefined();
    });
  });
});
