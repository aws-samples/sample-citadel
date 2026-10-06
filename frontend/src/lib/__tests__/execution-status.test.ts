import {
  normalizeExecutionStatus,
  isRunning,
  isAwaitingApproval,
  isTerminal,
} from '../execution-status';

describe('execution-status helpers', () => {
  describe('normalizeExecutionStatus', () => {
    it('lowercases an uppercase status', () => {
      expect(normalizeExecutionStatus('RUNNING')).toBe('running');
    });

    it('returns already-lowercase status unchanged', () => {
      expect(normalizeExecutionStatus('running')).toBe('running');
    });

    it('handles mixed case', () => {
      expect(normalizeExecutionStatus('Awaiting_Approval')).toBe('awaiting_approval');
    });
  });

  describe('isRunning', () => {
    it('returns true for lowercase running', () => {
      expect(isRunning('running')).toBe(true);
    });

    it('returns true for uppercase RUNNING', () => {
      expect(isRunning('RUNNING')).toBe(true);
    });

    it('returns false for completed', () => {
      expect(isRunning('completed')).toBe(false);
    });
  });

  describe('isAwaitingApproval', () => {
    it('returns true for lowercase awaiting_approval', () => {
      expect(isAwaitingApproval('awaiting_approval')).toBe(true);
    });

    it('returns true for uppercase AWAITING_APPROVAL', () => {
      expect(isAwaitingApproval('AWAITING_APPROVAL')).toBe(true);
    });

    it('returns false for running', () => {
      expect(isAwaitingApproval('running')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it.each(['completed', 'succeeded', 'failed', 'cancelled'])(
      'returns true for %s',
      (status) => {
        expect(isTerminal(status)).toBe(true);
      },
    );

    it.each(['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED'])(
      'returns true for uppercase %s',
      (status) => {
        expect(isTerminal(status)).toBe(true);
      },
    );

    it('returns false for running', () => {
      expect(isTerminal('running')).toBe(false);
    });

    it('returns false for pending', () => {
      expect(isTerminal('pending')).toBe(false);
    });

    it('returns false for awaiting_approval', () => {
      expect(isTerminal('awaiting_approval')).toBe(false);
    });
  });
});
