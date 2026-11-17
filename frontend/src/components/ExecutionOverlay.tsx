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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unreachable';
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
  /** Optional map of nodeId → human label, used for failure messages. */
  nodeLabels?: Record<string, string>;
}

function ExecutionSummary({ nodeResults, nodeLabels }: { nodeResults: Record<string, NodeResultEntry>; nodeLabels: Record<string, string> }) {
  const entries = Object.entries(nodeResults);
  const total = entries.length;
  if (total === 0) return null;

  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let running = 0;
  let firstFailedId: string | null = null;

  for (const [nodeId, entry] of entries) {
    const s = entry.status;
    if (s === 'completed') completed++;
    else if (s === 'skipped' || s === 'unreachable') skipped++;
    else if (s === 'failed') { failed++; if (!firstFailedId) firstFailedId = nodeId; }
    else if (s === 'running') running++;
  }

  let text: string;
  if (failed > 0 && firstFailedId) {
    const label = nodeLabels[firstFailedId] ?? firstFailedId;
    text = `Failed at ${label}`;
  } else if (running > 0) {
    text = `Running step ${completed + 1} of ${total}`;
  } else if (completed === total) {
    text = 'Completed';
  } else if (skipped > 0 && completed + skipped === total) {
    text = `Completed ${completed}/${total}, ${skipped} skipped`;
  } else {
    text = 'Pending';
  }

  return (
    <span data-testid="execution-summary" className="text-sm text-muted-foreground" role="status" aria-live="polite">
      {text}
    </span>
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
  nodeLabels = {},
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

      {/* Compact execution summary */}
      {hasNodes && (
        <ExecutionSummary nodeResults={nodeResults} nodeLabels={nodeLabels} />
      )}
    </div>
  );
}
