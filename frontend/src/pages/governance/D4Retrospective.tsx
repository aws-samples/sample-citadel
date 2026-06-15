/**
 * Governance D4 defense-in-depth retrospective
 *
 * Read-only admin page. Compares the denial sets at the worker
 * pre-filter and worker tool-handler engine scopes over a configurable
 * window (allowlist: 7, 14, 30, 60, 90 days; default 30) and surfaces
 * the recommendation that drives the QD-5 decision: keep both layers,
 * keep both with strong evidence, or re-debate.
 *
 * Algorithm: ports `arbiter/governance/d4_retrospective.py` verbatim.
 * The Python script is the source of truth for the four thresholds
 * (`>0.9 → re-debate`, `<0.2 → keep-both-strong-evidence`,
 * `toolHandlerTotal < 1 → deferred-90d`, else `keep-both`). The
 * resolver caches successful reads for 5 minutes, so the Refresh
 * button is best-effort within that TTL.
 *
 * Layout (mirrors Mismatches.tsx):
 *   1. Header (title + subtitle)
 *   2. Filter bar (Window Select + Refresh)
 *   3. Summary cards row (4 cards: pre-filter / tool-handler totals,
 *      overlap count, overlap ratio %)
 *   4. Recommendation badge card (large; 4 visual variants)
 *   5. Venn diagram (full-width SVG, area-proportional)
 *   6. Truncation banner (when truncated=true)
 *   7. Empty state (when both sets empty)
 *   8. Last refreshed footer
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { Circle } from '@visx/shape';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Skeleton } from '../../components/ui/skeleton';
import { Button } from '../../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Label } from '../../components/ui/label';
import { Card } from '../../components/ui/card';
import { cn } from '../../components/ui/utils';
import {
  MetricCard,
  type MetricCardAccent,
} from '../../components/governance/MetricCard';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  D4RetrospectiveReport,
} from '../../services/governanceService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type WindowDays = 7 | 14 | 30 | 60 | 90;
const WINDOW_OPTIONS: ReadonlyArray<{ value: WindowDays; label: string }> = [
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days' },
];
const DEFAULT_WINDOW_DAYS: WindowDays = 30;

// Recommendation visual + label mapping. Threshold copy is interpolated
// at render time so the actual measured ratio is included in the
// subline. Border colour is supplied via the MetricCard accent system
// (RECOMMENDATION_ACCENT → ACCENT_BORDER_CLASS) so the callout shares
// the governance-page palette; bgClass carries the background tint /
// ring effects unique to each recommendation tier.
interface RecommendationVisual {
  bgClass: string;
  badgeClass: string;
  label: string;
  subline: (overlapPct: string) => string;
}

const RECOMMENDATION_VISUALS: Record<string, RecommendationVisual> = {
  'keep-both': {
    bgClass: 'bg-chart-2/10',
    badgeClass: 'bg-chart-2/20 text-chart-2 border-chart-2/40',
    label: 'Keep both layers (overlap moderate)',
    subline: (pct) =>
      `Overlap ratio is ${pct}, between the 20% and 90% thresholds. The two layers catch overlapping but not redundant sets — keep both.`,
  },
  'keep-both-strong-evidence': {
    bgClass: 'bg-chart-2/20 ring-1 ring-chart-2',
    badgeClass: 'bg-chart-2/30 text-chart-2 border-chart-2/60',
    label: 'Keep both layers (strong evidence; overlap < 20%)',
    subline: (pct) =>
      `Overlap ratio is ${pct}, below the 20% threshold. Strong evidence the two layers catch DISTINCT classes of violations — QD-5 invariant validated.`,
  },
  're-debate': {
    bgClass: 'bg-destructive/10',
    badgeClass: 'bg-destructive/20 text-destructive border-destructive/60',
    label: 'Re-debate (overlap > 90%; layers may be redundant)',
    subline: (pct) =>
      `Overlap ratio is ${pct}, exceeding the 90% threshold. The two layers catch substantially the same (workflow_id, reason) tuples — consider whether one can be retired without loss of defense.`,
  },
  'deferred-90d': {
    bgClass: 'bg-muted/40',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    label: 'Insufficient evidence — retrospective deferred 90 days',
    subline: () =>
      'Fewer than 1 worker-tool-handler finding observed in this window. Defer the retrospective until enough telemetry accumulates — the tool-handler layer may not yet be wired into dispatch, or traffic is too low to draw conclusions.',
  },
};

const DEFAULT_RECOMMENDATION_VISUAL: RecommendationVisual = {
  bgClass: 'bg-muted/30',
  badgeClass: 'bg-muted text-muted-foreground border-border',
  label: 'Recommendation unknown',
  subline: () => 'The resolver returned a recommendation value the UI does not recognise.',
};

// Map each recommendation to one of MetricCard's accent slots so the
// callout's border colour matches the governance-page palette. The
// matching border-class is resolved via ACCENT_BORDER_CLASS below.
const RECOMMENDATION_ACCENT: Record<string, MetricCardAccent> = {
  'keep-both': 'success',
  'keep-both-strong-evidence': 'success',
  're-debate': 'destructive',
  'deferred-90d': 'default',
};

// Border-class lookup mirrored from MetricCard's internal ACCENT_BORDER
// (kept private inside MetricCard.tsx). Duplicated here so the
// Recommendation callout — which is NOT a metric — can still share the
// accent-driven border colour without forcing MetricCard to expose its
// internal table. Update both sites if the shared palette changes.
const ACCENT_BORDER_CLASS: Record<MetricCardAccent, string> = {
  default: 'border-border',
  primary: 'border-primary/40',
  success: 'border-chart-2/40',
  warning: 'border-chart-4/40',
  destructive: 'border-destructive/40',
  muted: 'border-muted-foreground/20',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0.0%';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatRelative(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return 'unknown';
  const diffMs = Date.now() - epochSec * 1000;
  const sec = Math.abs(diffMs) / 1000;
  if (sec < 60) return diffMs >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return diffMs >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `${days}d ago` : `in ${days}d`;
}

function formatIso(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return 'unknown';
  return new Date(epochSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface FilterBarProps {
  windowDays: WindowDays;
  onWindowChange: (w: WindowDays) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

function FilterBar({
  windowDays,
  onWindowChange,
  onRefresh,
  refreshing,
}: FilterBarProps) {
  return (
    <div
      className="flex items-end gap-3 mb-4 flex-wrap"
      data-testid="d4-filter-bar"
    >
      <div className="flex flex-col gap-1">
        <Label
          htmlFor="d4-window-trigger"
          className="text-xs text-muted-foreground"
        >
          Window
        </Label>
        <Select
          value={String(windowDays)}
          onValueChange={(v) => onWindowChange(Number(v) as WindowDays)}
        >
          <SelectTrigger
            id="d4-window-trigger"
            className="w-[160px]"
            data-testid="d4-window-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="outline"
        onClick={onRefresh}
        disabled={refreshing}
        data-testid="d4-refresh-button"
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>
    </div>
  );
}

interface SummaryCardsProps {
  report: D4RetrospectiveReport;
}

function SummaryCards({ report }: SummaryCardsProps) {
  const overlapPct = formatPercent(report.overlapRatio);
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
      data-testid="d4-summary-cards"
    >
      <MetricCard
        testId="d4-summary-pre-filter-total"
        label="Pre-filter total denies"
        value={report.counts.preFilterTotal}
        description={`${report.counts.distinctPreFilter} distinct (workflow, reason)`}
      />
      <MetricCard
        testId="d4-summary-tool-handler-total"
        label="Tool-handler total denies"
        value={report.counts.toolHandlerTotal}
        description={`${report.counts.distinctToolHandler} distinct (workflow, reason)`}
      />
      <MetricCard
        testId="d4-summary-overlap-count"
        label="Overlap (intersection)"
        value={report.counts.overlap}
        description="tuples in BOTH layers"
      />
      <MetricCard
        testId="d4-summary-overlap-ratio"
        label="Overlap ratio"
        value={overlapPct}
        description="overlap / max(distinct)"
      />
    </div>
  );
}

interface RecommendationBadgeProps {
  report: D4RetrospectiveReport;
}

function RecommendationBadge({ report }: RecommendationBadgeProps) {
  const visual =
    RECOMMENDATION_VISUALS[report.recommendation] ??
    DEFAULT_RECOMMENDATION_VISUAL;
  const accent =
    RECOMMENDATION_ACCENT[report.recommendation] ?? 'default';
  const accentBorderClass = ACCENT_BORDER_CLASS[accent];
  const overlapPct = formatPercent(report.overlapRatio);
  return (
    <Card
      className={cn(accentBorderClass, visual.bgClass, 'p-5 mb-6 block gap-0')}
      data-testid="d4-recommendation-card"
      data-recommendation={report.recommendation}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-block px-3 py-1 rounded-full text-xs font-semibold border',
              visual.badgeClass,
            )}
            data-testid="d4-recommendation-badge"
          >
            {report.recommendation}
          </span>
          <span
            className="text-foreground text-base font-semibold"
            data-testid="d4-recommendation-label"
          >
            {visual.label}
          </span>
        </div>
      </div>
      <p
        className="text-muted-foreground text-sm"
        data-testid="d4-recommendation-subline"
      >
        {visual.subline(overlapPct)}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Venn diagram
// ---------------------------------------------------------------------------

interface VennGeometry {
  rA: number;
  rB: number;
  cxA: number;
  cxB: number;
  cy: number;
}

/**
 * Compute deterministic geometry for the two-circle Venn given counts.
 *
 * Radii are scaled by `sqrt(distinct)` so circle AREA tracks the
 * cardinality of each set (a Venn aesthetic that survives even when
 * one set is much larger than the other). Distance between centres is
 * approximated by `(rA + rB) - sqrt(overlap / pi) * 2` — not a precise
 * area-of-circular-segment solution, but visually meaningful and
 * cheap to compute. We clamp the distance to `[0, rA + rB]` so the
 * circles never separate or stack identically.
 */
export function computeVennGeometry(
  distinctA: number,
  distinctB: number,
  overlap: number,
  width: number,
  height: number,
): VennGeometry {
  const margin = 24;
  const usableW = Math.max(width - margin * 2, 100);
  const cy = height / 2;

  const aSafe = Math.max(distinctA, 0);
  const bSafe = Math.max(distinctB, 0);
  const overlapSafe = Math.max(0, Math.min(overlap, Math.min(aSafe, bSafe)));

  // Scale radii so the diameter sum + visible separation fits the
  // usable width. Use sqrt for area-proportional sizing; floor the
  // minimum so even tiny sets remain visible.
  const rawRA = Math.sqrt(Math.max(aSafe, 1));
  const rawRB = Math.sqrt(Math.max(bSafe, 1));
  const maxRaw = Math.max(rawRA, rawRB);
  // Reserve up to 40% of the width for one circle so two side-by-side
  // never overshoot the box.
  const scale = (usableW * 0.4) / maxRaw;
  const minR = 36;
  const rA = Math.max(rawRA * scale, minR);
  const rB = Math.max(rawRB * scale, minR);

  // Visual proxy for the overlap distance.
  const overlapRadius = Math.sqrt(overlapSafe / Math.PI);
  const distance = Math.max(
    0,
    Math.min(rA + rB, rA + rB - overlapRadius * 2),
  );

  // Centre the geometry inside the box.
  const totalSpan = rA + distance + rB;
  const startX = margin + Math.max(0, (usableW - totalSpan) / 2);
  const cxA = startX + rA;
  const cxB = cxA + distance;

  return { rA, rB, cxA, cxB, cy };
}

interface VennDiagramProps {
  report: D4RetrospectiveReport;
}

function VennDiagram({ report }: VennDiagramProps) {
  if (report.insufficientEvidence) {
    return (
      <Card
        className="bg-muted/30 p-4 mb-6 block gap-0"
        data-testid="d4-venn-insufficient"
        style={{ height: 400 }}
      >
        <ParentSize>
          {({ width }) => (
            <svg
              width={width}
              height={400}
              data-testid="d4-venn-svg"
              role="img"
              aria-label="Insufficient evidence — single grey circle"
            >
              <Group top={200} left={width / 2}>
                <Circle
                  cx={0}
                  cy={0}
                  r={120}
                  className="fill-muted/60 stroke-border"
                  strokeWidth={2}
                  data-testid="d4-venn-insufficient-circle"
                />
                <text
                  x={0}
                  y={0}
                  className="fill-muted-foreground text-xs"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  Insufficient evidence
                </text>
                <text
                  x={0}
                  y={20}
                  className="fill-muted-foreground text-[10px]"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  less than 1 tool-handler finding observed in this window
                </text>
              </Group>
            </svg>
          )}
        </ParentSize>
      </Card>
    );
  }

  return (
    <Card
      className="p-4 mb-6 block gap-0"
      data-testid="d4-venn-container"
      style={{ height: 400 }}
    >
      <ParentSize>
        {({ width }) => {
          const height = 400;
          const geom = computeVennGeometry(
            report.counts.distinctPreFilter,
            report.counts.distinctToolHandler,
            report.counts.overlap,
            width,
            height,
          );
          return (
            <svg
              width={width}
              height={height}
              data-testid="d4-venn-svg"
              role="img"
              aria-label="Two-circle Venn diagram comparing pre-filter and tool-handler denial sets"
            >
              <Group>
                <Circle
                  cx={geom.cxA}
                  cy={geom.cy}
                  r={geom.rA}
                  className="fill-chart-4 stroke-chart-4"
                  fillOpacity={0.4}
                  strokeWidth={2}
                  data-testid="d4-venn-circle-a"
                />
                <Circle
                  cx={geom.cxB}
                  cy={geom.cy}
                  r={geom.rB}
                  className="fill-destructive stroke-destructive"
                  fillOpacity={0.4}
                  strokeWidth={2}
                  data-testid="d4-venn-circle-b"
                />
                <text
                  x={geom.cxA}
                  y={geom.cy - geom.rA - 10}
                  textAnchor="middle"
                  className="fill-foreground text-xs font-medium"
                  data-testid="d4-venn-label-a"
                >
                  Pre-filter
                </text>
                <text
                  x={geom.cxA}
                  y={geom.cy - geom.rA + 6}
                  textAnchor="middle"
                  className="fill-foreground text-[11px]"
                >
                  {report.counts.distinctPreFilter} tuples
                </text>
                <text
                  x={geom.cxB}
                  y={geom.cy - geom.rB - 10}
                  textAnchor="middle"
                  className="fill-foreground text-xs font-medium"
                  data-testid="d4-venn-label-b"
                >
                  Tool-handler
                </text>
                <text
                  x={geom.cxB}
                  y={geom.cy - geom.rB + 6}
                  textAnchor="middle"
                  className="fill-foreground text-[11px]"
                >
                  {report.counts.distinctToolHandler} tuples
                </text>
                <text
                  x={(geom.cxA + geom.cxB) / 2}
                  y={geom.cy + 4}
                  textAnchor="middle"
                  className="fill-foreground text-sm font-semibold"
                  data-testid="d4-venn-overlap-label"
                >
                  {report.counts.overlap}
                </text>
                <text
                  x={(geom.cxA + geom.cxB) / 2}
                  y={geom.cy + 22}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  overlap
                </text>
              </Group>
            </svg>
          );
        }}
      </ParentSize>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading + error states
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div data-testid="d4-loading">
      <div className="flex gap-3 mb-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-24 w-full mb-6" />
      <Skeleton className="h-[400px] w-full" />
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
      data-testid="d4-error"
    >
      <p className="text-destructive text-sm font-medium">
        Failed to load D4 retrospective
      </p>
      <p className="text-muted-foreground text-xs mt-1">{message}</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={onRetry}
        data-testid="d4-retry"
      >
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GovernanceD4Retrospective() {
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [windowDays, setWindowDays] = useState<WindowDays>(DEFAULT_WINDOW_DAYS);
  const [report, setReport] = useState<D4RetrospectiveReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    governanceService
      .getD4RetrospectiveReport(windowDays)
      .then((r) => {
        if (!mounted) return;
        setReport(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load D4 retrospective';
        setError(msg);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin, windowDays, reloadKey]);

  const handleRefresh = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const totalFindings = useMemo(() => {
    if (!report) return 0;
    return report.counts.preFilterTotal + report.counts.toolHandlerTotal;
  }, [report]);

  if (!isAdmin) {
    return (
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="D4 retrospective" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            D4 defense-in-depth retrospective
          </h2>
          <p className="text-muted-foreground text-sm">
            Compare denial sets at the worker pre-filter and tool-handler
            scopes. Recommendation drives the QD-5 decision: keep both layers,
            or re-debate.
          </p>
        </div>
        <div
          className="rounded-lg border border-chart-2/40 bg-chart-2/20 p-6 text-sm text-foreground"
          data-testid="d4-admin-only"
        >
          Admin only — D4 retrospective requires admin access
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="D4 retrospective" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          D4 defense-in-depth retrospective
        </h2>
        <p className="text-muted-foreground text-sm">
          Compare denial sets at the worker pre-filter and tool-handler
          scopes. Recommendation drives the QD-5 decision: keep both layers,
          or re-debate.
        </p>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        <ErrorCard message={error} onRetry={handleRefresh} />
      ) : report ? (
        <>
          <FilterBar
            windowDays={windowDays}
            onWindowChange={setWindowDays}
            onRefresh={handleRefresh}
            refreshing={false}
          />
          {report.truncated && (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 mb-4 text-xs text-foreground"
              data-testid="d4-truncation-banner"
            >
              Result is based on the first 5000 ledger findings in the window;
              tighten the window for a complete view.
            </div>
          )}
          <SummaryCards report={report} />
          <RecommendationBadge report={report} />
          {totalFindings === 0 && !report.insufficientEvidence ? (
            <div
              className="rounded-lg border border-chart-2/40 bg-chart-2/10 p-6 text-sm text-foreground"
              data-testid="d4-empty-state"
            >
              No denials at either scope in the last {report.windowDays} days.
              The system is denial-free for this period.
            </div>
          ) : (
            <VennDiagram report={report} />
          )}
          <p
            className="text-muted-foreground text-xs mt-3"
            data-testid="d4-last-refreshed"
          >
            Computed {formatIso(report.generatedAt)} (
            {formatRelative(report.generatedAt)})
          </p>
        </>
      ) : null}
    </PageContainer>
  );
}

export default GovernanceD4Retrospective;
