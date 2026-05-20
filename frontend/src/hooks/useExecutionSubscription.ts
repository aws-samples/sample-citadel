/**
 * useExecutionSubscription Hook
 * Subscribes to onWorkflowProgress for real-time execution updates.
 * Accumulates node status updates and tracks overall execution status.
 */

import { useState, useEffect } from 'react';
import serverService from '../services/server';

const ON_WORKFLOW_PROGRESS = `
  subscription OnWorkflowProgress($executionId: ID!) {
    onWorkflowProgress(executionId: $executionId) {
      executionId
      workflowId
      eventType
      nodeId
      status
      output
      error
      timestamp
    }
  }
`;

export function useExecutionSubscription(executionId: string | null) {
  const [nodeResults, setNodeResults] = useState<Record<string, any>>({});
  const [executionStatus, setExecutionStatus] = useState<string>('pending');
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    if (!executionId) return;

    const unsubscribe = serverService.subscribe(
      ON_WORKFLOW_PROGRESS,
      { executionId },
      (data: any) => {
        const event = data.onWorkflowProgress;
        setEvents(prev => [...prev, event]);

        if (event.nodeId) {
          setNodeResults(prev => ({
            ...prev,
            [event.nodeId]: {
              ...prev[event.nodeId],
              status: event.status,
              output: event.output,
              error: event.error,
            },
          }));
        }

        if (event.eventType === 'workflow.completed') {
          setExecutionStatus('completed');
        } else if (event.eventType === 'workflow.failed') {
          setExecutionStatus('failed');
        } else if (event.eventType === 'workflow.started') {
          setExecutionStatus('running');
        }
      }
    );

    return unsubscribe;
  }, [executionId]);

  return { nodeResults, executionStatus, events };
}
