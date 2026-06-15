/**
 * useExecutionSubscription Hook Tests
 * TDD Red Phase — tests written before implementation
 */

// Mock server service before imports
jest.mock('../../services/server', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn(),
  },
}));

import { renderHook, act } from '@testing-library/react';
import { useExecutionSubscription } from '../useExecutionSubscription';
import serverService from '../../services/server';

describe('useExecutionSubscription', () => {
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsubscribe = jest.fn();
    (serverService.subscribe as jest.Mock).mockReturnValue(mockUnsubscribe);
  });

  describe('subscription setup', () => {
    it('subscribes to onWorkflowProgress with executionId', () => {
      renderHook(() => useExecutionSubscription('exec-1'));

      expect(serverService.subscribe).toHaveBeenCalledWith(
        expect.stringContaining('onWorkflowProgress'),
        { executionId: 'exec-1' },
        expect.any(Function)
      );
    });

    it('does not subscribe when executionId is null', () => {
      renderHook(() => useExecutionSubscription(null));

      expect(serverService.subscribe).not.toHaveBeenCalled();
    });

    it('unsubscribes on unmount', () => {
      const { unmount } = renderHook(() => useExecutionSubscription('exec-1'));

      unmount();

      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it('resubscribes when executionId changes', () => {
      const { rerender } = renderHook(
        ({ id }) => useExecutionSubscription(id),
        { initialProps: { id: 'exec-1' as string | null } }
      );

      expect(serverService.subscribe).toHaveBeenCalledTimes(1);

      rerender({ id: 'exec-2' });

      // Should unsubscribe from old and subscribe to new
      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(serverService.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  describe('event accumulation into nodeResults map', () => {
    it('accumulates node status updates into nodeResults', () => {
      let capturedCallback: (data: any) => void = () => {};
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, cb: (data: any) => void) => {
          capturedCallback = cb;
          return mockUnsubscribe;
        }
      );

      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      // Simulate node started event
      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.node.started',
            nodeId: 'node-1',
            status: 'running',
            output: null,
            error: null,
            timestamp: '2024-01-01T00:00:00Z',
          },
        });
      });

      expect(result.current.nodeResults['node-1']).toEqual(
        expect.objectContaining({ status: 'running' })
      );

      // Simulate node completed event
      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.node.completed',
            nodeId: 'node-1',
            status: 'completed',
            output: '{"result": "success"}',
            error: null,
            timestamp: '2024-01-01T00:01:00Z',
          },
        });
      });

      expect(result.current.nodeResults['node-1']).toEqual(
        expect.objectContaining({
          status: 'completed',
          output: '{"result": "success"}',
        })
      );
    });

    it('tracks multiple nodes independently', () => {
      let capturedCallback: (data: any) => void = () => {};
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, cb: (data: any) => void) => {
          capturedCallback = cb;
          return mockUnsubscribe;
        }
      );

      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.node.completed',
            nodeId: 'node-1',
            status: 'completed',
            output: '{"a":1}',
            error: null,
            timestamp: '2024-01-01T00:00:00Z',
          },
        });
      });

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.node.started',
            nodeId: 'node-2',
            status: 'running',
            output: null,
            error: null,
            timestamp: '2024-01-01T00:01:00Z',
          },
        });
      });

      expect(result.current.nodeResults['node-1'].status).toBe('completed');
      expect(result.current.nodeResults['node-2'].status).toBe('running');
    });
  });

  describe('execution status tracking', () => {
    it('starts with pending status', () => {
      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      expect(result.current.executionStatus).toBe('pending');
    });

    it('transitions to running on workflow.started event', () => {
      let capturedCallback: (data: any) => void = () => {};
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, cb: (data: any) => void) => {
          capturedCallback = cb;
          return mockUnsubscribe;
        }
      );

      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.started',
            nodeId: null,
            status: 'running',
            output: null,
            error: null,
            timestamp: '2024-01-01T00:00:00Z',
          },
        });
      });

      expect(result.current.executionStatus).toBe('running');
    });

    it('transitions to completed on workflow.completed event', () => {
      let capturedCallback: (data: any) => void = () => {};
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, cb: (data: any) => void) => {
          capturedCallback = cb;
          return mockUnsubscribe;
        }
      );

      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.completed',
            nodeId: null,
            status: 'completed',
            output: '{"final":"output"}',
            error: null,
            timestamp: '2024-01-01T00:05:00Z',
          },
        });
      });

      expect(result.current.executionStatus).toBe('completed');
    });

    it('transitions to failed on workflow.failed event', () => {
      let capturedCallback: (data: any) => void = () => {};
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, cb: (data: any) => void) => {
          capturedCallback = cb;
          return mockUnsubscribe;
        }
      );

      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.failed',
            nodeId: 'node-3',
            status: 'failed',
            output: null,
            error: 'Agent timeout',
            timestamp: '2024-01-01T00:03:00Z',
          },
        });
      });

      expect(result.current.executionStatus).toBe('failed');
    });

    it('accumulates all events in events array', () => {
      let capturedCallback: (data: any) => void = () => {};
      (serverService.subscribe as jest.Mock).mockImplementation(
        (_query: string, _vars: any, cb: (data: any) => void) => {
          capturedCallback = cb;
          return mockUnsubscribe;
        }
      );

      const { result } = renderHook(() => useExecutionSubscription('exec-1'));

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.started',
            nodeId: null,
            status: 'running',
            output: null,
            error: null,
            timestamp: '2024-01-01T00:00:00Z',
          },
        });
      });

      act(() => {
        capturedCallback({
          onWorkflowProgress: {
            executionId: 'exec-1',
            workflowId: 'wf-1',
            eventType: 'workflow.node.started',
            nodeId: 'node-1',
            status: 'running',
            output: null,
            error: null,
            timestamp: '2024-01-01T00:00:01Z',
          },
        });
      });

      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0].eventType).toBe('workflow.started');
      expect(result.current.events[1].eventType).toBe('workflow.node.started');
    });
  });
});
