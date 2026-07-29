/**
 * TraceWaterfall — renders the full waterfall: one header + duration ruler +
 * span tree per trace (design §3: multiple traces per correlation id are
 * possible — one Lambda/worker hop each — so they stack, sorted by
 * startTime, each with its own header and ruler).
 *
 * All non-happy-path states (loading/indexing/empty/unauthorized/unavailable)
 * are delegated to `TraceStates` — this component only renders once data is
 * actually available and non-empty.
 */
import { Badge } from '../ui/badge';
import { TraceDurationRuler } from './TraceDurationRuler';
import { TraceSpanRow } from './TraceSpanRow';
import type { TraceSummary } from '../../services/traceService';

interface TraceWaterfallProps {
  traces: TraceSummary[];
}

function traceStatusBadge(trace: TraceSummary): { label: string; variant: 'destructive' | 'warning' | 'default' } | null {
  // fault > error > throttle > ok (design §3/§6 precedence)
  if (trace.hasFault) return { label: 'fault', variant: 'destructive' };
  if (trace.hasError) return { label: 'error', variant: 'destructive' };
  if (trace.hasThrottle) return { label: 'throttle', variant: 'warning' };
  return null;
}

export function TraceWaterfall({ traces }: TraceWaterfallProps) {
  const sorted = [...traces].sort((a, b) => a.startTime - b.startTime);

  return (
    <div className="flex flex-col gap-6" data-testid="trace-waterfall">
      {sorted.map((trace) => {
        const badge = traceStatusBadge(trace);
        return (
          <div key={trace.traceId} className="rounded-md border border-border/50" data-testid="trace-block">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
              <span className="font-mono text-xs text-foreground truncate" title={trace.traceId}>
                {trace.rootName || trace.traceId}
              </span>
              <span className="text-xs text-muted-foreground font-mono truncate">{trace.traceId}</span>
              {badge && (
                <Badge variant={badge.variant} className="text-[10px] px-1 py-0">
                  {badge.label}
                </Badge>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{trace.durationMs}ms</span>
              {trace.annotations?.source_trace_id && (
                <span
                  className="text-xs text-muted-foreground"
                  title={`Linked from trace ${trace.annotations.source_trace_id}`}
                >
                  ↳ linked
                </span>
              )}
            </div>
            <TraceDurationRuler totalDurationMs={trace.durationMs} />
            <div className="p-3">
              {trace.spans.length === 0 ? (
                <p className="text-xs text-muted-foreground">No spans recorded for this trace.</p>
              ) : (
                trace.spans.map((span) => (
                  <TraceSpanRow key={span.id} span={span} depth={0} traceDurationMs={trace.durationMs} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
