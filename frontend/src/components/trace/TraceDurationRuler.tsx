/**
 * TraceDurationRuler — top time axis shared across all traces in a waterfall.
 * Hand-rolled CSS left%/width% ticks (no charting lib — see design §5
 * justification: this app's comparable visualizations are all hand-rolled
 * div/SVG, not cartesian-series charts).
 */

interface TraceDurationRulerProps {
  /** Total span of the ruler in milliseconds (the max trace/span extent). */
  totalDurationMs: number;
  /** Number of tick marks to render (evenly spaced, inclusive of 0 and total). */
  tickCount?: number;
}

function formatTickMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function TraceDurationRuler({ totalDurationMs, tickCount = 5 }: TraceDurationRulerProps) {
  const safeTotal = Math.max(totalDurationMs, 1);
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const fraction = i / (tickCount - 1);
    return { leftPct: fraction * 100, ms: fraction * safeTotal };
  });

  return (
    <div
      className="relative h-6 border-b border-border/50 text-[10px] text-muted-foreground select-none"
      role="presentation"
      aria-label="Trace duration ruler"
      data-testid="trace-duration-ruler"
    >
      {ticks.map((tick, i) => (
        <div
          key={i}
          className="absolute top-0 flex flex-col items-start"
          style={{ left: `${tick.leftPct}%` }}
        >
          <span className="border-l border-border/50 h-2 block" />
          <span className={i === tickCount - 1 ? '-translate-x-full' : undefined}>
            {formatTickMs(tick.ms)}
          </span>
        </div>
      ))}
    </div>
  );
}
