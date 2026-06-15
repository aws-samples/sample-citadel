/**
 * Governance Overview — landing page.
 *
 * Layout: page header → 3-up status row (mode / ledger pulse / reconciler) →
 * responsive navigation tile grid for governance tools & views.
 */

import { useEffect, useState } from 'react';
import {
  Shield,
  FileText,
  GitMerge,
  PlayCircle,
  AlertTriangle,
  AlertOctagon,
  Activity,
  Network,
  ScrollText,
  Gavel,
  Layers,
  KeyRound,
  type LucideIcon,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { PageContainer } from '../../components/PageContainer';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { Button } from '../../components/ui/button';
import { useGovernanceMode } from '../../hooks/useGovernanceMode';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  GovernanceFinding,
  ReconcilerStatus,
} from '../../services/governanceService';

const STAGE_LABEL: Record<string, string> = {
  permissive: 'Bypass mode \u2014 telemetry only',
  shadow: 'Shadow mode \u2014 evaluating, not enforcing',
  strict: 'Strict mode \u2014 enforcing fail-closed',
};

const MODE_BORDER: Record<string, string> = {
  permissive: 'border-border',
  shadow: 'border-chart-4/40',
  strict: 'border-chart-2/40',
  unknown: 'border-border',
};

interface NavTile {
  id: string;
  label: string;
  description: string;
  path: string;
  icon: LucideIcon;
  adminOnly: boolean;
}

// Tile id MUST match the testid suffix that the test suite asserts on.
// `case-law` is intentionally hyphenated to preserve the existing
// `governance-link-case-law` testid contract.
const NAV_TILES: NavTile[] = [
  {
    id: 'ledger',
    label: 'Ledger',
    description: 'Browse governance findings with filters',
    path: '/governance/ledger',
    icon: FileText,
    adminOnly: false,
  },
  {
    id: 'reconciler',
    label: 'Reconciler',
    description: 'Registry vs. ledger drift classifications',
    path: '/governance/reconciler',
    icon: GitMerge,
    adminOnly: true,
  },
  {
    id: 'rollout',
    label: 'Rollout readiness',
    description: 'Mode-flip wizard with live readiness checks',
    path: '/governance/rollout',
    icon: PlayCircle,
    adminOnly: true,
  },
  {
    id: 'mismatches',
    label: 'Mismatch heatmap',
    description: '7-day \u00d7 24-hour heatmap of workload-identity mismatches',
    path: '/governance/mismatches',
    icon: AlertTriangle,
    adminOnly: true,
  },
  {
    id: 'escalations',
    label: 'Escalations',
    description: 'Off-frontier drill-down by project',
    path: '/governance/escalations',
    icon: AlertOctagon,
    adminOnly: true,
  },
  {
    id: 'tracer',
    label: 'Decision flow tracer',
    description: 'Animated 8-step pipeline + counterfactual',
    path: '/governance/tracer',
    icon: Activity,
    adminOnly: true,
  },
  {
    id: 'graph',
    label: 'Authority graph',
    description: 'Force-directed authority + blast-radius',
    path: '/governance/graph',
    icon: Network,
    adminOnly: true,
  },
  {
    id: 'constitution',
    label: 'Constitution',
    description: 'Constitutional rule tree + admin editor',
    path: '/governance/constitution',
    icon: ScrollText,
    adminOnly: true,
  },
  {
    id: 'case-law',
    label: 'Case law',
    description: 'Precedence timeline + revoke / unrevoke',
    path: '/governance/case-law',
    icon: Gavel,
    adminOnly: true,
  },
  {
    id: 'd4',
    label: 'D4 retrospective',
    description: 'Defense-in-depth Venn analysis',
    path: '/governance/d4',
    icon: Layers,
    adminOnly: true,
  },
  {
    id: 'iam',
    label: 'IAM trust path',
    description: 'Two-hop assume chain + drift detector',
    path: '/governance/iam',
    icon: KeyRound,
    adminOnly: true,
  },
];

/**
 * Backend SSM stores '__EMPTY__' as a sentinel for not-yet-set parameters;
 * it must not leak through to the UI. Treat anything that doesn't parse
 * as a date as 'not yet'.
 */
function sanitizeEffectiveAt(value: string | null | undefined): string | null {
  if (!value || value === '__EMPTY__') return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return value;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'not yet';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'not yet';
  const diffMs = Date.now() - then;
  const absSec = Math.abs(diffMs) / 1000;
  if (absSec < 60) return diffMs >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(absSec / 60);
  if (minutes < 60) return diffMs >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `${days}d ago` : `in ${days}d`;
}

interface DecisionCounts {
  permit: number;
  deny: number;
  escalate: number;
}

function groupByDecision(items: GovernanceFinding[]): DecisionCounts {
  const counts: DecisionCounts = { permit: 0, deny: 0, escalate: 0 };
  for (const item of items) {
    if (item.decision === 'permit') counts.permit++;
    else if (item.decision === 'deny') counts.deny++;
    else if (item.decision === 'escalate') counts.escalate++;
  }
  return counts;
}

function NavTile({
  tile,
  onNavigate,
}: {
  tile: NavTile;
  onNavigate: (path: string) => void;
}) {
  const Icon = tile.icon;
  const handleActivate = () => onNavigate(tile.path);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleActivate();
    }
  };
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className="cursor-pointer transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`governance-link-${tile.id}`}
    >
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-md bg-primary/15 flex items-center justify-center shrink-0">
            <Icon className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base leading-tight">{tile.label}</CardTitle>
            <CardDescription className="text-xs font-mono mt-1 truncate">
              {tile.path}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{tile.description}</p>
      </CardContent>
    </Card>
  );
}

function ModeCard() {
  const { mode, loading } = useGovernanceMode();
  const enforce = mode?.enforce;
  const isKnown = enforce === 'permissive' || enforce === 'shadow' || enforce === 'strict';
  const stageKey = isKnown ? enforce : 'unknown';
  const borderClass = MODE_BORDER[stageKey] || 'border-border';
  const stageLabel = isKnown
    ? STAGE_LABEL[enforce as string]
    : 'Mode unknown \u2014 telemetry unavailable';
  const safeEffectiveAt = sanitizeEffectiveAt(mode?.effectiveAt);

  return (
    <Card className={borderClass} data-testid="governance-mode-card">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
            <Shield className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <CardDescription className="text-sm">Current mode</CardDescription>
            {loading ? (
              <Skeleton className="h-9 w-32 mt-1" />
            ) : (
              <CardTitle
                className="text-foreground text-3xl font-bold capitalize"
                data-testid="mode-card-enforce"
              >
                {isKnown ? enforce : 'unknown'}
              </CardTitle>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-muted-foreground">
            Effective at:{' '}
            <span className="text-foreground font-mono">
              {safeEffectiveAt ?? 'not yet'}
            </span>
            {safeEffectiveAt && (
              <span className="text-muted-foreground"> ({formatRelative(safeEffectiveAt)})</span>
            )}
          </p>
          <p className="text-muted-foreground">
            Environment:{' '}
            <span className="text-foreground font-mono">{mode?.env ?? 'unknown'}</span>
          </p>
          <p className="text-muted-foreground pt-2 text-xs">{stageLabel}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function LedgerPulseCard() {
  const [counts, setCounts] = useState<DecisionCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const sinceTs = Math.floor(Date.now() / 1000) - 86_400;
    governanceService
      .listGovernanceFindings({ sinceTs, limit: 200 })
      .then((conn) => {
        if (!mounted) return;
        setCounts(groupByDecision(conn.items));
        setError(null);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message || 'Failed to load ledger');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const total = counts ? counts.permit + counts.deny + counts.escalate : 0;
  const data = counts
    ? [
        { name: 'PERMIT', value: counts.permit, fill: 'var(--color-chart-2)' },
        { name: 'DENY', value: counts.deny, fill: 'var(--color-destructive)' },
        { name: 'ESCALATE', value: counts.escalate },
      ]
    : [];

  return (
    <Card data-testid="governance-ledger-pulse">
      <CardHeader>
        <CardTitle className="text-base">24h Ledger Pulse</CardTitle>
        <CardDescription className="text-xs">
          PERMIT / DENY / ESCALATE decisions
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[160px] w-full" />
        ) : error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : total === 0 ? (
          <div className="h-[160px] flex items-center justify-center text-muted-foreground text-xs">
            No findings in last 24h
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data} layout="vertical" margin={{ left: 10, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" allowDecimals={false} className="text-xs" />
              <YAxis type="category" dataKey="name" width={80} className="text-xs" />
              <Tooltip cursor={{ fill: 'var(--color-muted)' }} />
              <Bar dataKey="value">
                {data.map((entry) => (
                  <Cell
                    key={entry.name}
                    className={
                      entry.name === 'PERMIT'
                        ? 'fill-chart-2'
                        : entry.name === 'DENY'
                          ? 'fill-destructive'
                          : 'fill-amber-500'
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function ReconcilerCard({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<ReconcilerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    governanceService
      .getReconcilerStatus()
      .then((s) => {
        if (!mounted) return;
        setStatus(s);
        setError(null);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message || 'Failed to load reconciler status');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <Card data-testid="reconciler-admin-only">
        <CardHeader>
          <CardTitle className="text-base">Reconciler</CardTitle>
          <CardDescription className="text-xs">Drift classifications</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[160px] w-full" aria-label="Admin-only" />
          <p className="text-muted-foreground text-xs mt-2 text-center">Admin-only</p>
        </CardContent>
      </Card>
    );
  }

  const cls = status?.classifications;
  const data = cls
    ? [
        { name: 'In-sync', value: cls.inSync, key: 'inSync' },
        { name: 'Missing', value: cls.missing, key: 'missing' },
        { name: 'Stale', value: cls.stale, key: 'stale' },
        { name: 'Orphan', value: cls.orphan, key: 'orphan' },
      ]
    : [];
  const total = cls ? cls.inSync + cls.missing + cls.stale + cls.orphan : 0;

  return (
    <Card data-testid="governance-reconciler-card">
      <CardHeader>
        <CardTitle className="text-base">Reconciler</CardTitle>
        <CardDescription className="text-xs">Drift classifications</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[160px] w-full" />
        ) : error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : total === 0 ? (
          <div className="h-[160px] flex items-center justify-center text-muted-foreground text-xs">
            No reconciler run yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={35}
                outerRadius={60}
              >
                {data.map((entry) => (
                  <Cell
                    key={entry.key}
                    className={
                      entry.key === 'inSync'
                        ? 'fill-chart-2'
                        : entry.key === 'missing'
                          ? 'fill-chart-4'
                          : entry.key === 'stale'
                            ? 'fill-amber-500'
                            : 'fill-destructive'
                    }
                  />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

interface RolloutCTAProps {
  isAdmin: boolean;
  enforce: string | undefined;
  loading: boolean;
  onNavigate: (path: string) => void;
}

function RolloutCTA({
  isAdmin,
  enforce,
  loading,
  onNavigate,
}: RolloutCTAProps) {
  // Admin-only: only admins can flip modes via the rollout wizard.
  if (!isAdmin) return null;
  // Hide while the mode is still loading to avoid CTA flicker.
  if (loading) return null;
  // Strict mode = governance fully enabled; the rollout wizard is no
  // longer the critical next step. Operators can still navigate via
  // the Tools & views grid below.
  if (enforce === 'strict') return null;

  const isShadow = enforce === 'shadow';
  const title = isShadow
    ? 'Verify shadow soak before strict flip'
    : 'Enable governance enforcement';
  const description = isShadow
    ? "You're in shadow mode. After a clean 7-day soak with mismatch rate < 0.5%, continue to strict mode via the rollout wizard."
    : 'Walk through the rollout readiness checks and flip from permissive \u2192 shadow \u2192 strict. Required before governance starts enforcing fail-closed.';
  const buttonText = isShadow ? 'Open rollout wizard' : 'Start rollout readiness';

  return (
    <Card
      className="border-primary/40 bg-primary/5 mb-8"
      data-testid="governance-rollout-cta"
    >
      <CardHeader>
        <div className="flex items-start gap-4">
          <div className="size-12 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
            <PlayCircle className="size-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <CardDescription className="text-xs uppercase tracking-wider font-semibold text-primary">
              Recommended next step
            </CardDescription>
            <CardTitle className="text-xl mt-1">{title}</CardTitle>
            <p className="text-sm text-muted-foreground mt-2">{description}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Button
          size="lg"
          onClick={() => onNavigate('/governance/rollout')}
          data-testid="governance-rollout-cta-button"
        >
          {buttonText} →
        </Button>
      </CardContent>
    </Card>
  );
}

export function GovernanceOverview() {
  const navigate = useNavigate();
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;
  const { mode, loading: modeLoading } = useGovernanceMode();

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">Governance</h2>
        <p className="text-muted-foreground text-sm">
          Enforcement mode, recent decisions, and registry drift at a glance.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <ModeCard />
        <LedgerPulseCard />
        <ReconcilerCard isAdmin={isAdmin} />
      </div>

      <RolloutCTA
        isAdmin={isAdmin}
        enforce={mode?.enforce}
        loading={modeLoading}
        onNavigate={navigate}
      />

      <div className="mb-3">
        <h3 className="text-foreground text-lg font-semibold">Tools &amp; views</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {NAV_TILES.filter((t) => !t.adminOnly || isAdmin).map((tile) => (
          <NavTile key={tile.id} tile={tile} onNavigate={navigate} />
        ))}
      </div>
    </PageContainer>
  );
}

export default GovernanceOverview;
