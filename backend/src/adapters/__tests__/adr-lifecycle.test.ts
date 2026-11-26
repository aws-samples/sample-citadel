/**
 * Property-based tests for ADR_TRANSITIONS state machine.
 *
 * Matrix locked by QT3-5 §9.
 *
 * Transitions (canonical):
 *   PROPOSED   -> LOCKED | SUPERSEDED
 *   LOCKED     -> SUPERSEDED | REOPENED
 *   REOPENED   -> LOCKED
 *   SUPERSEDED -> (terminal)
 *
 * Invariants asserted:
 *   I1. Matrix exactness: isValidTransition matches QT3-5 exactly for every
 *       documented transition.
 *   I2. Idempotency: isValidTransition(s, s) === true for every s.
 *   I3. Terminality: SUPERSEDED has zero outbound transitions (except itself).
 *   I4. Invalid transitions throw typed errors with helpful messages.
 *   I5. Property test (100 iterations) over random (from, to) pairs:
 *       - pairs in the matrix are accepted
 *       - pairs not in the matrix AND not same-state are rejected
 */

import fc from 'fast-check';
import { LifecycleManager, ADR_TRANSITIONS } from '../lifecycle';

// Canonical matrix from QT3-5.
const EXPECTED_ADR_MATRIX: Record<string, string[]> = {
  PROPOSED: ['LOCKED', 'SUPERSEDED'],
  LOCKED: ['SUPERSEDED', 'REOPENED'],
  REOPENED: ['LOCKED'],
  SUPERSEDED: [],
};

const ALL_ADR_STATUSES = Object.keys(EXPECTED_ADR_MATRIX);

describe('ADR_TRANSITIONS', () => {
  describe('structural correctness', () => {
    test('exports a TransitionMap with transitions and actions', () => {
      expect(ADR_TRANSITIONS).toBeDefined();
      expect(ADR_TRANSITIONS.transitions).toBeDefined();
      expect(ADR_TRANSITIONS.actions).toBeDefined();
    });

    test('covers all 4 ADRStatus enum values', () => {
      const keys = Object.keys(ADR_TRANSITIONS.transitions).sort();
      expect(keys).toEqual(['LOCKED', 'PROPOSED', 'REOPENED', 'SUPERSEDED']);
    });

    test('matches the QT3-5 canonical matrix exactly', () => {
      for (const [from, expectedTo] of Object.entries(EXPECTED_ADR_MATRIX)) {
        expect([...ADR_TRANSITIONS.transitions[from]].sort()).toEqual(
          [...expectedTo].sort()
        );
      }
    });
  });

  describe('documented transitions (explicit)', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);

    test.each([
      ['PROPOSED', 'LOCKED'],
      ['PROPOSED', 'SUPERSEDED'],
      ['LOCKED', 'SUPERSEDED'],
      ['LOCKED', 'REOPENED'],
      ['REOPENED', 'LOCKED'],
    ])('accepts %s -> %s', (from, to) => {
      expect(lifecycle.isValidTransition(from, to)).toBe(true);
    });
  });

  describe('same-state idempotence', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);

    test.each(ALL_ADR_STATUSES)('same-state transition for %s is valid', (s) => {
      expect(lifecycle.isValidTransition(s, s)).toBe(true);
    });
  });

  describe('terminal state SUPERSEDED', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);

    test.each(
      ALL_ADR_STATUSES.filter((s) => s !== 'SUPERSEDED')
    )('SUPERSEDED -> %s is invalid', (to) => {
      expect(lifecycle.isValidTransition('SUPERSEDED', to)).toBe(false);
    });

    test('SUPERSEDED -> SUPERSEDED remains idempotent', () => {
      expect(lifecycle.isValidTransition('SUPERSEDED', 'SUPERSEDED')).toBe(true);
    });
  });

  describe('validateTransition error messages', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);

    test('throws with helpful error message on invalid transition', () => {
      expect(() => lifecycle.validateTransition('SUPERSEDED', 'LOCKED')).toThrow(
        /Invalid status transition:\s*SUPERSEDED\s*→\s*LOCKED/
      );
    });

    test('lists valid next statuses in the error', () => {
      expect(() => lifecycle.validateTransition('PROPOSED', 'REOPENED')).toThrow(
        /LOCKED.*SUPERSEDED|SUPERSEDED.*LOCKED/
      );
    });
  });

  describe('canPerform action gates', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);

    test('lock is allowed from PROPOSED and REOPENED', () => {
      expect(lifecycle.canPerform('lock', 'PROPOSED')).toBe(true);
      expect(lifecycle.canPerform('lock', 'REOPENED')).toBe(true);
      expect(lifecycle.canPerform('lock', 'LOCKED')).toBe(false);
      expect(lifecycle.canPerform('lock', 'SUPERSEDED')).toBe(false);
    });

    test('supersede is allowed from PROPOSED and LOCKED', () => {
      expect(lifecycle.canPerform('supersede', 'PROPOSED')).toBe(true);
      expect(lifecycle.canPerform('supersede', 'LOCKED')).toBe(true);
      expect(lifecycle.canPerform('supersede', 'SUPERSEDED')).toBe(false);
      expect(lifecycle.canPerform('supersede', 'REOPENED')).toBe(false);
    });

    test('reopen is allowed only from LOCKED', () => {
      expect(lifecycle.canPerform('reopen', 'LOCKED')).toBe(true);
      expect(lifecycle.canPerform('reopen', 'PROPOSED')).toBe(false);
      expect(lifecycle.canPerform('reopen', 'SUPERSEDED')).toBe(false);
      expect(lifecycle.canPerform('reopen', 'REOPENED')).toBe(false);
    });
  });

  describe('property: random (from, to) pairs', () => {
    const lifecycle = new LifecycleManager(ADR_TRANSITIONS);
    const statusArb = fc.constantFrom(...ALL_ADR_STATUSES);

    test('pairs in the matrix are accepted, pairs not in the matrix and not same-state are rejected', () => {
      fc.assert(
        fc.property(statusArb, statusArb, (from, to) => {
          const inMatrix = EXPECTED_ADR_MATRIX[from]?.includes(to) ?? false;
          const sameState = from === to;
          const expected = inMatrix || sameState;
          expect(lifecycle.isValidTransition(from, to)).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });

    test('random non-ADR "to" strings are always rejected (unless equal to "from")', () => {
      fc.assert(
        fc.property(
          statusArb,
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !ALL_ADR_STATUSES.includes(s)),
          (from, randomTo) => {
            expect(lifecycle.isValidTransition(from, randomTo)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
