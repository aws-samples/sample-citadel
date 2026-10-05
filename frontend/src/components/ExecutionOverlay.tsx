/**
 * ExecutionOverlay Component
 *
 * Per-node status overlay with color-coded indicators for workflow execution.
 * Uses useExecutionSubscription hook for real-time updates.
 * Fades out 10 seconds after execution completes.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 21.5, CIT-030
 */

import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';

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
  canApproveExecutions?: boolean;
  onPause?: (executionId: string) => void;
  onApprove?: (executionId: string) => void;
  onDeny?: (executionId: string) => void;
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
  canApproveExecutions = false,
  onPause,
  onApprove,
  onDeny,
}: ExecutionOverlayProps) {
  const [fadedOut, setFadedOut] = useState(false);

  const isTerminal = executionStatus === 'completed' || executionStatus === 'failed';
  const isRunning = executionStatus === 'running';
  const isAwaitingApproval = executionStatus === 'awaiting_approval';

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

  const runButton = (
    <Button
      type="button"
      variant="default"
      size="sm"
      onClick={onRun}
      disabled={runDisabled}
      className="bg-chart-2 text-foreground hover:bg-chart-2/90 disabled:cursor-not-allowed"
    >
      Run Workflow
    </Button>
  );

  const runTooltipContent = workflowStatus === 'DRAFT'
    ? 'Publish the workflow to run it'
    : null;

  return (
    <div
      data-testid="execution-overlay"
      className={`transition-opacity duration-500 ${fadedOut ? 'opacity-0' : 'opacity-100'}`}
    >
      {/* Execution controls toolbar */}
      <div className="flex items-center gap-2 mb-2">
        {runTooltipContent ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{runButton}</span>
            </TooltipTrigger>
            <TooltipContent>{runTooltipContent}</TooltipContent>
          </Tooltip>
        ) : (
          runButton
        )}

        {isRunning && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onCancel}
            className="text-foreground"
          >
            Cancel
          </Button>
        )}

        {isRunning && canApproveExecutions && executionId && onPause && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPause(executionId)}
            data-testid="pause-execution"
          >
            Pause
          </Button>
        )}

        {isAwaitingApproval && canApproveExecutions && executionId && (
          <>
            {onApprove && (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => onApprove(executionId)}
                data-testid="approve-execution"
              >
                Approve
              </Button>
            )}
            {onDeny && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => onDeny(executionId)}
                data-testid="deny-execution"
              >
                Deny
              </Button>
            )}
          </>
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
