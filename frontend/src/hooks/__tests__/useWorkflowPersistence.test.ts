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
});
