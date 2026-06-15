/**
 * Property-based tests for PROJECT_TRANSITIONS state machine.
 *
 * Implements §1.
 * Matrix locked by QT3-1 §9.
 *
 * Invariants asserted:
 *   I1. Idempotency: isValidTransition(s, s) === true for every s.
 *   I2. Matrix exactness: the transition set matches QT3-1 exactly.
 *   I3. Invalid transitions throw typed errors with helpful messages.
 *   I4. canPerform actions align with matrix.
 */

import fc from 'fast-check';
import { LifecycleManager, PROJECT_TRANSITIONS } from '../lifecycle';

// Canonical matrix from QT3-1.
const EXPECTED_PROJECT_MATRIX: Record<string, string[]> = {
  CREATED: ['IN_PROGRESS', 'ERROR'],
  IN_PROGRESS: ['ASSESSMENT_COMPLETE', 'ERROR'],
  ASSESSMENT_COMPLETE: ['DESIGN_COMPLETE', 'ERROR'],
  DESIGN_COMPLETE: ['PLANNING_COMPLETE', 'ERROR'],
  PLANNING_COMPLETE: ['IMPLEMENTATION_READY', 'ERROR'],
  IMPLEMENTATION_READY: ['COMPLETED', 'ERROR'],
  COMPLETED: [],
  ERROR: ['IN_PROGRESS', 'COMPLETED'],
};

const ALL_PROJECT_STATUSES = Object.keys(EXPECTED_PROJECT_MATRIX);

describe('PROJECT_TRANSITIONS', () => {
  describe('structural correctness', () => {
    test('exports a TransitionMap with transitions and actions', () => {
      expect(PROJECT_TRANSITIONS).toBeDefined();
      expect(PROJECT_TRANSITIONS.transitions).toBeDefined();
      expect(PROJECT_TRANSITIONS.actions).toBeDefined();
    });

    test('covers all 8 ProjectStatus enum values', () => {
      const keys = Object.keys(PROJECT_TRANSITIONS.transitions).sort();
      expect(keys).toEqual(ALL_PROJECT_STATUSES.slice().sort());
    });

    test('transition matrix matches QT3-1 exactly', () => {
      for (const status of ALL_PROJECT_STATUSES) {
        const actual = (PROJECT_TRANSITIONS.transitions[status] || []).slice().sort();
        const expected = EXPECTED_PROJECT_MATRIX[status].slice().sort();
        expect(actual).toEqual(expected);
      }
    });

    test('COMPLETED is terminal (no outgoing transitions)', () => {
      expect(PROJECT_TRANSITIONS.transitions.COMPLETED).toEqual([]);
    });

    test('ERROR can recover to IN_PROGRESS or be abandoned to COMPLETED', () => {
      expect(PROJECT_TRANSITIONS.transitions.ERROR.sort()).toEqual(['COMPLETED', 'IN_PROGRESS']);
    });
  });

  describe('I1 idempotency (any status -> same status is always valid)', () => {
    const lm = new LifecycleManager(PROJECT_TRANSITIONS);

    test.each(ALL_PROJECT_STATUSES)('%s -> %s is valid (idempotent)', (s) => {
      expect(lm.isValidTransition(s, s)).toBe(true);
    });

    test('property: for every status s, isValidTransition(s, s) === true', () => {
      fc.assert(
        fc.property(fc.constantFrom(...ALL_PROJECT_STATUSES), (s) => {
          return lm.isValidTransition(s, s) === true;
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('I2 matrix exactness (property-tested)', () => {
    const lm = new LifecycleManager(PROJECT_TRANSITIONS);

    test('property: isValidTransition(a, b) iff b is in the expected matrix for a (or a === b)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_PROJECT_STATUSES),
          fc.constantFrom(...ALL_PROJECT_STATUSES),
          (from, to) => {
            const expected = from === to || EXPECTED_PROJECT_MATRIX[from].includes(to);
            return lm.isValidTransition(from, to) === expected;
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('I3 validateTransition error behaviour', () => {
    const lm = new LifecycleManager(PROJECT_TRANSITIONS);

    test('throws with descriptive message on invalid transition', () => {
      expect(() => lm.validateTransition('ASSESSMENT_COMPLETE', 'IMPLEMENTATION_READY')).toThrow(
        /Invalid status transition: ASSESSMENT_COMPLETE → IMPLEMENTATION_READY/
      );
    });

    test('error message lists valid next statuses', () => {
      try {
        lm.validateTransition('CREATED', 'COMPLETED');
        fail('should have thrown');
      } catch (e) {
        const err = e as Error;
        expect(err.message).toContain('Valid transitions from CREATED:');
        expect(err.message).toContain('IN_PROGRESS');
        expect(err.message).toContain('ERROR');
      }
    });

    test('does not throw on valid transition', () => {
      expect(() => lm.validateTransition('CREATED', 'IN_PROGRESS')).not.toThrow();
    });

    test('does not throw on idempotent same-state', () => {
      expect(() => lm.validateTransition('CREATED', 'CREATED')).not.toThrow();
    });
  });

  describe('I4 canPerform action alignment', () => {
    const lm = new LifecycleManager(PROJECT_TRANSITIONS);

    test('advance is allowed from all non-terminal progress states', () => {
      const advanceable = [
        'CREATED',
        'IN_PROGRESS',
        'ASSESSMENT_COMPLETE',
        'DESIGN_COMPLETE',
        'PLANNING_COMPLETE',
        'IMPLEMENTATION_READY',
      ];
      for (const s of advanceable) {
        expect(lm.canPerform('advance', s)).toBe(true);
      }
    });

    test('fail is allowed from all non-terminal states (except ERROR)', () => {
      const failable = [
        'CREATED',
        'IN_PROGRESS',
        'ASSESSMENT_COMPLETE',
        'DESIGN_COMPLETE',
        'PLANNING_COMPLETE',
        'IMPLEMENTATION_READY',
      ];
      for (const s of failable) {
        expect(lm.canPerform('fail', s)).toBe(true);
      }
    });

    test('recover and abandon are allowed from ERROR', () => {
      expect(lm.canPerform('recover', 'ERROR')).toBe(true);
      expect(lm.canPerform('abandon', 'ERROR')).toBe(true);
    });

    test('advance is NOT allowed from terminal states', () => {
      expect(lm.canPerform('advance', 'COMPLETED')).toBe(false);
      expect(lm.canPerform('advance', 'ERROR')).toBe(false);
    });
  });

  describe('getValidNextStatuses', () => {
    const lm = new LifecycleManager(PROJECT_TRANSITIONS);

    test('returns empty array for COMPLETED', () => {
      expect(lm.getValidNextStatuses('COMPLETED')).toEqual([]);
    });

    test('returns ERROR recovery options', () => {
      const next = lm.getValidNextStatuses('ERROR');
      expect(next).toContain('IN_PROGRESS');
      expect(next).toContain('COMPLETED');
    });

    test('returns empty array for unknown status', () => {
      expect(lm.getValidNextStatuses('NONSENSE')).toEqual([]);
    });
  });
});
