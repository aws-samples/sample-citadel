/**
 * ExecutionDetailSheet — progressive-disclosure view of a workflow execution.
 * Surfaces the run's impact: the Result first (output/error), then per-node
 * Steps (expandable), then the raw Input (collapsed by default).
 * All JSON parsing is defensive — invalid payloads render as raw strings.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from './ui/sheet';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from './ui/utils';
import { toast } from 'sonner';

// ---- Types ----

export interface ExecutionNodeResult {
  nodeId: string;
  agentId?: string | null;
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  output?: string | null;
  error?: string | null;
  retryCount?: number | null;
}

export interface ExecutionDetail {
  executionId: string;
  workflowId: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  workflowVersion?: number | null;
  triggeredBy?: string | null;
  input?: string | null;
  output?: string | null;
  error?: string | null;
  /** JSON string map keyed by nodeId (AWSJSON) or an already-parsed object. */
  nodeResults?: string | Record<string, unknown> | null;
}

interface ExecutionDetailSheetProps {
  execution: ExecutionDetail | null;
  open: boolean;
  onClose: () => void;
}

// ---- Style maps (reuse the execution status color idiom) ----

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  completed: { bg: 'bg-chart-2/20', text: 'text-chart-2', dot: 'bg-chart-2' },
  succeeded: { bg: 'bg-chart-2/20', text: 'text-chart-2', dot: 'bg-chart-2' },
  failed: { bg: 'bg-destructive/20', text: 'text-destructive', dot: 'bg-destructive' },
  running: { bg: 'bg-primary/20', text: 'text-primary', dot: 'bg-primary' },
  pending: { bg: 'bg-muted/20', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

function statusStyle(status?: string | null) {
  return STATUS_STYLES[(status || '').toLowerCase()] || STATUS_STYLES.pending;
}

// ---- Defensive parsing helpers ----

/** Pretty-print a JSON string; return the raw string when unparseable; null when empty. */
function prettyJson(raw?: string | null): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Parse nodeResults (JSON string or object map) into a startedAt-ascending array. Never throws. */
function parseNodeResults(raw?: string | Record<string, unknown> | null): ExecutionNodeResult[] {
  if (!raw) return [];
  let map: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      map = JSON.parse(raw);
    } catch {
      return [];
    }
  } else {
    map = raw;
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const nodes: ExecutionNodeResult[] = Object.entries(map).map(([key, value]) => {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return {
      nodeId: typeof v.nodeId === 'string' && v.nodeId ? v.nodeId : key,
      agentId: typeof v.agentId === 'string' ? v.agentId : null,
      status: typeof v.status === 'string' ? v.status : null,
      startedAt: typeof v.startedAt === 'string' ? v.startedAt : null,
      completedAt: typeof v.completedAt === 'string' ? v.completedAt : null,
      output: typeof v.output === 'string' ? v.output : null,
      error: typeof v.error === 'string' ? v.error : null,
      retryCount: typeof v.retryCount === 'number' ? v.retryCount : 0,
    };
  });
  nodes.sort((a, b) => {
    if (!a.startedAt && !b.startedAt) return 0;
    if (!a.startedAt) return 1;
    if (!b.startedAt) return -1;
    return a.startedAt.localeCompare(b.startedAt);
  });
  return nodes;
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function computeDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '—';
  try {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    if (Number.isNaN(start) || Number.isNaN(end)) return '—';
    const diffMs = end - start;
    if (diffMs < 1000) return `${diffMs}ms`;
    if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s`;
    return `${Math.round(diffMs / 60000)}m`;
  } catch {
    return '—';
  }
}

const PRE_CLASSES =
  'rounded-md border border-border/50 bg-background p-3 text-xs text-foreground font-mono max-h-80 overflow-auto whitespace-pre-wrap';

// ---- Component ----

export function ExecutionDetailSheet({ execution, open, onClose }: ExecutionDetailSheetProps) {
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [inputExpanded, setInputExpanded] = useState(false);

  // Reset disclosure state whenever a different execution is shown
  useEffect(() => {
    setExpandedNodes({});
    setInputExpanded(false);
  }, [execution?.executionId]);

  const nodeSteps = useMemo(
    () => parseNodeResults(execution?.nodeResults),
    [execution?.nodeResults],
  );
  const prettyOutput = useMemo(() => prettyJson(execution?.output), [execution?.output]);
  const prettyInput = useMemo(() => prettyJson(execution?.input), [execution?.input]);

  if (!execution) return null;

  const headerStyle = statusStyle(execution.status);

  const handleCopyResult = async () => {
    try {
      await navigator.clipboard.writeText(prettyOutput ?? '');
      toast.success('Copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto gap-0">
        <SheetHeader className="border-b border-border/50">
          <SheetTitle
            className="font-mono text-sm truncate pr-8"
            title={execution.executionId}
          >
            {execution.executionId}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Details for execution {execution.executionId}
          </SheetDescription>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={cn(headerStyle.bg, headerStyle.text, 'text-xs border-0')}>
              {execution.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Duration {computeDuration(execution.startedAt, execution.completedAt)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>Started {formatDate(execution.startedAt)}</span>
            {execution.completedAt && <span>Completed {formatDate(execution.completedAt)}</span>}
            {execution.triggeredBy && <span>Triggered by {execution.triggeredBy}</span>}
            {execution.workflowVersion != null && (
              <span>Workflow v{execution.workflowVersion}</span>
            )}
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-4">
          {/* Result — the impact, most prominent and first */}
          <section aria-label="Result">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-foreground">Result</h3>
              {prettyOutput !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Copy result"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                  onClick={handleCopyResult}
                >
                  <Copy className="size-3 mr-1" /> Copy
                </Button>
              )}
            </div>
            {execution.error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive whitespace-pre-wrap mb-2">
                {execution.error}
              </div>
            )}
            {prettyOutput !== null ? (
              <pre className={PRE_CLASSES}>{prettyOutput}</pre>
            ) : (
              <p className="text-xs text-muted-foreground">No output recorded.</p>
            )}
          </section>

          {/* Steps — per-node results, expandable */}
          <section aria-label="Steps">
            <h3 className="text-sm font-medium text-foreground mb-2">Steps</h3>
            {nodeSteps.length === 0 ? (
              <p className="text-xs text-muted-foreground">No step details recorded.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {nodeSteps.map((node) => {
                  const isExpanded = !!expandedNodes[node.nodeId];
                  const nodeStyle = statusStyle(node.status);
                  const nodeOutput = prettyJson(node.output);
                  const retryCount = node.retryCount ?? 0;
                  return (
                    <div key={node.nodeId} className="rounded-md border border-border/50">
                      <Button
                        type="button"
                        variant="ghost"
                        aria-expanded={isExpanded}
                        className="h-auto w-full min-w-0 items-center justify-start gap-2 p-2 rounded-md text-left text-xs font-normal whitespace-normal cursor-pointer hover:bg-accent/50 transition-colors"
                        onClick={() =>
                          setExpandedNodes((prev) => ({
                            ...prev,
                            [node.nodeId]: !prev[node.nodeId],
                          }))
                        }
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-3 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <ChevronRight className="size-3 text-muted-foreground flex-shrink-0" />
                        )}
                        <span
                          className={cn('size-2 rounded-full flex-shrink-0', nodeStyle.dot)}
                          aria-hidden="true"
                        />
                        <span className="font-mono text-foreground truncate">{node.nodeId}</span>
                        {node.agentId && (
                          <span className="text-muted-foreground truncate">{node.agentId}</span>
                        )}
                        <span className="ml-auto text-muted-foreground flex-shrink-0">
                          {computeDuration(node.startedAt, node.completedAt)}
                        </span>
                        {retryCount > 0 && (
                          <Badge className="bg-chart-4/20 text-chart-4 text-xs border-0 flex-shrink-0">
                            {retryCount} {retryCount === 1 ? 'retry' : 'retries'}
                          </Badge>
                        )}
                      </Button>
                      {isExpanded && (
                        <div className="flex flex-col gap-2 border-t border-border/50 p-2">
                          {node.error && (
                            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive whitespace-pre-wrap">
                              {node.error}
                            </div>
                          )}
                          {nodeOutput !== null ? (
                            <pre className={PRE_CLASSES}>{nodeOutput}</pre>
                          ) : !node.error ? (
                            <p className="text-xs text-muted-foreground">No output recorded.</p>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Input — collapsed by default; omitted entirely when absent */}
          {prettyInput !== null && (
            <section aria-label="Input">
              <Button
                type="button"
                variant="ghost"
                aria-expanded={inputExpanded}
                className="h-auto flex items-center justify-start gap-1 p-0 text-sm font-medium text-foreground whitespace-normal cursor-pointer mb-2 hover:bg-transparent hover:text-foreground"
                onClick={() => setInputExpanded((v) => !v)}
              >
                {inputExpanded ? (
                  <ChevronDown className="size-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 text-muted-foreground" />
                )}
                Input
              </Button>
              {inputExpanded && <pre className={PRE_CLASSES}>{prettyInput}</pre>}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
