/**
 * Governance Escalation Drill-Down
 *
 * Read-only admin page combining two backends:
 *   1. listGovernanceFindings({ decision: 'escalate', sinceTs }) — the
 *      rich list with full finding context.
 *   2. getEscalationMetricSeries — CloudWatch
 *      CitadelGovernance/OffFrontierEscalations totals so operators can
 *      correlate alarm fires to ledger entries.
 *
 * Layout per the wave spec:
 *   1. Header.
 *   2. Filter bar (time range + group-by + refresh).
 *   3. Summary cards (4): total escalations, distinct workflows, distinct
 *      requesting agents, alarm fires.
 *   4. Trend sparkline (Recharts AreaChart, chart-4 token).
 *   5. Grouped list (Accordion) or flat chronological table.
 *   6. Empty state when no escalations in the window.
 *
 * No new dependencies — Recharts AreaChart is already used elsewhere
 * (Dashboard, AppDetailView, ReconcilerDrift). Only token-based colours.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart,
  Area,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { MetricCard, type MetricCardAccent } from '../../components/governance/MetricCard';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  GovernanceFinding,
  MetricSeries,
} from '../../services/governanceService';

type RangeFilter = '24h' | '7d' | '30d';
type GroupByFilter = 'workflow' | 'agent' | 'none';

const RANGE_TO_SECONDS: Record<RangeFilter, number> = {
  '24h': 24 * 3600,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
};

// Match the rollout/mismatches resolver behaviour: pull at most 200 rows
// per page so the grouped list stays responsive. If there are more than
// 200 in the window we surface a Load-more affordance and keep paging.
const PAGE_LIMIT = 200;

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
 * Token-render the colon-separated reason format used everywhere in the
 * governance ledger. Mirrors the small helper inside Ledger.tsx; kept
 * inline here so the page stays decoupled from the ledger's drawer file
 * (no shared module yet exists for governance UI tokens).
 */
function ReasonTokens({ reason }: { reason: string }) {
  if (!reason) return <span className="text-muted-foreground text-xs">—</span>;
  const tokens = reason.split(':');
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tokens.map((token, i) => (
        <span
          key={`${i}-${token}`}
          className="font-mono text-xs px-1 rounded bg-muted"
        >
          {token}
        </span>
      ))}
    </div>
  );
}

function truncateArn(arn: string | null | undefined): string {
  if (!arn) return '—';
  if (arn.length <= 32) return arn;
  return `${arn.slice(0, 16)}…${arn.slice(-12)}`;
}

interface CopyButtonProps {
  value: string;
}

function CopyButton({ value }: CopyButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      className="size-auto h-auto p-0 text-muted-foreground hover:text-foreground hover:bg-transparent"
      title="Copy"
      data-testid="escalation-copy"
      onClick={(e) => {
        e.stopPropagation();
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(value).catch(() => {
            /* swallow */
          });
        }
      }}
    >
      <Copy className="size-3" />
    </Button>
  );
}

interface SummaryCardsProps {
  totalEscalations: number;
  distinctWorkflows: number;
  distinctAgents: number;
  alarmFires: number;
}

function SummaryCards({
  totalEscalations,
  distinctWorkflows,
  distinctAgents,
  alarmFires,
}: SummaryCardsProps) {
  // Alarm fires are a heightened-attention signal during the rollout —
  // any non-zero value gets a warning accent so the operator's eye lands
  // on it first. Other counts are informational and stay default.
  const alarmAccent: MetricCardAccent = alarmFires > 0 ? 'warning' : 'default';
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
      data-testid="escalation-summary-cards"
    >
      <MetricCard
        label="Total escalations"
        value={totalEscalations}
        testId="escalation-summary-total"
      />
      <MetricCard
        label="Distinct workflows"
        value={distinctWorkflows}
        testId="escalation-summary-workflows"
      />
      <MetricCard
        label="Distinct requesting agents"
        value={distinctAgents}
        testId="escalation-summary-agents"
      />
      <MetricCard
        label="Alarm fires"
        value={alarmFires}
        accent={alarmAccent}
        testId="escalation-summary-alarms"
      />
    </div>
  );
}

interface TrendSparklineProps {
  series: MetricSeries;
}

function TrendSparkline({ series }: TrendSparklineProps) {
  // Map epoch-seconds to a label per the active period — at hour granularity
  // we show ISO-ish HH:00 stamps; daily windows use YYYY-MM-DD; minute-grain
  // uses HH:MM. Recharts' XAxis tickFormatter handles the rest.
  const data = series.datapoints.map((d) => ({
    timestamp: d.timestamp,
    value: d.value,
  }));
  const periodLabel =
    series.periodSeconds === 86400
      ? 'day'
      : series.periodSeconds === 3600
        ? 'hour'
        : series.periodSeconds === 300
          ? '5 minutes'
          : 'minute';

  const tickFormatter = (ts: number): string => {
    const d = new Date(ts * 1000);
    if (series.periodSeconds >= 86400) {
      return d.toISOString().slice(0, 10);
    }
    if (series.periodSeconds >= 3600) {
      return `${d.toISOString().slice(11, 13)}:00`;
    }
    return d.toISOString().slice(11, 16);
  };

  return (
    <Card
      className="p-3 mb-6 gap-0"
      data-testid="escalation-trend-sparkline"
    >
      <p className="text-muted-foreground text-xs mb-2">
        OffFrontierEscalations alarm fires per {periodLabel}
      </p>
      <ResponsiveContainer width="100%" height={80}>
        <AreaChart
          data={data}
          margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
        >
          <defs>
            <linearGradient
              id="escalation-trend-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                className="text-chart-4"
                stopColor="currentColor"
                stopOpacity={0.5}
              />
              <stop
                offset="95%"
                className="text-chart-4"
                stopColor="currentColor"
                stopOpacity={0.05}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            className="stroke-border"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={[series.sinceTs, series.untilTs]}
            tickFormatter={tickFormatter}
            className="text-[10px]"
          />
          <YAxis allowDecimals={false} className="text-[10px]" width={28} />
          <RTooltip
            labelFormatter={(ts: number) => formatIso(ts)}
            formatter={(value: number) => [value, 'Alarm fires']}
          />
          <Area
            type="monotone"
            dataKey="value"
            className="stroke-chart-4"
            strokeWidth={1.5}
            fill="url(#escalation-trend-fill)"
            dot={{ r: 2, className: 'fill-chart-4 stroke-chart-4' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

interface FindingRowProps {
  finding: GovernanceFinding;
  showWorkflow: boolean;
  showAgent: boolean;
  onView: (id: string) => void;
}

function FindingRow({
  finding,
  showWorkflow,
  showAgent,
  onView,
}: FindingRowProps) {
  return (
    <TableRow data-testid="escalation-row">
      <TableCell title={formatIso(finding.timestamp)}>
        <span className="text-xs text-muted-foreground">
          {formatRelative(finding.timestamp)}
        </span>
      </TableCell>
      <TableCell>
        <ReasonTokens reason={finding.reason} />
      </TableCell>
      {showWorkflow && (
        <TableCell>
          <span className="font-mono text-xs">{finding.workflowId}</span>
        </TableCell>
      )}
      {showAgent && (
        <TableCell>
          <span className="font-mono text-xs">{finding.requestingAgent}</span>
        </TableCell>
      )}
      <TableCell>
        <span className="inline-flex items-center gap-1">
          <span
            className="font-mono text-xs"
            title={finding.escalationTarget ?? ''}
          >
            {truncateArn(finding.escalationTarget)}
          </span>
          {finding.escalationTarget && (
            <CopyButton value={finding.escalationTarget} />
          )}
        </span>
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onView(finding.findingId)}
          data-testid="escalation-view-finding"
        >
          View finding
        </Button>
      </TableCell>
    </TableRow>
  );
}

interface FlatTableProps {
  findings: GovernanceFinding[];
  onView: (id: string) => void;
}

function FlatTable({ findings, onView }: FlatTableProps) {
  return (
    <Card
      className="p-0 gap-0 overflow-hidden"
      data-testid="escalation-flat-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Timestamp</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Escalation target</TableHead>
            <TableHead className="w-32">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((f) => (
            <FindingRow
              key={f.findingId}
              finding={f}
              showWorkflow
              showAgent
              onView={onView}
            />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

interface GroupedListProps {
  groups: Array<{ key: string; findings: GovernanceFinding[] }>;
  groupBy: GroupByFilter;
  onView: (id: string) => void;
}

function GroupedList({ groups, groupBy, onView }: GroupedListProps) {
  const showWorkflow = groupBy === 'agent';
  const showAgent = groupBy === 'workflow';
  return (
    <Card
      className="p-2 gap-0"
      data-testid="escalation-grouped-list"
    >
      <Accordion type="multiple" className="w-full">
        {groups.map((g) => (
          <AccordionItem
            key={g.key}
            value={g.key}
            data-testid="escalation-group"
          >
            <AccordionTrigger className="px-2">
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm">{g.key || '—'}</span>
                <Badge
                  variant="secondary"
                  data-testid="escalation-group-count"
                >
                  {g.findings.length}
                </Badge>
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Reason</TableHead>
                    {showWorkflow && <TableHead>Workflow</TableHead>}
                    {showAgent && <TableHead>Agent</TableHead>}
                    <TableHead>Escalation target</TableHead>
                    <TableHead className="w-32">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.findings.map((f) => (
                    <FindingRow
                      key={f.findingId}
                      finding={f}
                      showWorkflow={showWorkflow}
                      showAgent={showAgent}
                      onView={onView}
                    />
                  ))}
                </TableBody>
              </Table>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Card>
  );
}

interface FilterBarProps {
  range: RangeFilter;
  onRangeChange: (r: RangeFilter) => void;
  groupBy: GroupByFilter;
  onGroupByChange: (g: GroupByFilter) => void;
  onRefresh: () => void;
  loading: boolean;
}

function FilterBar({
  range,
  onRangeChange,
  groupBy,
  onGroupByChange,
  onRefresh,
  loading,
}: FilterBarProps) {
  return (
    <div
      className="flex items-end gap-3 mb-4 flex-wrap"
      data-testid="escalation-filter-bar"
    >
      <div className="flex flex-col gap-1">
        <Label
          htmlFor="escalation-range-trigger"
          className="text-xs text-muted-foreground"
        >
          Time range
        </Label>
        <Select
          value={range}
          onValueChange={(v) => onRangeChange(v as RangeFilter)}
        >
          <SelectTrigger id="escalation-range-trigger" className="w-[140px]">
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
          htmlFor="escalation-groupby-trigger"
          className="text-xs text-muted-foreground"
        >
          Group by
        </Label>
        <Select
          value={groupBy}
          onValueChange={(v) => onGroupByChange(v as GroupByFilter)}
        >
          <SelectTrigger
            id="escalation-groupby-trigger"
            className="w-[200px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workflow">Workflow</SelectItem>
            <SelectItem value="agent">Requesting agent</SelectItem>
            <SelectItem value="none">None (chronological)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="outline"
        onClick={onRefresh}
        disabled={loading}
        data-testid="escalation-refresh"
      >
        Refresh
      </Button>
    </div>
  );
}

interface LoadingSkeletonProps {
  showFilters?: boolean;
}

function LoadingSkeleton({ showFilters = true }: LoadingSkeletonProps) {
  return (
    <div data-testid="escalation-loading">
      {showFilters && (
        <div className="flex gap-3 mb-4">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-9 w-24" />
        </div>
      )}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-20 w-full mb-6" />
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
      data-testid="escalation-error"
    >
      <p className="text-destructive text-sm font-medium">
        Failed to load escalations
      </p>
      <p className="text-muted-foreground text-xs mt-1">{message}</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={onRetry}
        data-testid="escalation-retry"
      >
        Retry
      </Button>
    </div>
  );
}

export function GovernanceEscalations() {
  const navigate = useNavigate();
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [range, setRange] = useState<RangeFilter>('7d');
  const [groupBy, setGroupBy] = useState<GroupByFilter>('workflow');
  const [findings, setFindings] = useState<GovernanceFinding[]>([]);
  const [series, setSeries] = useState<MetricSeries | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const fetchData = useCallback(async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceTs = nowSec - RANGE_TO_SECONDS[range];
    const untilTs = nowSec;

    const [conn, metric] = await Promise.all([
      governanceService.listGovernanceFindings({
        decision: 'escalate',
        sinceTs,
        limit: PAGE_LIMIT,
      }),
      governanceService.getEscalationMetricSeries({
        sinceTs,
        untilTs,
        periodSeconds: RANGE_TO_SECONDS[range] >= 30 * 86400 ? 86400 : 3600,
      }),
    ]);
    return { conn, metric };
  }, [range]);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    fetchData()
      .then(({ conn, metric }) => {
        if (!mounted) return;
        setFindings(conn.items);
        setNextCursor(conn.nextCursor);
        setSeries(metric);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load escalations';
        setError(msg);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin, fetchData, reloadKey]);

  const fetchMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const sinceTs = nowSec - RANGE_TO_SECONDS[range];
      const conn = await governanceService.listGovernanceFindings({
        decision: 'escalate',
        sinceTs,
        limit: PAGE_LIMIT,
        cursor: nextCursor,
      });
      setFindings((prev) => [...prev, ...conn.items]);
      setNextCursor(conn.nextCursor);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to load more escalations';
      setError(msg);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, range]);

  const handleViewFinding = useCallback(
    (findingId: string) => {
      // Deep-link to the ledger with the finding pre-selected. The Ledger
      // page does not yet read findingId from URL search params on
      // mount — see Mismatches.tsx for the same TODO. Wire that up alongside
      // the Mismatches deep-link in a follow-up.
      // TODO(wave-2.D-followup): Ledger.tsx should read ?findingId= and
      // open the side drawer with that finding.
      navigate(`/governance/ledger?findingId=${encodeURIComponent(findingId)}`);
    },
    [navigate],
  );

  // Sort findings descending by timestamp for chronological display, then
  // group as requested. Distinct counts come from the un-grouped list.
  const sortedFindings = useMemo(
    () => [...findings].sort((a, b) => b.timestamp - a.timestamp),
    [findings],
  );

  const distinctWorkflows = useMemo(() => {
    const set = new Set<string>();
    for (const f of sortedFindings) if (f.workflowId) set.add(f.workflowId);
    return set.size;
  }, [sortedFindings]);

  const distinctAgents = useMemo(() => {
    const set = new Set<string>();
    for (const f of sortedFindings)
      if (f.requestingAgent) set.add(f.requestingAgent);
    return set.size;
  }, [sortedFindings]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [];
    const acc = new Map<string, GovernanceFinding[]>();
    for (const f of sortedFindings) {
      const key = groupBy === 'workflow' ? f.workflowId : f.requestingAgent;
      const list = acc.get(key) ?? [];
      list.push(f);
      acc.set(key, list);
    }
    // Sort groups descending by count so the highest-volume workflows /
    // agents float to the top of the page.
    return Array.from(acc.entries())
      .map(([key, fList]) => ({ key, findings: fList }))
      .sort((a, b) => b.findings.length - a.findings.length);
  }, [sortedFindings, groupBy]);

  if (!isAdmin) {
    return (
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="Escalations" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Off-frontier escalations
          </h2>
          <p className="text-muted-foreground text-sm">
            Operator review of escalation decisions during the rollout. Each
            row links to the originating governance finding.
          </p>
        </div>
        <div
          className="rounded-lg border border-chart-2/40 bg-chart-2/20 p-6 text-sm text-foreground"
          data-testid="escalation-admin-only"
        >
          Admin only — escalation drill-down requires admin access
        </div>
      </PageContainer>
    );
  }

  const totalEscalations = sortedFindings.length;
  const alarmFires = series?.total ?? 0;

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Escalations" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Off-frontier escalations
        </h2>
        <p className="text-muted-foreground text-sm">
          Operator review of escalation decisions during the rollout. Each
          row links to the originating governance finding.
        </p>
      </div>

      <FilterBar
        range={range}
        onRangeChange={setRange}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        onRefresh={() => setReloadKey((k) => k + 1)}
        loading={loading}
      />

      {loading ? (
        <LoadingSkeleton showFilters={false} />
      ) : error ? (
        <ErrorCard
          message={error}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : (
        <>
          <SummaryCards
            totalEscalations={totalEscalations}
            distinctWorkflows={distinctWorkflows}
            distinctAgents={distinctAgents}
            alarmFires={alarmFires}
          />

          {series && <TrendSparkline series={series} />}

          {totalEscalations === 0 ? (
            <div
              className="rounded-lg border border-chart-2/40 bg-chart-2/10 p-6 text-sm text-foreground"
              data-testid="escalation-empty-state"
            >
              No escalations in the selected window. Strict-flip soak is
              clean for this period.
            </div>
          ) : groupBy === 'none' ? (
            <FlatTable findings={sortedFindings} onView={handleViewFinding} />
          ) : (
            <GroupedList
              groups={groups}
              groupBy={groupBy}
              onView={handleViewFinding}
            />
          )}

          {nextCursor && totalEscalations > 0 && (
            <div className="flex justify-center mt-4">
              <Button
                variant="outline"
                onClick={fetchMore}
                disabled={loadingMore}
                data-testid="escalation-load-more"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}

export default GovernanceEscalations;
