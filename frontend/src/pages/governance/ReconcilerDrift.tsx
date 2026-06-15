/**
 * Governance Reconciler Drift
 *
 * Admin-only page rendering the four classification counts plus a placeholder
 * area chart for upcoming history. Trigger button is rendered but
 * disabled.
 */

import { useEffect, useState } from 'react';
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
import { Card } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import {
  MetricCard,
  type MetricCardAccent,
} from '../../components/governance/MetricCard';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  ReconcilerStatus,
} from '../../services/governanceService';

interface EmptyStateProps {
  message: string;
}

function EmptyState({ message }: EmptyStateProps) {
  return (
    <div
      className="rounded-lg border border-chart-2/40 bg-chart-2/20 p-6 text-sm text-foreground"
      data-testid="reconciler-empty-state"
    >
      {message}
    </div>
  );
}

const CLASSIFICATION_META: Array<{
  key: keyof ReconcilerStatus['classifications'];
  label: string;
  explainer: string;
  accent: MetricCardAccent;
}> = [
  {
    key: 'inSync',
    label: 'In-sync',
    explainer: 'Both sides match on the comparison set.',
    accent: 'success',
  },
  {
    key: 'missing',
    label: 'Missing',
    explainer: 'Registry record exists but no #META row. Reconciler can repair.',
    accent: 'warning',
  },
  {
    key: 'stale',
    label: 'Stale',
    explainer: 'Both sides exist but differ on name/status/orgId/version. Log-only.',
    accent: 'warning',
  },
  {
    key: 'orphan',
    label: 'Orphan',
    explainer: '#META row exists but no Registry record. Log-only.',
    accent: 'destructive',
  },
];

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.abs(diffMs) / 1000;
  if (sec < 60) return diffMs >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const PLACEHOLDER_HISTORY = Array.from({ length: 7 }).map((_, i) => ({
  day: `D-${6 - i}`,
  drift: 0,
}));

export function GovernanceReconcilerDrift() {
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

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
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="Reconciler" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">Reconciler Drift</h2>
        </div>
        <EmptyState message="Admin only — reconciler details require admin access" />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Reconciler" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">Reconciler Drift</h2>
        {loading ? (
          <Skeleton className="h-4 w-64" />
        ) : status?.lastRunAt ? (
          <p className="text-muted-foreground text-sm">
            Last run{' '}
            <span className="font-mono text-foreground">{status.lastRunAt}</span>{' '}
            <span className="text-muted-foreground">({formatRelative(status.lastRunAt)})</span> •{' '}
            Mode: <span className="font-mono text-foreground">{status.lastRunMode ?? 'unknown'}</span>
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            Reconciler has not yet recorded a run
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <div
        className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
        data-testid="reconciler-classification-row"
      >
        {CLASSIFICATION_META.map((meta) => {
          const value = status?.classifications?.[meta.key] ?? 0;
          return (
            <MetricCard
              key={meta.key}
              label={meta.label}
              value={value}
              description={meta.explainer}
              accent={meta.accent}
              loading={loading}
              testId={`reconciler-card-${meta.key}`}
            />
          );
        })}
      </div>

      <Card className="p-5 mb-6">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <h3 className="text-foreground text-lg font-semibold">Drift over time</h3>
            <p className="text-muted-foreground text-xs">Daily drift history not yet available</p>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={PLACEHOLDER_HISTORY}>
            <defs>
              <linearGradient id="drift-placeholder" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" className="text-muted-foreground" stopColor="currentColor" stopOpacity={0.4} />
                <stop offset="95%" className="text-muted-foreground" stopColor="currentColor" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="day" className="text-xs" />
            <YAxis className="text-xs" />
            <RTooltip />
            <Area
              type="monotone"
              dataKey="drift"
              strokeOpacity={0.4}
              fill="url(#drift-placeholder)"
              className="stroke-muted-foreground"
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button disabled variant="outline" data-testid="reconciler-trigger-button">
                Trigger reconciler
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Trigger endpoint not yet available</TooltipContent>
        </Tooltip>
      </div>
    </PageContainer>
  );
}

export default GovernanceReconcilerDrift;
