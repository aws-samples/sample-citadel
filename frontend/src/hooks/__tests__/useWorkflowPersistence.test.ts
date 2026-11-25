/**
 * useWorkflowPersistence Hook Tests
 * TDD Red Phase — tests written before implementation
 */

// Mock workflowApiService before imports
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    getWorkflow: jest.fn(),
    updateWorkflow: jest.fn(),
  },
}));

import { renderHook, act } from '@testing-library/react';
import { useWorkflowPersistence } from '../useWorkflowPersistence';
import { workflowApiService } from '../../services/workflowApiService';

describe('useWorkflowPersistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('load', () => {
    it('calls getWorkflow on mount when workflowId is provided', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);

      const { result } = renderHook(() => useWorkflowPersistence('wf-1'));

      // Wait for the useEffect load to complete
      await act(async () => {
        await Promise.resolve();
      });

      expect(workflowApiService.getWorkflow).toHaveBeenCalledWith('wf-1');
      expect(result.current.workflow).toEqual(mockWorkflow);
    });

    it('does not call getWorkflow when workflowId is null', async () => {
      renderHook(() => useWorkflowPersistence(null));

      await act(async () => {
        await Promise.resolve();
      });

      expect(workflowApiService.getWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('calls updateWorkflow mutation debounced by 3 seconds', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      const mockUpdated = { workflowId: 'wf-1', name: 'Updated', version: 2 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);
      (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValue(mockUpdated);

      const { result } = renderHook(() => useWorkflowPersistence('wf-1'));

      await act(async () => {
        await Promise.resolve();
      });

      // Trigger save
      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'Updated', version: 1 });
      });

      // Should NOT have called updateWorkflow yet (debounce)
      expect(workflowApiService.updateWorkflow).not.toHaveBeenCalled();

      // Advance timers by 3 seconds
      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(workflowApiService.updateWorkflow).toHaveBeenCalledWith({
        workflowId: 'wf-1',
        name: 'Updated',
        version: 1,
      });
    });
  });

  describe('conflict detection', () => {
    it('sets conflict flag and reloads on version mismatch error', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      const reloadedWorkflow = { workflowId: 'wf-1', name: 'Server Version', version: 3 };
      (workflowApiService.getWorkflow as jest.Mock)
        .mockResolvedValueOnce(mockWorkflow)
        .mockResolvedValueOnce(reloadedWorkflow);
      (workflowApiService.updateWorkflow as jest.Mock).mockRejectedValue(
        new Error('Conflict: workflow was modified concurrently. Please retry.')
      );

      const { result } = renderHook(() => useWorkflowPersistence('wf-1'));

      await act(async () => {
        await Promise.resolve();
      });

      // Trigger save that will conflict
      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'My Edit', version: 1 });
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.conflict).toBe(true);
      // getWorkflow called twice: once on mount, once on conflict reload
      expect(workflowApiService.getWorkflow).toHaveBeenCalledTimes(2);
    });
  });

  describe('offline fallback', () => {
    it('writes to localStorage on network error', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);
      (workflowApiService.updateWorkflow as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const { result } = renderHook(() => useWorkflowPersistence('wf-1'));

      await act(async () => {
        await Promise.resolve();
      });

      const saveData = { workflowId: 'wf-1', name: 'Offline Edit', version: 1 };
      act(() => {
        result.current.save(saveData);
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      const stored = localStorage.getItem('workflow-wf-1');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual(saveData);
    });
  });

  describe('retry on reconnect', () => {
    it('retries pending localStorage save when online event fires', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      const mockUpdated = { workflowId: 'wf-1', name: 'Retried', version: 2 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);
      (workflowApiService.updateWorkflow as jest.Mock)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(mockUpdated);

      const { result } = renderHook(() => useWorkflowPersistence('wf-1'));

      await act(async () => {
        await Promise.resolve();
      });

      // Save that fails with network error
      const saveData = { workflowId: 'wf-1', name: 'Retried', version: 1 };
      act(() => {
        result.current.save(saveData);
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Verify it was stored in localStorage
      expect(localStorage.getItem('workflow-wf-1')).not.toBeNull();

      // Simulate coming back online
      await act(async () => {
        window.dispatchEvent(new Event('online'));
        await Promise.resolve();
        await Promise.resolve();
      });

      // Should have retried the save
      expect(workflowApiService.updateWorkflow).toHaveBeenCalledTimes(2);
      // localStorage should be cleared after successful retry
      expect(localStorage.getItem('workflow-wf-1')).toBeNull();
    });
  });

  describe('unmount safety', () => {
    it('does not call updateWorkflow after the hook unmounts before the debounce fires', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);

      const { result, unmount } = renderHook(() => useWorkflowPersistence('wf-1'));

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'Updated', version: 1 });
      });

      unmount();

      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(workflowApiService.updateWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('version freshness', () => {
    it('sends the latest version available at fire time, not the version captured when the save was scheduled', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);
      (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValue({
        workflowId: 'wf-1',
        name: 'Updated',
        version: 2,
      });

      const { result, rerender } = renderHook(
        ({ getVersion }: { getVersion: () => number }) => useWorkflowPersistence('wf-1', getVersion),
        { initialProps: { getVersion: () => 1 } }
      );

      await act(async () => {
        await Promise.resolve();
      });

      // Schedule the save while the externally-tracked version is still 1...
      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'Updated', version: 1 });
      });

      // ...but by the time the timer fires, the version ref the caller holds
      // has moved to 5 (e.g. a hydration or a prior save response landed).
      rerender({ getVersion: () => 5 });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      expect(workflowApiService.updateWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ version: 5 })
      );
    });
  });

  describe('serialised saves', () => {
    it('two rapid changes after the first save resolves produce sequential saves with versions 1 then 2', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);
      (workflowApiService.updateWorkflow as jest.Mock)
        .mockResolvedValueOnce({ workflowId: 'wf-1', name: 'First', version: 2 })
        .mockResolvedValueOnce({ workflowId: 'wf-1', name: 'Second', version: 3 });

      const { result } = renderHook(() => useWorkflowPersistence('wf-1'));

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'First', version: 1 });
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(workflowApiService.updateWorkflow).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ version: 1 })
      );

      // Second change is scheduled only after the first response applied its version.
      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'Second', version: 2 });
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(workflowApiService.updateWorkflow).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ version: 2 })
      );
      expect(workflowApiService.updateWorkflow).toHaveBeenCalledTimes(2);
    });

    it('queues a change that arrives while a save is in flight instead of firing a second concurrent update', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test', version: 1 };
      (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);

      // Mirrors how the real caller (AgentBlueprints) tracks the server
      // version in a ref and exposes it via getVersion: the hook must read
      // this at fire time, not the value closed over when save() was called.
      let currentVersion = 1;
      const getVersion = () => currentVersion;

      let resolveFirst: (value: unknown) => void = () => {};
      (workflowApiService.updateWorkflow as jest.Mock).mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; })
      );
      (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValueOnce({
        workflowId: 'wf-1',
        name: 'Queued',
        version: 3,
      });

      const { result } = renderHook(() => useWorkflowPersistence('wf-1', getVersion));

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'First', version: 1 });
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      // First updateWorkflow call is in flight (unresolved).
      expect(workflowApiService.updateWorkflow).toHaveBeenCalledTimes(1);

      // A second change arrives while the first save is still pending.
      act(() => {
        result.current.save({ workflowId: 'wf-1', name: 'Queued', version: 1 });
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      // Must not have fired a second concurrent update while the first is in flight.
      expect(workflowApiService.updateWorkflow).toHaveBeenCalledTimes(1);

      // Resolve the in-flight save; the queued change should now fire using
      // the version the first response applied (2), not the stale version 1
      // it was scheduled with.
      currentVersion = 2;
      await act(async () => {
        resolveFirst({ workflowId: 'wf-1', name: 'First', version: 2 });
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(workflowApiService.updateWorkflow).toHaveBeenCalledTimes(2);
      expect(workflowApiService.updateWorkflow).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ version: 2 })
      );
    });
  });
});
