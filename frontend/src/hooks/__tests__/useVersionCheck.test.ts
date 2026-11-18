/**
 * useVersionCheck — version banner comparison logic.
 *
 * Validates:
 * - When the fetched build id differs from the embedded one, returns stale=true.
 * - When they match, returns stale=false.
 * - Fetch failures don't crash; returns stale=false.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useVersionCheck } from '../useVersionCheck';

// We need to control the global BUILD_ID and fetch
const CURRENT_BUILD_ID = 'abc123';

beforeEach(() => {
  (globalThis as Record<string, unknown>).__BUILD_ID__ = CURRENT_BUILD_ID;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as Record<string, unknown>).__BUILD_ID__;
  jest.restoreAllMocks();
});

describe('useVersionCheck', () => {
  it('returns stale=true when remote build id differs', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ buildId: 'def456' }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useVersionCheck());

    // Trigger the initial check
    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(result.current.stale).toBe(true);
    });
  });

  it('returns stale=false when build ids match', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ buildId: CURRENT_BUILD_ID }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useVersionCheck());

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(result.current.stale).toBe(false);
  });

  it('returns stale=false on fetch failure', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('network'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useVersionCheck());

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(result.current.stale).toBe(false);
  });

  it('re-checks after the polling interval', async () => {
    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ buildId: callCount === 1 ? CURRENT_BUILD_ID : 'new-id' }),
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useVersionCheck(1000)); // 1s interval for test

    // Initial check — same id
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    expect(result.current.stale).toBe(false);

    // Advance past interval — second check returns different id
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await waitFor(() => {
      expect(result.current.stale).toBe(true);
    });
  });

  it('checkNow triggers an immediate re-check', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ buildId: 'different' }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useVersionCheck());

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(result.current.stale).toBe(true);
    });

    // Reset to matching, then checkNow
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ buildId: CURRENT_BUILD_ID }),
    });

    await act(async () => {
      result.current.checkNow();
    });

    await waitFor(() => {
      expect(result.current.stale).toBe(false);
    });
  });
});
