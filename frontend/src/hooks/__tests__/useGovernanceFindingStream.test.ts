/**
 * Tests for useGovernanceFindingStream — live tail buffer.
 *
 * Mirrors useExecutionSubscription.test.ts — mocks the
 * governanceService.subscribeGovernanceFindings entry point so we can
 * dictate when callbacks fire, then asserts on buffer ordering, capacity,
 * pause/resume gating, clear, cleanup, and error state.
 */

jest.mock('../../services/governanceService', () => ({
  __esModule: true,
  governanceService: {
    subscribeGovernanceFindings: jest.fn(),
  },
}));

import { renderHook, act } from '@testing-library/react';
import { useGovernanceFindingStream } from '../useGovernanceFindingStream';
import { governanceService } from '../../services/governanceService';

type FindingCb = (finding: any) => void;
type ErrorCb = (err: unknown) => void;

function makeFinding(overrides: Partial<{ findingId: string; timestamp: number }> = {}) {
  return {
    findingId: overrides.findingId ?? 'f-1',
    workflowId: 'wf-1',
    decision: 'permit',
    reason: 'unit_match:unit-a',
    requestingAgent: 'agent-a',
    targetAgent: 'agent-b',
    scopeEvaluated: 'unit-a',
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    timestamp: overrides.timestamp ?? 1715000000,
  };
}

describe('useGovernanceFindingStream', () => {
  let mockUnsubscribe: jest.Mock;
  let capturedCallback: FindingCb;
  let capturedErrorCallback: ErrorCb | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsubscribe = jest.fn();
    capturedErrorCallback = undefined;
    (governanceService.subscribeGovernanceFindings as jest.Mock).mockImplementation(
      (cb: FindingCb, _filter: any, errorCb?: ErrorCb) => {
        capturedCallback = cb;
        capturedErrorCallback = errorCb;
        return mockUnsubscribe;
      },
    );
  });

  describe('subscription lifecycle', () => {
    it('subscribes when enabled=true', () => {
      renderHook(() => useGovernanceFindingStream({ enabled: true }));

      expect(
        governanceService.subscribeGovernanceFindings,
      ).toHaveBeenCalledTimes(1);
    });

    it('does NOT subscribe when enabled=false', () => {
      renderHook(() => useGovernanceFindingStream({ enabled: false }));

      expect(
        governanceService.subscribeGovernanceFindings,
      ).not.toHaveBeenCalled();
    });

    it('unsubscribes on unmount', () => {
      const { unmount } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      unmount();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('re-subscribes when filter changes', () => {
      const { rerender } = renderHook(
        ({ filter }: { filter: { decision: string | null } }) =>
          useGovernanceFindingStream({ enabled: true, filter }),
        { initialProps: { filter: { decision: 'deny' } } },
      );

      expect(
        governanceService.subscribeGovernanceFindings,
      ).toHaveBeenCalledTimes(1);

      rerender({ filter: { decision: 'escalate' } });

      // Effect re-ran, so the unsubscribe + subscribe pair fired.
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
      expect(
        governanceService.subscribeGovernanceFindings,
      ).toHaveBeenCalledTimes(2);
    });

    it('starts the subscription when enabled flips from false to true', () => {
      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useGovernanceFindingStream({ enabled }),
        { initialProps: { enabled: false } },
      );

      expect(
        governanceService.subscribeGovernanceFindings,
      ).not.toHaveBeenCalled();

      rerender({ enabled: true });

      expect(
        governanceService.subscribeGovernanceFindings,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe('buffer behaviour', () => {
    it('pushes incoming findings to the front of the buffer (most-recent first)', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      act(() => {
        capturedCallback(makeFinding({ findingId: 'a' }));
        capturedCallback(makeFinding({ findingId: 'b' }));
        capturedCallback(makeFinding({ findingId: 'c' }));
      });

      expect(result.current.buffer.map((f) => f.findingId)).toEqual([
        'c',
        'b',
        'a',
      ]);
    });

    it('caps buffer at bufferSize, evicting oldest entries', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true, bufferSize: 3 }),
      );

      act(() => {
        capturedCallback(makeFinding({ findingId: 'a' }));
        capturedCallback(makeFinding({ findingId: 'b' }));
        capturedCallback(makeFinding({ findingId: 'c' }));
        capturedCallback(makeFinding({ findingId: 'd' }));
        capturedCallback(makeFinding({ findingId: 'e' }));
      });

      expect(result.current.buffer.map((f) => f.findingId)).toEqual([
        'e',
        'd',
        'c',
      ]);
    });

    it('uses default bufferSize of 1000 when not supplied', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      act(() => {
        for (let i = 0; i < 1100; i++) {
          capturedCallback(makeFinding({ findingId: `f-${i}` }));
        }
      });

      // Cap respects the default.
      expect(result.current.buffer.length).toBe(1000);
      // Most-recent-first ordering preserved at the head.
      expect(result.current.buffer[0].findingId).toBe('f-1099');
    });
  });

  describe('pause / resume', () => {
    it('pause stops adding new findings while keeping the subscription open', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      act(() => {
        capturedCallback(makeFinding({ findingId: 'a' }));
      });
      act(() => {
        result.current.pause();
      });
      act(() => {
        capturedCallback(makeFinding({ findingId: 'b' }));
        capturedCallback(makeFinding({ findingId: 'c' }));
      });

      expect(result.current.paused).toBe(true);
      expect(result.current.buffer.map((f) => f.findingId)).toEqual(['a']);
      // Subscription was NOT torn down.
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });

    it('resume restarts buffer additions', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      act(() => {
        result.current.pause();
      });
      act(() => {
        capturedCallback(makeFinding({ findingId: 'paused-1' }));
      });
      act(() => {
        result.current.resume();
      });
      act(() => {
        capturedCallback(makeFinding({ findingId: 'live-1' }));
      });

      expect(result.current.paused).toBe(false);
      expect(result.current.buffer.map((f) => f.findingId)).toEqual(['live-1']);
    });
  });

  describe('clear', () => {
    it('empties the buffer without affecting the subscription', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      act(() => {
        capturedCallback(makeFinding({ findingId: 'a' }));
        capturedCallback(makeFinding({ findingId: 'b' }));
      });

      expect(result.current.buffer.length).toBe(2);

      act(() => {
        result.current.clear();
      });

      expect(result.current.buffer).toEqual([]);
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('stores subscription errors in state without throwing', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      expect(result.current.error).toBeNull();

      act(() => {
        capturedErrorCallback?.(new Error('lost connection'));
      });

      expect(result.current.error).toBe('lost connection');
    });

    it('handles non-Error error values', () => {
      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      act(() => {
        capturedErrorCallback?.('string error');
      });

      expect(result.current.error).toBe('string error');
    });

    it('captures synchronous subscribe failures in state', () => {
      (governanceService.subscribeGovernanceFindings as jest.Mock).mockImplementation(
        () => {
          throw new Error('amplify not configured');
        },
      );

      const { result } = renderHook(() =>
        useGovernanceFindingStream({ enabled: true }),
      );

      expect(result.current.error).toBe('amplify not configured');
      // Hook still returns a stable shape.
      expect(result.current.buffer).toEqual([]);
    });
  });
});
