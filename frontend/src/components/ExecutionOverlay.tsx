/**
 * ExecutionOverlay Component
 *
 * Per-node status overlay with color-coded indicators for workflow execution.
 * Uses useExecutionSubscription hook for real-time updates.
 * Fades out 10 seconds after execution completes.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 21.5
 */

import React, { useState, useEffect } from 'react';

export interface NodeResultEntry {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  output: string | null;
  error: string | null;
}

export interface ExecutionOverlayProps {
  nodeResults: Record<string, NodeResultEntry>;
  executionStatus: string;
  workflowStatus: 'DRAFT' | 'PUBLISHED';
  onRun: () => void;
  onCancel: () => void;
  executionId: string | null;
}

function NodeStatusIndicator({ nodeId, result }: { nodeId: string; result: NodeResultEntry }) {
  const { status, error } = result;

  if (status === 'skipped') {
    return (
      <div
        data-testid={`node-status-${nodeId}`}
        className="border-dashed border-border border-2 rounded-full size-6 flex items-center justify-center text-xs"
        title={error ?? undefined}
      />
    );
  }

  const statusStyles: Record<string, string> = {
    pending: 'bg-muted-foreground',
    running: 'bg-primary',
    completed: 'bg-chart-2',
    failed: 'bg-destructive',
  };

  const baseClass = `${statusStyles[status] ?? 'bg-muted-foreground'} rounded-full size-6 flex items-center justify-center text-xs text-foreground`;

  return (
    <div
      data-testid={`node-status-${nodeId}`}
      className={baseClass}
      title={status === 'failed' && error ? error : undefined}
    >
      {status === 'running' && <span className="animate-spin">⟳</span>}
      {status === 'completed' && '✓'}
      {status === 'failed' && '✗'}
    </div>
  );
}

export function ExecutionOverlay({
  nodeResults,
  executionStatus,
  workflowStatus,
  onRun,
  onCancel,
  executionId,
}: ExecutionOverlayProps) {
  const [fadedOut, setFadedOut] = useState(false);

  const isTerminal = executionStatus === 'completed' || executionStatus === 'failed';
  const isRunning = executionStatus === 'running';

  useEffect(() => {
    if (!isTerminal) {
      setFadedOut(false);
      return;
    }

    const timer = setTimeout(() => {
      setFadedOut(true);
    }, 10000);

    return () => clearTimeout(timer);
  }, [isTerminal]);

  const runDisabled = workflowStatus === 'DRAFT' || isRunning;
  const hasNodes = Object.keys(nodeResults).length > 0;

  return (
    <div
      data-testid="execution-overlay"
      className={`transition-opacity duration-500 ${fadedOut ? 'opacity-0' : 'opacity-100'}`}
    >
      {/* Execution controls toolbar */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onRun}
          disabled={runDisabled}
          className="px-3 py-1 rounded bg-chart-2 text-foreground text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Run Workflow
        </button>

        {isRunning && (
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded bg-destructive text-foreground text-sm"
          >
            Cancel
          </button>
        )}

        {executionId && (
          <span className="text-sm text-muted-foreground">
            Status: {executionStatus}
          </span>
        )}
      </div>

      {/* Per-node status indicators */}
      {hasNodes && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(nodeResults).map(([nodeId, result]) => (
            <NodeStatusIndicator key={nodeId} nodeId={nodeId} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
