/**
 * Property tests for the shared ingestion status model.
 * The core invariant: classifyStatus is TOTAL — it returns exactly one of the
 * three dispositions for ANY string (and for null/undefined), and is consistent
 * with the SUCCESS/FAILED status sets.
 */
import fc from 'fast-check';
import {
  classifyStatus,
  isTerminal,
  normalizeTransientStatus,
  SUCCESS_STATUSES,
  FAILED_STATUSES,
  POLLABLE_STATUSES,
  TERMINAL_STATUSES,
} from '../document-ingestion-shared';

const ALL_BEDROCK_STATUSES = [
  'STARTING',
  'IN_PROGRESS',
  'PENDING',
  'INDEXED',
  'PARTIALLY_INDEXED',
  'FAILED',
  'METADATA_UPDATE_FAILED',
  'IGNORED',
  'NOT_FOUND',
  'DELETING',
  'DELETE_IN_PROGRESS',
  'EMBEDDING',
  'TIMEOUT',
];

describe('classifyStatus (total mapping)', () => {
  test('returns a valid disposition for every arbitrary string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const d = classifyStatus(s);
        return d === 'SUCCESS' || d === 'FAILED' || d === 'TRANSIENT';
      })
    );
  });

  test('handles null and undefined as TRANSIENT', () => {
    expect(classifyStatus(null)).toBe('TRANSIENT');
    expect(classifyStatus(undefined)).toBe('TRANSIENT');
  });

  test('is consistent with the SUCCESS / FAILED sets across known Bedrock statuses', () => {
    for (const status of ALL_BEDROCK_STATUSES) {
      const d = classifyStatus(status);
      if (SUCCESS_STATUSES.has(status)) expect(d).toBe('SUCCESS');
      else if (FAILED_STATUSES.has(status)) expect(d).toBe('FAILED');
      else expect(d).toBe('TRANSIENT');
    }
  });

  test('SUCCESS and FAILED status sets are disjoint', () => {
    for (const s of SUCCESS_STATUSES) {
      expect(FAILED_STATUSES.has(s)).toBe(false);
    }
  });

  test('isTerminal is true for every SUCCESS/FAILED/TIMEOUT status and never for pollable statuses', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_BEDROCK_STATUSES), (status) => {
        const terminal = isTerminal(status);
        if (TERMINAL_STATUSES.has(status)) return terminal === true;
        return terminal === false;
      })
    );
  });

  test('normalizeTransientStatus always yields a pollable status', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return (POLLABLE_STATUSES as readonly string[]).includes(normalizeTransientStatus(s));
      })
    );
  });
});
