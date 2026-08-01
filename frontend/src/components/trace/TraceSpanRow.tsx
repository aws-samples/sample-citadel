/**
 * TraceSpanRow — one recursive row in the collapsible span tree. Renders a
 * CSS left%/width% positioned duration bar (hand-rolled per design §5 — no
 * charting lib) plus tree indentation and a fault/error/throttle badge.
 *
 * Status badge precedence: fault > error > throttle > ok (design §3/§6).
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/utils';
import type { TraceSpan } from '../../services/traceService';

const STATUS_BADGE: Record<string, { label: string; variant: 'destructive' | 'warning' | 'default' }> = {
  fault: { label: 'fault', variant: 'destructive' },
  error: { label: 'error', variant: 'destructive' },
  throttle: { label: 'throttle', variant: 'warning' },
};

const BAR_COLOR: Record<string, string> = {
  fault: 'bg-destructive',
  error: 'bg-destructive/80',
  throttle: 'bg-chart-3',
  ok: 'bg-primary',
};

interface TraceSpanRowProps {
  span: TraceSpan;
  depth: number;
  /** Total duration of the enclosing trace, in ms — the bar left%/width% denominator. */
  traceDurationMs: number;
}

export function TraceSpanRow({ span, depth, traceDurationMs }: TraceSpanRowProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = span.children.length > 0;
  const safeTotal = Math.max(traceDurationMs, 1);
  const leftPct = Math.min(Math.max((span.startOffsetMs / safeTotal) * 100, 0), 100);
  const widthPct = Math.min(Math.max((span.durationMs / safeTotal) * 100, 0.5), 100 - leftPct);
  const badge = STATUS_BADGE[span.status];
  const barColor = BAR_COLOR[span.status] ?? BAR_COLOR.ok;

  return (
    <div data-testid="trace-span-row" data-span-id={span.id} data-status={span.status}>
      <div className="flex items-center gap-2 py-1 text-xs">
        <div
          className="flex items-center gap-1 shrink-0"
          style={{ paddingLeft: `${depth * 16}px`, width: '260px' }}
        >
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-4 shrink-0"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse span' : 'Expand span'}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <ChevronDown className="size-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 text-muted-foreground" />
              )}
            </Button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <span className="truncate font-mono text-foreground" title={span.name}>
            {span.name}
          </span>
          {badge && (
            <Badge variant={badge.variant} className="text-[10px] px-1 py-0 shrink-0">
              {badge.label}
            </Badge>
          )}
        </div>

        <div className="relative flex-1 h-4">
          <div
            className={cn('absolute top-0 h-4 rounded-sm', barColor, span.inProgress && 'animate-pulse')}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            title={`${span.name} · ${span.durationMs}ms${span.http?.status ? ` · HTTP ${span.http.status}` : ''}`}
          />
        </div>

        <span className="w-16 text-right text-muted-foreground shrink-0">
          {span.inProgress ? 'in progress' : `${span.durationMs}ms`}
        </span>
      </div>

      {span.error && expanded && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive mb-1"
          style={{ marginLeft: `${depth * 16 + 20}px` }}
        >
          <span className="font-medium">{span.error.type}:</span> {span.error.message}
        </div>
      )}

      {hasChildren && expanded && (
        <div>
          {span.children.map((child) => (
            <TraceSpanRow key={child.id} span={child} depth={depth + 1} traceDurationMs={traceDurationMs} />
          ))}
        </div>
      )}
    </div>
  );
}
