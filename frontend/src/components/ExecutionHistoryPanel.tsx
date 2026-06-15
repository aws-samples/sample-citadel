/**
 * ExecutionHistoryPanel Component
 *
 * Side panel listing past executions for a workflow. Each execution shows
 * status badge, startedAt, completedAt, duration, and workflowVersion.
 * Click to expand per-node results. Failed nodes show expandable error details.
 * Pagination via "Load More" button using nextToken.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 22.6
 */

import { useEffect, useState, useCallback } from 'react';
import { executionApiService } from '../services/executionApiService';
import { Button } from './ui/button';

interface NodeResult {
  nodeId: string;
  agentId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  output?: string | null;
  error?: string | null;
  retryCount: number;
}

interface Execution {
  executionId: string;
  workflowId: string;
  status: string;
  workflowVersion?: number;
  startedAt: string;
  completedAt?: string | null;
  nodeResults?: string;
}

export interface ExecutionHistoryPanelProps {
  workflowId: string;
  isOpen: boolean;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-chart-2',
  failed: 'bg-destructive',
  running: 'bg-chart-4',
  pending: 'bg-muted-foreground',
  cancelled: 'bg-primary',
};

function formatDuration(start: string, end?: string | null): string {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function parseNodeResults(raw?: string): Record<string, NodeResult> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function ExecutionHistoryPanel({ workflowId, isOpen, onClose }: ExecutionHistoryPanelProps) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedExec, setExpandedExec] = useState<string | null>(null);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);

  const fetchExecutions = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const result = await executionApiService.listExecutions(workflowId);
      const items: Execution[] = result.items ?? [];
      // Sort by startedAt descending
      items.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      if (append) {
        setExecutions((prev) => [...prev, ...items]);
      } else {
        setExecutions(items);
      }
      setNextToken(result.nextToken ?? null);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (isOpen) {
      fetchExecutions();
    }
  }, [isOpen, fetchExecutions]);

  const handleLoadMore = async () => {
    await fetchExecutions(true);
  };

  if (!isOpen) return null;

  return (
    <div data-testid="execution-history-panel" className="border-l bg-card w-80 p-4 overflow-y-auto">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-base font-bold">Execution History</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          ✕
        </Button>
      </div>

      {loading && executions.length === 0 && (
        <div data-testid="loading-skeleton" className="flex flex-col animate-pulse gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-muted rounded" />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {executions.map((exec) => {
          const isExpanded = expandedExec === exec.executionId;
          const nodeResults = parseNodeResults(exec.nodeResults);

          return (
            <div key={exec.executionId}>
              <div
                data-testid={`execution-entry-${exec.executionId}`}
                className="p-2 border rounded cursor-pointer hover:bg-muted"
                onClick={() => setExpandedExec(isExpanded ? null : exec.executionId)}
              >
                <div className="flex items-center gap-2">
                  <span
                    data-testid={`status-badge-${exec.executionId}`}
                    className={`inline-block size-3 rounded-full ${STATUS_COLORS[exec.status] ?? 'bg-muted-foreground'}`}
                  />
                  <span className="text-xs font-mono">{exec.executionId}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex gap-3">
                  <span>{new Date(exec.startedAt).toLocaleString()}</span>
                  <span>{formatDuration(exec.startedAt, exec.completedAt)}</span>
                  {exec.workflowVersion != null && <span>v{exec.workflowVersion}</span>}
                </div>
              </div>

              {isExpanded && (
                <div className="flex flex-col ml-4 mt-1 gap-1">
                  {Object.values(nodeResults).map((node) => (
                    <div key={node.nodeId}>
                      <div
                        data-testid={`node-result-${node.nodeId}`}
                        className="p-1.5 border rounded text-xs cursor-pointer hover:bg-muted"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedNode(expandedNode === node.nodeId ? null : node.nodeId);
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block size-2 rounded-full ${STATUS_COLORS[node.status] ?? 'bg-muted-foreground'}`}
                          />
                          <span className="font-mono">{node.nodeId}</span>
                          <span className="text-muted-foreground">
                            {formatDuration(node.startedAt ?? '', node.completedAt)}
                          </span>
                        </div>
                      </div>

                      {expandedNode === node.nodeId && node.error && (
                        <div
                          data-testid={`node-error-${node.nodeId}`}
                          className="ml-4 mt-1 p-2 bg-destructive/10 border border-destructive rounded text-xs text-destructive whitespace-pre-wrap"
                        >
                          {node.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {nextToken && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full text-primary border-primary hover:bg-primary/10"
          onClick={handleLoadMore}
        >
          Load More
        </Button>
      )}
    </div>
  );
}
