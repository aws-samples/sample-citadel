/**
 * ExecutionDetailSheet — progressive-disclosure view of a workflow execution.
 * Surfaces the run's impact: the Result first (output/error), then per-node
 * Steps (expandable), then the raw Input (collapsed by default).
 * All JSON parsing is defensive — invalid payloads render as raw strings.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, Waypoints } from 'lucide-react';
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

/** Usage rollup: aggregated token usage (per-node or execution-level). */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

export interface ExecutionNodeResult {
  nodeId: string;
  agentId?: string | null;
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  output?: string | null;
  error?: string | null;
  retryCount?: number | null;
  /** Additive: this node's precomputed usage totals (usage rollup). */
  usageTotals?: UsageTotals | null;
  /** CIT-123 slice 5: mirrored onto a `#comp` pseudo-node's row when its
   * compensation fails (design D7) — same classification the taxonomy
   * module already computed, never re-derived here. */
  failureClass?: string | null;
  recommendedAction?: string | null;
}

/** CIT-123 slice 5 (interim CIT-126 contract, executor.py `_summary_mark_stopped`):
 * one entry per FAILED compensation, in the order the unwind stopped. */
export interface CompensationSummaryEntry {
  nodeId: string;
  error: string;
  failureClass: string;
  recommendedAction: string;
}

export interface CompensationSummary {
  completed?: string[];
  failed?: string[];
  stoppedAt?: string | null;
  reason?: string | null;
  entries?: CompensationSummaryEntry[];
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
  /** Additive: execution-level usage totals (AWSJSON string or parsed object). */
  usageTotals?: string | UsageTotals | null;
  /** CIT-123 slice 5 (design D7): additive sub-status. The execution's
   * top-level `status` STAYS 'failed' when compensation runs — this is
   * never a replacement for it, only observability on top. One of
   * 'running' | 'completed' | 'partial', or absent for a non-compensating
   * execution (legacy runs, or a workflow with no compensation policy). */
  compensationStatus?: string | null;
  /** Reverse-topological unwind order (design D5) — the order the
   * Compensations section renders in, independent of nodeResults map
   * insertion order. */
  compensationPlan?: string[] | null;
  compensationSummary?: string | CompensationSummary | null;
}

interface ExecutionDetailSheetProps {
  execution: ExecutionDetail | null;
  open: boolean;
  onClose: () => void;
  /** Deep-link callback to the waterfall trace viewer (design task 60ba09e4).
   * The sheet has no router access itself, so the owner (AppDetailView) wires
   * this to `navigate('/observability/trace/execution/<executionId>')`. */
  onViewTrace?: (executionId: string) => void;
  /**
   * Deep-link callback for the CIT-026 execution replay package download.
   * Ownership is enforced server-side (resolveExecutionOwnership) — every
   * org member sees this button (design §2a: ownership-gated for ALL org
   * members, not admin-only); the API itself returns 403/404 for a
   * non-owning org, and the caller (AppDetailView) surfaces that via
   * replayService's typed unauthorized/gateRefused results. When absent,
   * the button is omitted entirely (graceful, no crash).
   */
  onDownloadReplay?: (executionId: string) => void;
}

// ---- Style maps (reuse the execution status color idiom) ----

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  completed: { bg: 'bg-chart-2/20', text: 'text-chart-2', dot: 'bg-chart-2' },
  succeeded: { bg: 'bg-chart-2/20', text: 'text-chart-2', dot: 'bg-chart-2' },
  failed: { bg: 'bg-destructive/20', text: 'text-destructive', dot: 'bg-destructive' },
  running: { bg: 'bg-primary/20', text: 'text-primary', dot: 'bg-primary' },
  pending: { bg: 'bg-muted/20', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  // CIT-123 slice 5 (design D8): compensation (#comp pseudo-node) statuses
  // get their OWN explicit entries so `statusStyle` never falls through to
  // the grey `pending` style above — that fallback would misrepresent an
  // in-flight or completed rollback as "not started". Distinct hues per
  // design (compensated=muted-info, compensating=amber,
  // compensation_failed=destructive-outline); every render site also pairs
  // the dot with a text label (never colour alone — accessibility rule).
  compensating: { bg: 'bg-chart-4/20', text: 'text-chart-4', dot: 'bg-chart-4' },
  compensated: { bg: 'bg-chart-3/20', text: 'text-chart-3', dot: 'bg-chart-3' },
  compensation_failed: { bg: 'bg-destructive/10', text: 'text-destructive', dot: 'bg-destructive' },
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
      usageTotals: parseUsageTotals(v.usageTotals),
      failureClass: typeof v.failureClass === 'string' ? v.failureClass : null,
      recommendedAction: typeof v.recommendedAction === 'string' ? v.recommendedAction : null,
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

/** CIT-123 slice 5: the `#comp` pseudo-node key convention (mirrors the
 * Python-side `_comp_key` in executor.py) — `${originalNodeId}#comp`. Real
 * node ids never contain '#' (validator-enforced), so this discriminator
 * cannot collide with a real node. */
const COMPENSATION_KEY_SUFFIX = '#comp';

function isCompensationNode(node: ExecutionNodeResult): boolean {
  return node.nodeId.endsWith(COMPENSATION_KEY_SUFFIX);
}

function originalNodeIdOf(compNodeId: string): string {
  return compNodeId.slice(0, -COMPENSATION_KEY_SUFFIX.length);
}

/** Splits the parsed node list into real DAG-node steps and `#comp`
 * compensation pseudo-nodes — the latter are never rendered in the Steps
 * section (design D7/D8: they are not real nodes and would be misleading
 * there). */
function splitCompensationNodes(
  nodes: ExecutionNodeResult[],
): { steps: ExecutionNodeResult[]; compensations: ExecutionNodeResult[] } {
  const steps: ExecutionNodeResult[] = [];
  const compensations: ExecutionNodeResult[] = [];
  for (const node of nodes) {
    if (isCompensationNode(node)) {
      compensations.push(node);
    } else {
      steps.push(node);
    }
  }
  return { steps, compensations };
}

/** Orders `#comp` pseudo-nodes by the execution's `compensationPlan`
 * (reverse-topological unwind order, design D5) rather than by
 * `startedAt` — the plan is the authoritative unwind order and is
 * available even before a later entry has dispatched (no startedAt yet). */
function orderCompensations(
  compensations: ExecutionNodeResult[],
  plan?: string[] | null,
): ExecutionNodeResult[] {
  if (!plan || plan.length === 0) return compensations;
  const byOriginalId = new Map(compensations.map((c) => [originalNodeIdOf(c.nodeId), c]));
  const ordered: ExecutionNodeResult[] = [];
  for (const originalId of plan) {
    const comp = byOriginalId.get(originalId);
    if (comp) {
      ordered.push(comp);
      byOriginalId.delete(originalId);
    }
  }
  // Any compensation not named in the plan (shouldn't happen, but never
  // drop data) is appended in its existing (startedAt-sorted) order.
  ordered.push(...byOriginalId.values());
  return ordered;
}

/** Parse compensationSummary (JSON string, already-parsed object, or
 * absent) into a CompensationSummary shape, or null when
 * absent/malformed. Never throws — mirrors parseUsageTotals's defensive
 * posture. */
function parseCompensationSummary(raw: unknown): CompensationSummary | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    if (value === '') return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const entries = Array.isArray(v.entries)
    ? (v.entries as unknown[])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({
          nodeId: typeof e.nodeId === 'string' ? e.nodeId : '',
          error: typeof e.error === 'string' ? e.error : '',
          failureClass: typeof e.failureClass === 'string' ? e.failureClass : '',
          recommendedAction: typeof e.recommendedAction === 'string' ? e.recommendedAction : '',
        }))
    : undefined;
  return {
    completed: Array.isArray(v.completed) ? (v.completed as string[]) : undefined,
    failed: Array.isArray(v.failed) ? (v.failed as string[]) : undefined,
    stoppedAt: typeof v.stoppedAt === 'string' ? v.stoppedAt : null,
    reason: typeof v.reason === 'string' ? v.reason : null,
    entries,
  };
}

/** Human label for a `#comp` pseudo-node status — paired with the dot in
 * every render site (accessibility rule: state is never colour alone). */
function compensationStatusLabel(status?: string | null): string {
  switch ((status || '').toLowerCase()) {
    case 'compensating':
      return 'Compensating';
    case 'compensated':
      return 'Compensated';
    case 'compensation_failed':
      return 'Compensation failed';
    default:
      return status || 'Unknown';
  }
}

/**
 * Header badge distinguishing a fully rolled-back failure from a partial
 * (stopped) one (design D8 / scope B). Returns null when the execution
 * never ran compensation at all (compensationStatus absent — legacy runs
 * or no policy), so the badge is omitted rather than shown as misleading
 * "n/a" text.
 */
function compensationBadgeLabel(compensationStatus?: string | null): string | null {
  switch (compensationStatus) {
    case 'completed':
      return 'rolled back';
    case 'partial':
    case 'running':
      return 'rollback incomplete';
    default:
      return null;
  }
}

/** Parse a usageTotals value (JSON string, already-parsed object, or absent)
 * into a UsageTotals shape, or null when absent/malformed/all-zero. Never
 * throws — a corrupted string or a non-object value degrades to null so the
 * caller can render nothing for it (legacy runs before this feature). */
function parseUsageTotals(raw: unknown): UsageTotals | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    if (value === '') return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const toNonNegInt = (x: unknown): number => {
    const n = typeof x === 'string' ? Number(x) : x;
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  };
  const totals: UsageTotals = {
    inputTokens: toNonNegInt(v.inputTokens),
    outputTokens: toNonNegInt(v.outputTokens),
    totalTokens: toNonNegInt(v.totalTokens),
    callCount: toNonNegInt(v.callCount),
  };
  return totals;
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

/** Raw duration in ms for a node (startedAt -> completedAt), or null when
 * either bound is missing/unparseable. Only completed durations are used
 * for percentiles — an in-flight node's "duration so far" would skew p50/p95
 * toward the current wall-clock moment rather than reflecting real latency. */
function nodeDurationMs(node: ExecutionNodeResult): number | null {
  if (!node.startedAt || !node.completedAt) return null;
  try {
    const start = new Date(node.startedAt).getTime();
    const end = new Date(node.completedAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return Math.max(0, end - start);
  } catch {
    return null;
  }
}

/**
 * Percentile surfacing decision: computed CLIENT-SIDE from the execution
 * row's per-node durations (already present in nodeResults — no new API).
 * This needs no backend change because the durations are already on the
 * row this sheet already fetches; a CloudWatch metrics-query API would add
 * a network round trip and a new resolver for numbers this component can
 * derive in-memory from data it already has. The CloudWatch percentiles
 * (fed by the emitted NodeDurationMs metric) are for the cross-execution
 * dashboards story, a different question (trend across many runs) than this
 * sheet's question (how did THIS run's nodes distribute).
 *
 * Nearest-rank method (ceil-based index into the ascending-sorted array) —
 * simple, deterministic, no interpolation. Returns null when fewer than 2
 * completed-duration samples exist (a percentile over 0-1 points isn't
 * informative).
 */
function computeDurationPercentiles(nodes: ExecutionNodeResult[]): { p50: number; p95: number; count: number } | null {
  const durations = nodes
    .map(nodeDurationMs)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  if (durations.length < 2) return null;
  const rank = (p: number) => {
    const idx = Math.ceil((p / 100) * durations.length) - 1;
    return durations[Math.min(Math.max(idx, 0), durations.length - 1)];
  };
  return { p50: rank(50), p95: rank(95), count: durations.length };
}

/** Format a raw ms value using the same thresholds as computeDuration. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

const PRE_CLASSES =
  'rounded-md border border-border/50 bg-background p-3 text-xs text-foreground font-mono max-h-80 overflow-auto whitespace-pre-wrap';

// ---- Component ----

export function ExecutionDetailSheet({
  execution,
  open,
  onClose,
  onViewTrace,
  onDownloadReplay,
}: ExecutionDetailSheetProps) {
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [inputExpanded, setInputExpanded] = useState(false);

  // Reset disclosure state whenever a different execution is shown
  useEffect(() => {
    setExpandedNodes({});
    setInputExpanded(false);
  }, [execution?.executionId]);

  const parsedNodes = useMemo(
    () => parseNodeResults(execution?.nodeResults),
    [execution?.nodeResults],
  );
  const { steps: nodeSteps, compensations: compensationNodesRaw } = useMemo(
    () => splitCompensationNodes(parsedNodes),
    [parsedNodes],
  );
  const compensationNodes = useMemo(
    () => orderCompensations(compensationNodesRaw, execution?.compensationPlan),
    [compensationNodesRaw, execution?.compensationPlan],
  );
  const compensationSummary = useMemo(
    () => parseCompensationSummary(execution?.compensationSummary),
    [execution?.compensationSummary],
  );
  const compensationBadge = useMemo(
    () => compensationBadgeLabel(execution?.compensationStatus),
    [execution?.compensationStatus],
  );
  const durationPercentiles = useMemo(
    () => computeDurationPercentiles(nodeSteps),
    [nodeSteps],
  );
  const prettyOutput = useMemo(() => prettyJson(execution?.output), [execution?.output]);
  const prettyInput = useMemo(() => prettyJson(execution?.input), [execution?.input]);
  const executionUsageTotals = useMemo(
    () => parseUsageTotals(execution?.usageTotals),
    [execution?.usageTotals],
  );

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
            {compensationBadge && (
              <Badge
                className={cn(
                  compensationBadge === 'rolled back'
                    ? 'bg-chart-3/20 text-chart-3'
                    : 'bg-destructive/10 text-destructive',
                  'text-xs border-0',
                )}
              >
                failed · {compensationBadge}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              Duration {computeDuration(execution.startedAt, execution.completedAt)}
            </span>
            {onViewTrace && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer ml-auto mr-6"
                onClick={() => onViewTrace(execution.executionId)}
              >
                <Waypoints className="size-3 mr-1" /> View trace
              </Button>
            )}
            {onDownloadReplay && (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-6 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer',
                  onViewTrace ? '' : 'ml-auto mr-6',
                )}
                onClick={() => onDownloadReplay(execution.executionId)}
              >
                <Download className="size-3 mr-1" /> Download replay package
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>Started {formatDate(execution.startedAt)}</span>
            {execution.completedAt && <span>Completed {formatDate(execution.completedAt)}</span>}
            {execution.triggeredBy && <span>Triggered by {execution.triggeredBy}</span>}
            {execution.workflowVersion != null && (
              <span>Workflow v{execution.workflowVersion}</span>
            )}
            {executionUsageTotals && executionUsageTotals.totalTokens > 0 && (
              <span>Total tokens {executionUsageTotals.totalTokens.toLocaleString()}</span>
            )}
            {durationPercentiles && (
              <span title={`Across ${durationPercentiles.count} completed nodes`}>
                Node duration p50 {formatMs(durationPercentiles.p50)} · p95 {formatMs(durationPercentiles.p95)}
              </span>
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
                        {node.usageTotals && node.usageTotals.totalTokens > 0 && (
                          <span
                            className="text-muted-foreground flex-shrink-0"
                            title={`in ${node.usageTotals.inputTokens} / out ${node.usageTotals.outputTokens}`}
                          >
                            {node.usageTotals.totalTokens.toLocaleString()} tok
                          </span>
                        )}
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
                          {node.usageTotals && node.usageTotals.totalTokens > 0 && (
                            <p className="text-xs text-muted-foreground">
                              Input {node.usageTotals.inputTokens} · Output {node.usageTotals.outputTokens} ·
                              {' '}Total {node.usageTotals.totalTokens} · {node.usageTotals.callCount}{' '}
                              {node.usageTotals.callCount === 1 ? 'call' : 'calls'}
                            </p>
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

          {/* Compensations — CIT-123 slice 5 (design D8): #comp pseudo-nodes,
              rendered in unwind (reverse-topo) order, never in Steps above.
              Omitted entirely when the execution never ran compensation. */}
          {compensationNodes.length > 0 && (
            <section aria-label="Compensations">
              <h3 className="text-sm font-medium text-foreground mb-2">Compensations</h3>
              <div className="flex flex-col gap-1">
                {compensationNodes.map((node) => {
                  const isExpanded = !!expandedNodes[node.nodeId];
                  const nodeStyle = statusStyle(node.status);
                  const originalNodeId = originalNodeIdOf(node.nodeId);
                  const summaryEntry = compensationSummary?.entries?.find(
                    (e) => e.nodeId === originalNodeId,
                  );
                  const failureClass = node.failureClass ?? summaryEntry?.failureClass ?? null;
                  const recommendedAction =
                    node.recommendedAction ?? summaryEntry?.recommendedAction ?? null;
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
                        <span className="font-mono text-foreground truncate">{originalNodeId}</span>
                        {/* Text label alongside the dot — state is never colour alone. */}
                        <span className={cn('flex-shrink-0', nodeStyle.text)}>
                          {compensationStatusLabel(node.status)}
                        </span>
                        <span className="ml-auto text-muted-foreground flex-shrink-0">
                          {computeDuration(node.startedAt, node.completedAt)}
                        </span>
                      </Button>
                      {isExpanded && (
                        <div className="flex flex-col gap-2 border-t border-border/50 p-2">
                          {node.error && (
                            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive whitespace-pre-wrap">
                              {node.error}
                            </div>
                          )}
                          {(failureClass || recommendedAction) && (
                            <p className="text-xs text-muted-foreground">
                              {failureClass && <>Failure class {failureClass}</>}
                              {failureClass && recommendedAction && ' · '}
                              {recommendedAction && <>Recommended action {recommendedAction}</>}
                            </p>
                          )}
                          {!node.error && !failureClass && !recommendedAction && (
                            <p className="text-xs text-muted-foreground">No detail recorded.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}


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
