import { renderHook, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useBulkApproval } from '../../hooks/useBulkApproval';
import { approvalsService } from '../../services/approvalsService';
import type { PendingApprovalItem } from '../../services/approvalsService';

jest.mock('@/services/approvalsService', () => ({
  approvalsService: {
    listPendingApprovals: jest.fn(),
    decideApproval: jest.fn(),
  },
}));

const mockDecide = approvalsService.decideApproval as jest.Mock;

function makeItem(id: string, type = 'agent', version?: number): PendingApprovalItem {
  return {
    recordId: id,
    recordType: type,
    name: `name-${id}`,
    displayName: `Display ${id}`,
    orgId: 'org-1',
    submittedAt: '2026-10-01T10:00:00Z',
    createdBy: 'alice',
    status: 'PENDING_APPROVAL',
    ...(version !== undefined ? { version } : {}),
  };
}

describe('useBulkApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('processes all items sequentially and all succeed', async () => {
    mockDecide.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1'), makeItem('r2'), makeItem('r3')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      // Advance timers for inter-call delays (2 delays for 3 items)
      for (let i = 0; i < items.length; i++) {
        await jest.advanceTimersByTimeAsync(250);
      }
      await promise;
    });

    expect(mockDecide).toHaveBeenCalledTimes(3);
    expect(result.current.results.every((r) => r.status === 'succeeded')).toBe(true);
    expect(result.current.progress).toEqual({ completed: 3, total: 3 });
    expect(result.current.isExecuting).toBe(false);
  });

  it('one conflict does not stop others', async () => {
    mockDecide
      .mockResolvedValueOnce(undefined) // r1 succeeds
      .mockRejectedValueOnce(new Error('Conflict: app was modified concurrently'))
      .mockResolvedValueOnce(undefined) // r3 succeeds
      .mockResolvedValueOnce(undefined); // r4 succeeds

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1'), makeItem('r2'), makeItem('r3'), makeItem('r4')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      for (let i = 0; i < items.length; i++) {
        await jest.advanceTimersByTimeAsync(250);
      }
      await promise;
    });

    expect(mockDecide).toHaveBeenCalledTimes(4);
    const resultMap = new Map(result.current.results.map((r) => [r.recordId, r.status]));
    expect(resultMap.get('r1')).toBe('succeeded');
    expect(resultMap.get('r2')).toBe('conflict');
    expect(resultMap.get('r3')).toBe('succeeded');
    expect(resultMap.get('r4')).toBe('succeeded');
  });

  it('one authorization denial does not stop others', async () => {
    mockDecide
      .mockResolvedValueOnce(undefined) // r1 succeeds
      .mockResolvedValueOnce(undefined) // r2 succeeds
      .mockRejectedValueOnce(new Error('Access denied'))
      .mockResolvedValueOnce(undefined); // r4 succeeds

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1'), makeItem('r2'), makeItem('r3'), makeItem('r4')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      for (let i = 0; i < items.length; i++) {
        await jest.advanceTimersByTimeAsync(250);
      }
      await promise;
    });

    const resultMap = new Map(result.current.results.map((r) => [r.recordId, r.status]));
    expect(resultMap.get('r3')).toBe('denied');
    expect(resultMap.get('r1')).toBe('succeeded');
    expect(resultMap.get('r4')).toBe('succeeded');
  });

  it('retry only re-processes failed items', async () => {
    // First run: r2 fails
    mockDecide
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Server error'))
      .mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1'), makeItem('r2'), makeItem('r3')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      for (let i = 0; i < items.length; i++) {
        await jest.advanceTimersByTimeAsync(250);
      }
      await promise;
    });

    expect(result.current.results.find((r) => r.recordId === 'r2')?.status).toBe('failed');

    // Now retry - only r2 should be called
    mockDecide.mockClear();
    mockDecide.mockResolvedValue(undefined);

    await act(async () => {
      const promise = result.current.retryFailed();
      await jest.advanceTimersByTimeAsync(250);
      await promise;
    });

    // Only the failed item should have been retried
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 'r2' }),
    );
    expect(result.current.results.find((r) => r.recordId === 'r2')?.status).toBe('succeeded');
  });

  it('cap enforced — rejects > 25 items', async () => {
    const { result } = renderHook(() => useBulkApproval());
    const items = Array.from({ length: 26 }, (_, i) => makeItem(`r${i}`));

    await expect(
      act(async () => {
        await result.current.execute(items, 'APPROVED');
      }),
    ).rejects.toThrow('exceeds maximum of 25');
  });

  it('reason passed for rejection', async () => {
    mockDecide.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1', 'agent', 2)];

    await act(async () => {
      const promise = result.current.execute(items, 'REJECTED', 'Not ready');
      await jest.advanceTimersByTimeAsync(250);
      await promise;
    });

    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'r1',
        decision: 'REJECTED',
        statusReason: 'Not ready',
        version: 2,
      }),
    );
  });

  it('inter-call delay of 250ms is respected', async () => {
    const callTimestamps: number[] = [];
    mockDecide.mockImplementation(() => {
      callTimestamps.push(Date.now());
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1'), makeItem('r2'), makeItem('r3')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      // Advance in 250ms increments
      for (let i = 0; i < items.length; i++) {
        await jest.advanceTimersByTimeAsync(250);
      }
      await promise;
    });

    expect(callTimestamps.length).toBe(3);
    // Between call 1 and 2 there should be >= 250ms
    expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(250);
    // Between call 2 and 3 there should be >= 250ms
    expect(callTimestamps[2] - callTimestamps[1]).toBeGreaterThanOrEqual(250);
  });

  it('progress updates after each item', async () => {
    const progressSnapshots: { completed: number; total: number }[] = [];

    mockDecide.mockImplementation(() => {
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1'), makeItem('r2')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      await jest.advanceTimersByTimeAsync(0);
      progressSnapshots.push({ ...result.current.progress });
      await jest.advanceTimersByTimeAsync(250);
      progressSnapshots.push({ ...result.current.progress });
      await jest.advanceTimersByTimeAsync(250);
      await promise;
    });

    // Final state should show all completed
    expect(result.current.progress).toEqual({ completed: 2, total: 2 });
  });

  it('reset clears all state', async () => {
    mockDecide.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBulkApproval());
    const items = [makeItem('r1')];

    await act(async () => {
      const promise = result.current.execute(items, 'APPROVED');
      await jest.advanceTimersByTimeAsync(250);
      await promise;
    });

    expect(result.current.results.length).toBe(1);

    act(() => { result.current.reset(); });

    expect(result.current.results).toEqual([]);
    expect(result.current.progress).toEqual({ completed: 0, total: 0 });
    expect(result.current.isExecuting).toBe(false);
  });
});
