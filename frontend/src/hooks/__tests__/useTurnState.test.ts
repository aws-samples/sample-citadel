/**
 * Tests for useTurnState hook — the per-turn state machine with T1/T2 timers.
 *
 * Uses fake timers throughout. Each test is independent.
 */
import { renderHook, act } from '@testing-library/react';
import { useTurnState, T1_MS, T2_MS } from '../../hooks/useTurnState';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('useTurnState', () => {
  it('starts in idle phase', () => {
    const { result } = renderHook(() => useTurnState());
    expect(result.current[0].phase).toBe('idle');
  });

  it('transitions idle → sending → awaitingAck on markSending + markSent', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hello'); });
    expect(result.current[0].phase).toBe('sending');
    expect(result.current[0].clientMessageId).toBe('cid-1');

    act(() => { result.current[1].markSent(); });
    expect(result.current[0].phase).toBe('awaitingAck');
  });

  // ── T1 timer ──────────────────────────────────────────────────────
  it('T1 fires ackTimeout when no ACK arrives within 8 s', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hello'); });
    act(() => { result.current[1].markSent(); });
    expect(result.current[0].phase).toBe('awaitingAck');

    act(() => { jest.advanceTimersByTime(T1_MS); });
    expect(result.current[0].phase).toBe('ackTimeout');
    expect(result.current[0].statusText).toMatch(/waiting/i);
  });

  it('ACK within T1 cancels T1 and moves to awaitingReply', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });

    // ACK at 3 s (before T1 = 8 s)
    act(() => { jest.advanceTimersByTime(3000); });
    act(() => { result.current[1].onAck(); });
    expect(result.current[0].phase).toBe('awaitingReply');

    // Advance past T1 — should NOT fire ackTimeout.
    act(() => { jest.advanceTimersByTime(T1_MS); });
    expect(result.current[0].phase).toBe('awaitingReply');
  });

  // ── T2 timer ──────────────────────────────────────────────────────
  it('reply clears T2 and returns to idle', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });
    act(() => { result.current[1].onAck(); });
    expect(result.current[0].phase).toBe('awaitingReply');

    act(() => { jest.advanceTimersByTime(50_000); });
    act(() => { result.current[1].onReply(); });
    expect(result.current[0].phase).toBe('idle');
  });

  it('T2 fires replyTimeout after 90 s without reply', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });
    act(() => { result.current[1].onAck(); });

    act(() => { jest.advanceTimersByTime(T2_MS); });
    expect(result.current[0].phase).toBe('replyTimeout');
    expect(result.current[0].statusText).toMatch(/no response/i);
  });

  it('PROGRESS_UPDATE resets T2 soft timer', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });
    act(() => { result.current[1].onAck(); });

    // Advance 80 s, then progress update resets T2.
    act(() => { jest.advanceTimersByTime(80_000); });
    act(() => { result.current[1].onProgress(); });
    expect(result.current[0].phase).toBe('awaitingReply');

    // Another 80 s → still under the reset 90 s window.
    act(() => { jest.advanceTimersByTime(80_000); });
    expect(result.current[0].phase).toBe('awaitingReply');

    // Reply arrives before the second T2 fires.
    act(() => { result.current[1].onReply(); });
    expect(result.current[0].phase).toBe('idle');
  });

  it('T2 hard cap at 5 min overrides soft resets', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });
    act(() => { result.current[1].onAck(); });

    // Send progress updates every 80 s to keep resetting the soft T2.
    for (let i = 0; i < 3; i++) {
      act(() => { jest.advanceTimersByTime(80_000); });
      act(() => { result.current[1].onProgress(); });
      expect(result.current[0].phase).toBe('awaitingReply');
    }

    // Advance to 5-min hard cap (300_000 ms total from T2 arm).
    // We've advanced 240_000 so far; need 60_000 more.
    act(() => { jest.advanceTimersByTime(60_000); });
    expect(result.current[0].phase).toBe('replyTimeout');
  });

  // ── Retry ─────────────────────────────────────────────────────────
  it('preserves clientMessageId and pendingText for retry', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-42', 'my question'); });
    act(() => { result.current[1].markSent(); });

    // T1 expires.
    act(() => { jest.advanceTimersByTime(T1_MS); });
    expect(result.current[0].phase).toBe('ackTimeout');
    expect(result.current[0].clientMessageId).toBe('cid-42');
    expect(result.current[0].pendingText).toBe('my question');
  });

  // ── Failure ───────────────────────────────────────────────────────
  it('markFailed surfaces error message', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markFailed('Network error'); });
    expect(result.current[0].phase).toBe('failed');
    expect(result.current[0].statusText).toBe('Network error');
  });

  // ── PROGRESS_UPDATE during awaitingAck promotes to awaitingReply ──
  it('PROGRESS_UPDATE during awaitingAck promotes to awaitingReply', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });
    expect(result.current[0].phase).toBe('awaitingAck');

    act(() => { result.current[1].onProgress(); });
    expect(result.current[0].phase).toBe('awaitingReply');
  });

  // ── reset ─────────────────────────────────────────────────────────
  it('reset clears timers and returns to idle', () => {
    const { result } = renderHook(() => useTurnState());
    act(() => { result.current[1].markSending('cid-1', 'hi'); });
    act(() => { result.current[1].markSent(); });
    act(() => { result.current[1].reset(); });
    expect(result.current[0].phase).toBe('idle');

    // Advancing timers should NOT trigger any state changes.
    act(() => { jest.advanceTimersByTime(T1_MS + T2_MS); });
    expect(result.current[0].phase).toBe('idle');
  });
});
