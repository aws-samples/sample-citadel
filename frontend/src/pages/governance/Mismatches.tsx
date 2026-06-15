/**
 * Governance Mismatch Heatmap
 *
 * Read-only admin page. Surfaces deny + escalate density during the 7-day
 * shadow soak window so operators can validate strict-flip readiness
 * before the actual flip ships.
 *
 * Layout per the wave spec:
 *   1. Header with title + subtitle.
 *   2. Filter bar — time range + granularity + mode badge.
 *   3. Summary cards — total denials, total escalations, peak hour.
 *   4. Heatmap grid — rows = days, columns = hours (or single row for 24h).
 *   5. Empty state when totalDenials + totalEscalations = 0.
 *
 * No new dependencies; the heatmap is plain CSS grid styled with Tailwind
 * tokens only (single-hue scale on `bg-destructive`, 5 quintile steps).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Skeleton } from '../../components/ui/skeleton';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Label } from '../../components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  MetricCard,
  type MetricCardAccent,
} from '../../components/governance/MetricCard';
import {
  governanceService,
  MismatchHeatmapReport,
  MismatchBucket,
} from '../../services/governanceService';

type RangeFilter = '24h' | '7d' | '30d';
type Granularity = '900' | '3600' | '86400';

const RANGE_TO_SECONDS: Record<RangeFilter, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
};

// Five-step quintile colour scale on the destructive token. Values chosen to
// span 10% → 90% so even a low-count cell is visible against `bg-muted/30`.
const QUINTILE_CLASSES: string[] = [
  'bg-destructive/10',
  'bg-destructive/30',
  'bg-destructive/50',
  'bg-destructive/70',
  'bg-destructive/90',
];
const EMPTY_CELL_CLASS = 'bg-muted/30';

function formatRelative(tsSec: number): string {
  const diffMs = Date.now() - tsSec * 1000;
  const sec = Math.abs(diffMs) / 1000;
  if (sec < 60) return diffMs >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatIso(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString();
}

/**
 * Map a count to its quintile class. The active quintile boundaries are
 * computed from the maximum count in the visible buckets, so the scale
 * adapts to whatever density is actually present in the window.
 */
function colourForCount(count: number, max: number): string {
  if (count <= 0 || max <= 0) return EMPTY_CELL_CLASS;
  const step = max / 5;
  for (let i = 0; i < 5; i++) {
    if (count <= step * (i + 1)) return QUINTILE_CLASSES[i];
  }
  return QUINTILE_CLASSES[4];
}

interface AggregatedCell {
  bucketStart: number;
  count: number;
  // Decision grouping — when both deny + escalate land in the same cell we
  // pick the dominant one (highest count) for the click-through filter.
  // A null decision means "mixed; click sends decision=deny by default".
  dominantDecision: string;
  topReason: string | null;
}

/**
 * Sum bucket counts across decisions per bucketStart so the cell colour
 * reflects the total mismatch density for the cell rather than only the
 * deny or only the escalate slice.
 */
function aggregateBuckets(buckets: MismatchBucket[]): Map<number, AggregatedCell> {
  const out = new Map<number, AggregatedCell>();
  for (const b of buckets) {
    const existing = out.get(b.bucketStart);
    if (!existing) {
      out.set(b.bucketStart, {
        bucketStart: b.bucketStart,
        count: b.count,
        dominantDecision: b.decision,
        topReason: b.topReason,
      });
      continue;
    }
    existing.count += b.count;
    if (b.count > existing.count - b.count) {
      // The new slice is now the larger of the two; promote it.
      existing.dominantDecision = b.decision;
      existing.topReason = b.topReason;
    }
  }
  return out;
}

interface HeatmapCellProps {
  cell: AggregatedCell | null;
  bucketStart: number;
  bucketSeconds: number;
  max: number;
  onClick: (cell: AggregatedCell) => void;
}

function HeatmapCell({
  cell,
  bucketStart,
  bucketSeconds,
  max,
  onClick,
}: HeatmapCellProps) {
  const count = cell?.count ?? 0;
  const cls = colourForCount(count, max);
  const tooltip = cell
    ? `${cell.count} ${cell.dominantDecision} • ${formatIso(cell.bucketStart)} • top reason: ${
        cell.topReason ?? 'unknown'
      }`
    : `0 mismatches • ${formatIso(bucketStart)}`;

  const handleClick = () => {
    if (cell) onClick(cell);
  };

  // Use a span when there is no content — keeps the keyboard tab-order clean.
  if (!cell) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`block h-6 w-full rounded-sm ${cls}`}
            data-testid="heatmap-cell-empty"
            aria-label={tooltip}
            data-bucket-seconds={bucketSeconds}
          />
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          className={`block h-6 w-full rounded-sm border border-transparent hover:border-foreground/40 hover:bg-transparent p-0 ${cls}`}
          onClick={handleClick}
          data-testid="heatmap-cell"
          data-bucket-start={cell.bucketStart}
          data-decision={cell.dominantDecision}
          aria-label={tooltip}
        >
          <span className="sr-only">{tooltip}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface HeatmapGridProps {
  report: MismatchHeatmapReport;
  cells: Map<number, AggregatedCell>;
  onCellClick: (cell: AggregatedCell) => void;
}

/**
 * 7-day × 24-hour grid (when bucketSeconds = 3600 and window = 7d).
 * Day rows are sourced from sinceTs..untilTs; hours are 0–23.
 */
function HourlyGrid({ report, cells, onCellClick }: HeatmapGridProps) {
  const hourSecs = 3600;
  const daySecs = 86_400;
  // Anchor each row to UTC midnight to keep the grid stable across days.
  const sinceDayStart = Math.floor(report.sinceTs / daySecs) * daySecs;
  const untilDayStart = Math.floor(report.untilTs / daySecs) * daySecs;
  const dayCount = Math.max(
    1,
    Math.round((untilDayStart - sinceDayStart) / daySecs) + 1,
  );

  const max = useMemo(() => {
    let m = 0;
    for (const c of cells.values()) if (c.count > m) m = c.count;
    return m;
  }, [cells]);

  const rows: Array<{ dayStart: number; label: string }> = [];
  for (let i = 0; i < dayCount; i++) {
    const dayStart = sinceDayStart + i * daySecs;
    rows.push({
      dayStart,
      label: new Date(dayStart * 1000)
        .toISOString()
        .slice(0, 10),
    });
  }

  return (
    <Card
      className="p-4 gap-0"
      data-testid="mismatch-heatmap-grid"
      data-bucket-seconds={report.bucketSeconds}
    >
      <div
        className="grid gap-1 text-xs"
        style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
      >
        {/* Header row */}
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={`h-${h}`}
            className="text-muted-foreground text-center text-[10px]"
          >
            {String(h).padStart(2, '0')}
          </div>
        ))}
        {/* Day rows */}
        {rows.map((row) => (
          <div key={`row-${row.dayStart}`} className="contents">
            <div className="text-muted-foreground pr-2 text-[10px] flex items-center">
              {row.label}
            </div>
            {Array.from({ length: 24 }, (_, h) => {
              const bucketStart = row.dayStart + h * hourSecs;
              const cell = cells.get(bucketStart) ?? null;
              return (
                <HeatmapCell
                  key={`c-${bucketStart}`}
                  cell={cell}
                  bucketStart={bucketStart}
                  bucketSeconds={report.bucketSeconds}
                  max={max}
                  onClick={onCellClick}
                />
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}

function SingleRowGrid({ report, cells, onCellClick }: HeatmapGridProps) {
  const hourSecs = 3600;
  const startHour = Math.floor(report.sinceTs / hourSecs) * hourSecs;
  const endHour = Math.floor(report.untilTs / hourSecs) * hourSecs;
  const hourCount = Math.max(1, Math.round((endHour - startHour) / hourSecs) + 1);

  const max = useMemo(() => {
    let m = 0;
    for (const c of cells.values()) if (c.count > m) m = c.count;
    return m;
  }, [cells]);

  return (
    <Card
      className="p-4 gap-0"
      data-testid="mismatch-heatmap-grid"
      data-bucket-seconds={report.bucketSeconds}
    >
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${hourCount}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: hourCount }, (_, i) => {
          const bucketStart = startHour + i * hourSecs;
          const cell = cells.get(bucketStart) ?? null;
          return (
            <HeatmapCell
              key={`c-${bucketStart}`}
              cell={cell}
              bucketStart={bucketStart}
              bucketSeconds={report.bucketSeconds}
              max={max}
              onClick={onCellClick}
            />
          );
        })}
      </div>
    </Card>
  );
}

function DailyGrid({ report, cells, onCellClick }: HeatmapGridProps) {
  const daySecs = 86_400;
  const startDay = Math.floor(report.sinceTs / daySecs) * daySecs;
  const endDay = Math.floor(report.untilTs / daySecs) * daySecs;
  const dayCount = Math.max(1, Math.round((endDay - startDay) / daySecs) + 1);

  const max = useMemo(() => {
    let m = 0;
    for (const c of cells.values()) if (c.count > m) m = c.count;
    return m;
  }, [cells]);

  return (
    <Card
      className="p-4 gap-0"
      data-testid="mismatch-heatmap-grid"
      data-bucket-seconds={report.bucketSeconds}
    >
      <div
        className="grid gap-1 text-xs"
        style={{
          gridTemplateColumns: `repeat(${Math.min(dayCount, 30)}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: dayCount }, (_, i) => {
          const bucketStart = startDay + i * daySecs;
          const cell = cells.get(bucketStart) ?? null;
          return (
            <HeatmapCell
              key={`c-${bucketStart}`}
              cell={cell}
              bucketStart={bucketStart}
              bucketSeconds={report.bucketSeconds}
              max={max}
              onClick={onCellClick}
            />
          );
        })}
      </div>
    </Card>
  );
}

interface SummaryCardsProps {
  report: MismatchHeatmapReport;
  cells: Map<number, AggregatedCell>;
  loading?: boolean;
}

function SummaryCards({ report, cells, loading = false }: SummaryCardsProps) {
  const peak = useMemo(() => {
    let best: AggregatedCell | null = null;
    for (const c of cells.values()) {
      if (!best || c.count > best.count) best = c;
    }
    return best;
  }, [cells]);

  // No state-derived accents on the mismatch summary cards today; reserve
  // the typed alias so accents can be wired in later without re-importing.
  const denialsAccent: MetricCardAccent = 'default';
  const escalationsAccent: MetricCardAccent = 'default';
  const peakAccent: MetricCardAccent = 'default';

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6"
      data-testid="mismatch-summary-cards"
    >
      <MetricCard
        label="Total denials"
        value={report.totalDenials}
        loading={loading}
        accent={denialsAccent}
        testId="mismatch-summary-denials"
      />
      <MetricCard
        label="Total escalations"
        value={report.totalEscalations}
        loading={loading}
        accent={escalationsAccent}
        testId="mismatch-summary-escalations"
      />
      <MetricCard
        label="Peak bucket"
        value={peak ? peak.count : 'None in window'}
        description={
          peak ? (
            <span data-testid="mismatch-summary-peak-time">
              {formatIso(peak.bucketStart)} ·{' '}
              {formatRelative(peak.bucketStart)}
            </span>
          ) : undefined
        }
        loading={loading}
        accent={peakAccent}
        testId="mismatch-summary-peak"
      />
    </div>
  );
}

interface FilterBarProps {
  range: RangeFilter;
  onRangeChange: (r: RangeFilter) => void;
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
  modeBadge: { mode: string; windowStartIso: string };
}

function FilterBar({
  range,
  onRangeChange,
  granularity,
  onGranularityChange,
  modeBadge,
}: FilterBarProps) {
  return (
    <div
      className="flex items-end gap-3 mb-4 flex-wrap"
      data-testid="mismatch-filter-bar"
    >
      <div className="flex flex-col gap-1">
        <Label
          htmlFor="mismatch-range-trigger"
          className="text-xs text-muted-foreground"
        >
          Time range
        </Label>
        <Select
          value={range}
          onValueChange={(v) => onRangeChange(v as RangeFilter)}
        >
          <SelectTrigger id="mismatch-range-trigger" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24h</SelectItem>
            <SelectItem value="7d">Last 7d</SelectItem>
            <SelectItem value="30d">Last 30d</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label
          htmlFor="mismatch-granularity-trigger"
          className="text-xs text-muted-foreground"
        >
          Granularity
        </Label>
        <Select
          value={granularity}
          onValueChange={(v) => onGranularityChange(v as Granularity)}
        >
          <SelectTrigger
            id="mismatch-granularity-trigger"
            className="w-[140px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="900">15 min</SelectItem>
            <SelectItem value="3600">1 hour</SelectItem>
            <SelectItem value="86400">1 day</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card
        className="ml-auto inline-flex flex-row items-center gap-2 rounded-md bg-muted/30 px-3 py-2"
        data-testid="mismatch-mode-badge"
      >
        <span className="text-muted-foreground text-xs">Mode</span>
        <span className="text-foreground text-xs font-medium capitalize">
          {modeBadge.mode}
        </span>
        <span className="text-muted-foreground text-xs">·</span>
        <span className="text-muted-foreground text-xs">
          window since {modeBadge.windowStartIso}
        </span>
      </Card>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="mismatch-loading">
      <div className="flex gap-3 mb-4">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-48 ml-auto" />
      </div>
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

interface ErrorCardProps {
  message: string;
  onRetry: () => void;
}

function ErrorCard({ message, onRetry }: ErrorCardProps) {
  return (
    <div
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-5"
      data-testid="mismatch-error"
    >
      <p className="text-destructive text-sm font-medium">
        Failed to load mismatch heatmap
      </p>
      <p className="text-muted-foreground text-xs mt-1">{message}</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={onRetry}
        data-testid="mismatch-retry"
      >
        Retry
      </Button>
    </div>
  );
}

export function GovernanceMismatches() {
  const navigate = useNavigate();
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [range, setRange] = useState<RangeFilter>('7d');
  const [granularity, setGranularity] = useState<Granularity>('3600');
  const [report, setReport] = useState<MismatchHeatmapReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const buildArgs = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      sinceTs: nowSec - RANGE_TO_SECONDS[range],
      untilTs: nowSec,
      bucketSeconds: Number(granularity),
    };
  }, [range, granularity]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    governanceService
      .getMismatchHeatmap(buildArgs())
      .then((r) => {
        if (!mounted) return;
        setReport(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load mismatch heatmap';
        setError(msg);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin, buildArgs, reloadKey]);

  // 30d + hourly = 720 cells. Auto-fall-back to daily and surface a banner
  // so the operator knows to switch granularity if they need finer detail.
  const dailyFallbackBanner =
    range === '30d' && granularity === '3600' ? (
      <Card
        className="bg-muted/30 p-3 mb-3 text-xs text-muted-foreground gap-0"
        data-testid="mismatch-daily-fallback-note"
      >
        30-day windows render with daily buckets to keep the grid readable.
        Switch granularity to 15 min or 1 hour for shorter ranges.
      </Card>
    ) : null;
  const effectiveGranularity: Granularity =
    range === '30d' && granularity === '3600' ? '86400' : granularity;

  const cells = useMemo<Map<number, AggregatedCell>>(() => {
    if (!report) return new Map();
    return aggregateBuckets(report.buckets);
  }, [report]);

  const handleCellClick = useCallback(
    (cell: AggregatedCell) => {
      if (!report) return;
      const params = new URLSearchParams();
      params.set('sinceTs', String(cell.bucketStart));
      params.set('untilTs', String(cell.bucketStart + report.bucketSeconds));
      params.set('decision', cell.dominantDecision);
      // TODO(wave-2.D): Ledger.tsx does not yet read these query params on
      // mount — the navigation lands on /governance/ledger with the URL
      // bar carrying the filters but the page itself defaults to its own
      // 24h decision=all view. Wire up Ledger.tsx to honour this in 2.D.
      navigate(`/governance/ledger?${params.toString()}`);
    },
    [report, navigate],
  );

  if (!isAdmin) {
    return (
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="Mismatch heatmap" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Mismatch heatmap
          </h2>
          <p className="text-muted-foreground text-sm">
            Denial and escalation density during the rollout soak window. Use
            this view to validate strict-flip readiness.
          </p>
        </div>
        <div
          className="rounded-lg border border-chart-2/40 bg-chart-2/20 p-6 text-sm text-foreground"
          data-testid="mismatch-admin-only"
        >
          Admin only — mismatch heatmap requires admin access
        </div>
      </PageContainer>
    );
  }

  const totalMismatches = report
    ? report.totalDenials + report.totalEscalations
    : 0;
  const modeBadge = report
    ? {
        mode: report.modeWindows[0]?.mode ?? 'unknown',
        windowStartIso: formatIso(report.sinceTs),
      }
    : { mode: 'unknown', windowStartIso: '—' };

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Mismatch heatmap" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Mismatch heatmap
        </h2>
        <p className="text-muted-foreground text-sm">
          Denial and escalation density during the rollout soak window. Use
          this view to validate strict-flip readiness.
        </p>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        <ErrorCard
          message={error}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : report ? (
        <>
          <FilterBar
            range={range}
            onRangeChange={setRange}
            granularity={granularity}
            onGranularityChange={setGranularity}
            modeBadge={modeBadge}
          />
          {dailyFallbackBanner}
          <SummaryCards report={report} cells={cells} />
          {totalMismatches === 0 ? (
            <div
              className="rounded-lg border border-chart-2/40 bg-chart-2/10 p-6 text-sm text-foreground"
              data-testid="mismatch-empty-state"
            >
              No mismatches in the selected window. The shadow soak is clean
              for this period.
            </div>
          ) : effectiveGranularity === '86400' ? (
            <DailyGrid
              report={report}
              cells={cells}
              onCellClick={handleCellClick}
            />
          ) : range === '24h' ? (
            <SingleRowGrid
              report={report}
              cells={cells}
              onCellClick={handleCellClick}
            />
          ) : (
            <HourlyGrid
              report={report}
              cells={cells}
              onCellClick={handleCellClick}
            />
          )}
        </>
      ) : null}
    </PageContainer>
  );
}

export default GovernanceMismatches;
