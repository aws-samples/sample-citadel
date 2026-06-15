/**
 * Governance Constitutional rule tree
 *
 * Read-only admin page that surfaces the constitutional layers evaluated
 * at engine step 8 (see arbiter/governance/engine.py:_constitutional_review).
 * Each rule renders with its operator + the override-fire count over the
 * selected window so operators can spot rules that frequently override
 * permits.
 *
 * Layout:
 *   1. Page header
 *   2. Filter bar (layer-type select + time-range select + refresh)
 *   3. Stats summary line
 *   4. Tree of layers as nested shadcn Accordion items
 *   5. Operator legend (collapsed by default)
 *   6. Empty state
 *
 * will enable inline rule editing on the disabled "Edit"
 * affordance attached to each rule. This page is read-only.
 *
 * The 6 supported operators (eq, neq, exists, not_exists, gt, lt) are the
 * source of truth from `engine.py:_constitutional_review`. Unknown
 * operators degrade gracefully to a muted badge.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion';
import { Badge } from '../../components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import {
  RuleEditorDialog,
  RuleEditorMode,
} from '../../components/RuleEditorDialog';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  ConstitutionalLayer,
  ConstitutionalRule,
  ConstitutionalRuleMutationResult,
  ConstitutionalRuleOverrideStat,
  ConstitutionRuleStatsReport,
} from '../../services/governanceService';

// Tiny inline SVG sparkline below replaces an external sparkline import.
// The constraint forbids new npm dependencies, and recharts' built-in
// Sparkline isn't surfaced as a top-level export — so a hand-rolled
// 60×20 SVG keeps the page rendering without dragging additional
// imports through.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_RANGE_OPTIONS = [
  { value: '24h', label: 'Last 24h', seconds: 24 * 3600 },
  { value: '7d', label: 'Last 7d', seconds: 7 * 86400 },
  { value: '30d', label: 'Last 30d', seconds: 30 * 86400 },
] as const;

const DEFAULT_TIME_RANGE = '7d';

const LAYER_TYPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'global', label: 'Global' },
  { value: 'domain', label: 'Domain' },
  { value: 'pairwise', label: 'Pairwise' },
] as const;

const APPLIES_TO_TRUNCATE = 5;

// Tailwind tokens for layer-type badges. Source of truth: chart-2 / chart-4 /
// chart-5 per the spec; fallback muted for unknown types.
const LAYER_TYPE_BADGE_CLASS: Record<string, string> = {
  pairwise: 'bg-chart-2/10 text-chart-2 border-chart-2/30',
  domain: 'bg-chart-4/10 text-chart-4 border-chart-4/30',
  global: 'bg-chart-5/10 text-chart-5 border-chart-5/30',
};

// Distinct colours for the 6 known operators. Unknown operators degrade
// to the muted token. All values are Tailwind chart-/destructive tokens —
// no inline colour literals.
const OPERATOR_BADGE_CLASS: Record<string, string> = {
  eq: 'bg-chart-1/10 text-chart-1 border-chart-1/30',
  neq: 'bg-destructive/10 text-destructive border-destructive/30',
  exists: 'bg-chart-2/10 text-chart-2 border-chart-2/30',
  not_exists: 'bg-chart-3/10 text-chart-3 border-chart-3/30',
  gt: 'bg-chart-4/10 text-chart-4 border-chart-4/30',
  lt: 'bg-chart-5/10 text-chart-5 border-chart-5/30',
};

const KNOWN_OPERATORS: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'exists',
  'not_exists',
  'gt',
  'lt',
]);

// One-line descriptions matching the engine docstrings.
const OPERATOR_LEGEND: Array<{ op: string; description: string }> = [
  { op: 'eq', description: 'actual == expected' },
  { op: 'neq', description: 'actual != expected' },
  { op: 'exists', description: 'actual is not None' },
  { op: 'not_exists', description: 'actual is None' },
  { op: 'gt', description: 'actual is not None and actual > expected' },
  { op: 'lt', description: 'actual is not None and actual < expected' },
];

const SPARKLINE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function layerTypeBadgeClass(layerType: string): string {
  return (
    LAYER_TYPE_BADGE_CLASS[layerType] ?? 'bg-muted text-muted-foreground border-muted-foreground/30'
  );
}

function operatorBadgeClass(operator: string): string {
  return (
    OPERATOR_BADGE_CLASS[operator] ?? 'bg-muted text-muted-foreground border-muted-foreground/30'
  );
}

function isExistsOperator(op: string): boolean {
  return op === 'exists' || op === 'not_exists';
}

function fireKey(layerId: string, field: string): string {
  return `${layerId}|${field}`;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return 'never';
  return new Date(ts * 1000).toISOString();
}

/**
 * Tiny inline SVG sparkline. Renders a 7-segment line whose amplitude
 * scales with the count — purely cosmetic but signals "high activity"
 * vs. "low activity" at a glance. Replace with a Recharts series when
 * backend ships per-day buckets.
 */
function CountSparkline({ count }: { count: number }) {
  // Build a deterministic synthetic series from the count so two rules
  // with the same count render identical sparklines (no jitter between
  // re-renders). The series sums to `count` and decays from the most
  // recent bucket.
  const buckets = 7;
  const series: number[] = [];
  let remaining = count;
  for (let i = 0; i < buckets; i++) {
    const bias = buckets - i;
    const v = Math.max(0, Math.round((remaining * bias) / ((buckets * (buckets + 1)) / 2)));
    series.push(v);
    remaining = Math.max(0, remaining - v);
  }
  // Re-distribute any leftover into the most recent bucket so totals
  // are exact.
  if (remaining > 0) series[0] += remaining;

  const max = Math.max(...series, 1);
  const pts = series
    .map((v, i) => `${(i / (series.length - 1)) * 60},${20 - (v / max) * 18}`)
    .join(' ');
  return (
    <svg
      width="60"
      height="20"
      data-testid="rule-sparkline"
      data-count={count}
      role="img"
      aria-label={`Override fires sparkline (count ${count})`}
    >
      <polyline
        points={pts}
        className="stroke-chart-1 fill-none"
        strokeWidth="1.5"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface AppliesToBadgesProps {
  appliesTo: string[];
}

function AppliesToBadges({ appliesTo }: AppliesToBadgesProps) {
  if (appliesTo.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">No targets</span>
    );
  }
  const visible = appliesTo.slice(0, APPLIES_TO_TRUNCATE);
  const more = appliesTo.length - visible.length;
  return (
    <span className="flex flex-wrap gap-1" data-testid="applies-to-list">
      {visible.map((target) => (
        <Badge
          key={target}
          variant="outline"
          className="font-mono text-xs"
          data-testid={`applies-to-${target}`}
        >
          {target}
        </Badge>
      ))}
      {more > 0 && (
        <Badge
          variant="outline"
          className="font-mono text-xs"
          data-testid="applies-to-more"
        >
          {`+${more} more`}
        </Badge>
      )}
    </span>
  );
}

interface RuleRowProps {
  layerId: string;
  rule: ConstitutionalRule;
  ruleIndex: number;
  stat: ConstitutionalRuleOverrideStat | null;
  onEdit: (ruleIndex: number, rule: ConstitutionalRule) => void;
  onDelete: (ruleIndex: number, rule: ConstitutionalRule) => void;
}

function RuleRow({
  layerId,
  rule,
  ruleIndex,
  stat,
  onEdit,
  onDelete,
}: RuleRowProps) {
  const operator = rule.operator;
  const knownOp = KNOWN_OPERATORS.has(operator);
  const showValue = !isExistsOperator(operator);
  const count = stat?.count7d ?? 0;
  const showSparkline = count > SPARKLINE_THRESHOLD;

  return (
    <li
      className="flex items-center gap-3 py-2 border-b border-border/30 last:border-b-0"
      data-testid={`rule-row-${layerId}-${rule.field}`}
      data-rule-field={rule.field}
      data-rule-operator={operator}
      data-rule-index={ruleIndex}
    >
      <span
        className="font-mono text-sm text-foreground min-w-[120px]"
        data-testid="rule-field"
      >
        {rule.field}
      </span>
      <Badge
        variant="outline"
        className={`font-mono text-xs ${operatorBadgeClass(operator)}`}
        data-testid="rule-operator-badge"
        data-known-operator={knownOp ? 'true' : 'false'}
      >
        {operator}
      </Badge>
      {showValue && rule.value !== null && (
        <code
          className="font-mono text-xs text-muted-foreground bg-muted/40 rounded px-1 py-0.5"
          data-testid="rule-value"
        >
          {rule.value}
        </code>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs hover:bg-transparent"
            data-testid={`rule-fires-trigger-${layerId}-${rule.field}`}
            data-fires-count={count}
          >
            {showSparkline ? (
              <CountSparkline count={count} />
            ) : (
              <Badge
                variant="outline"
                className="font-mono text-xs"
                data-testid="rule-fires-chip"
              >
                {`${count} fires`}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-72 text-xs"
          data-testid={`rule-fires-popover-${layerId}-${rule.field}`}
        >
          <div className="flex flex-col gap-2">
            <p className="text-foreground font-semibold">Override fires</p>
            <p className="text-muted-foreground">
              {`${count} fires in window`}
            </p>
            <div>
              <p className="text-muted-foreground">Last fired:</p>
              <p
                className="font-mono text-foreground"
                data-testid="rule-fires-last"
              >
                {formatTimestamp(stat?.lastFiredAt ?? null)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Top affected agents:</p>
              {stat && stat.topAffectedAgents.length > 0 ? (
                <ul
                  className="font-mono text-foreground"
                  data-testid="rule-fires-top-agents"
                >
                  {stat.topAffectedAgents.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground italic">none</p>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onEdit(ruleIndex, rule)}
        data-testid={`rule-edit-${layerId}-${rule.field}`}
      >
        Edit
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDelete(ruleIndex, rule)}
            className="text-destructive border-destructive/40 hover:bg-destructive/10"
            data-testid={`rule-delete-${layerId}-${rule.field}`}
            aria-label={`Delete rule ${rule.field}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent data-testid="rule-delete-tooltip">
          Delete this rule
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

interface LayerCardProps {
  layer: ConstitutionalLayer;
  statsByKey: Map<string, ConstitutionalRuleOverrideStat>;
  onEditRule: (
    layerId: string,
    ruleIndex: number,
    rule: ConstitutionalRule,
  ) => void;
  onDeleteRule: (
    layerId: string,
    ruleIndex: number,
    rule: ConstitutionalRule,
  ) => void;
  onAddRule: (layerId: string) => void;
}

function LayerCard({
  layer,
  statsByKey,
  onEditRule,
  onDeleteRule,
  onAddRule,
}: LayerCardProps) {
  // Sort rules by override-count desc within the layer so the noisiest
  // rules surface first. Preserve the original index from the underlying
  // array so add/update/delete write back to the right slot.
  const sortedRules = useMemo(() => {
    const withCount = layer.rules.map((rule, idx) => ({
      rule,
      ruleIndex: idx,
      count: statsByKey.get(fireKey(layer.layerId, rule.field))?.count7d ?? 0,
    }));
    withCount.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.rule.field.localeCompare(b.rule.field);
    });
    return withCount;
  }, [layer.layerId, layer.rules, statsByKey]);

  return (
    <AccordionItem
      value={layer.layerId}
      data-testid={`layer-item-${layer.layerId}`}
      data-layer-type={layer.layerType}
    >
      <AccordionTrigger
        className="hover:no-underline"
        data-testid={`layer-trigger-${layer.layerId}`}
      >
        <div className="flex flex-1 items-center gap-3">
          <span
            className="font-mono text-sm text-foreground"
            data-testid={`layer-id-${layer.layerId}`}
          >
            {layer.layerId}
          </span>
          <Badge
            variant="outline"
            className={`font-mono text-xs ${layerTypeBadgeClass(layer.layerType)}`}
            data-testid={`layer-type-badge-${layer.layerId}`}
          >
            {layer.layerType}
          </Badge>
          <AppliesToBadges appliesTo={layer.appliesTo} />
        </div>
      </AccordionTrigger>
      <AccordionContent>
        {sortedRules.length === 0 ? (
          <p
            className="text-muted-foreground text-xs px-2 py-2"
            data-testid={`layer-no-rules-${layer.layerId}`}
          >
            No rules in this layer.
          </p>
        ) : (
          <ul className="px-2" data-testid={`layer-rules-${layer.layerId}`}>
            {sortedRules.map(({ rule, ruleIndex }) => (
              <RuleRow
                key={`${layer.layerId}-${rule.field}-${ruleIndex}`}
                layerId={layer.layerId}
                rule={rule}
                ruleIndex={ruleIndex}
                stat={
                  statsByKey.get(fireKey(layer.layerId, rule.field)) ?? null
                }
                onEdit={(idx, r) => onEditRule(layer.layerId, idx, r)}
                onDelete={(idx, r) => onDeleteRule(layer.layerId, idx, r)}
              />
            ))}
          </ul>
        )}
        <div className="px-2 pt-2 pb-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAddRule(layer.layerId)}
            data-testid={`layer-add-rule-${layer.layerId}`}
          >
            Add rule
          </Button>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function OperatorLegend() {
  return (
    <Card className="p-3 mt-4 gap-0">
      <details data-testid="operator-legend">
        <summary
          className="text-foreground text-sm font-semibold cursor-pointer"
          data-testid="operator-legend-summary"
        >
          Operator legend
        </summary>
        <table className="mt-2 w-full text-xs">
          <tbody>
            {OPERATOR_LEGEND.map((entry) => (
              <tr key={entry.op} className="border-b border-border/30 last:border-b-0">
                <td className="py-1 pr-4 align-top">
                  <Badge
                    variant="outline"
                    className={`font-mono text-xs ${operatorBadgeClass(entry.op)}`}
                    data-testid={`legend-badge-${entry.op}`}
                  >
                    {entry.op}
                  </Badge>
                </td>
                <td
                  className="py-1 font-mono text-muted-foreground"
                  data-testid={`legend-description-${entry.op}`}
                >
                  {entry.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );
}

export function GovernanceConstitution() {
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [layers, setLayers] = useState<ConstitutionalLayer[]>([]);
  const [stats, setStats] = useState<ConstitutionRuleStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layerType, setLayerType] = useState<string>('all');
  const [timeRange, setTimeRange] = useState<string>(DEFAULT_TIME_RANGE);
  const [refreshKey, setRefreshKey] = useState(0);

  // rule editor dialog state. `null` when closed.
  interface RuleEditorState {
    mode: RuleEditorMode;
    layer: ConstitutionalLayer;
    ruleIndex?: number;
    existingRule?: ConstitutionalRule;
  }
  const [editorState, setEditorState] = useState<RuleEditorState | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    const range = TIME_RANGE_OPTIONS.find((r) => r.value === timeRange);
    const untilTs = Math.floor(Date.now() / 1000);
    const sinceTs = untilTs - (range?.seconds ?? 7 * 86400);

    Promise.all([
      governanceService.listConstitutionalLayers(),
      governanceService.getConstitutionalRuleStats({ sinceTs, untilTs }),
    ])
      .then(([layersResp, statsResp]) => {
        if (!mounted) return;
        setLayers(layersResp);
        setStats(statsResp);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load constitution';
        setError(msg);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin, timeRange, refreshKey]);

  // Memoised lookup of stats by `(layerId, field)`. Re-computed only when
  // the stats payload changes, so the per-layer card mappings are
  // O(rules_in_layer) on every accordion toggle rather than O(stats).
  const statsByKey = useMemo(() => {
    const map = new Map<string, ConstitutionalRuleOverrideStat>();
    if (stats) {
      for (const stat of stats.stats) {
        map.set(fireKey(stat.layerId, stat.field), stat);
      }
    }
    return map;
  }, [stats]);

  const visibleLayers = useMemo(() => {
    if (layerType === 'all') return layers;
    return layers.filter((l) => l.layerType === layerType);
  }, [layers, layerType]);

  const totalRules = useMemo(
    () => layers.reduce((sum, l) => sum + l.rules.length, 0),
    [layers],
  );
  const overrideFires = stats?.totalOverrides ?? 0;

  if (!isAdmin) {
    return (
      <PageContainer
        className="flex-1 flex flex-col bg-background"
        data-testid="governance-constitution"
      >
        <GovernanceBreadcrumbs title="Constitution" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Constitutional layers
          </h2>
        </div>
        <p
          className="text-muted-foreground text-sm"
          data-testid="constitution-admin-only"
        >
          Admin-only.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      className="flex-1 flex flex-col bg-background"
      data-testid="governance-constitution"
    >
      <GovernanceBreadcrumbs title="Constitution" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Constitutional layers
        </h2>
        <p className="text-muted-foreground text-sm">
          The conjunctive rule sets evaluated at engine step 8. Each rule
          renders with its operator and override-count over the last 7 days.
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4" data-testid="filter-bar">
        <label className="text-xs text-muted-foreground">Layer type</label>
        <Select value={layerType} onValueChange={setLayerType}>
          <SelectTrigger
            className="w-32"
            data-testid="layer-type-select-trigger"
          >
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            {LAYER_TYPE_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                data-testid={`layer-type-option-${opt.value}`}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="text-xs text-muted-foreground ml-3">
          Time range
        </label>
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger
            className="w-36"
            data-testid="time-range-select-trigger"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_RANGE_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                data-testid={`time-range-option-${opt.value}`}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRefreshKey((k) => k + 1)}
          data-testid="constitution-refresh"
        >
          Refresh
        </Button>
      </div>

      {/* Stats summary */}
      <p
        className="text-muted-foreground text-xs mb-3"
        data-testid="stats-summary"
      >
        {`${visibleLayers.length} layers • ${totalRules} rules • ${overrideFires} override-fires in window`}
      </p>

      {/* Body */}
      {loading ? (
        <Skeleton
          className="h-40 w-full"
          data-testid="constitution-skeleton"
        />
      ) : error ? (
        <p className="text-destructive text-sm" data-testid="constitution-error">
          {error}
        </p>
      ) : visibleLayers.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="constitution-empty"
        >
          No constitutional layers configured.
        </p>
      ) : (
        <Card className="p-0 gap-0" data-testid="layer-accordion-card">
        <Accordion
          type="multiple"
          data-testid="layer-accordion"
        >
          {visibleLayers.map((layer) => (
            <LayerCard
              key={layer.layerId}
              layer={layer}
              statsByKey={statsByKey}
              onEditRule={(layerId, ruleIndex, rule) => {
                const target = layers.find((l) => l.layerId === layerId);
                if (!target) return;
                setEditorState({
                  mode: 'update',
                  layer: target,
                  ruleIndex,
                  existingRule: rule,
                });
              }}
              onDeleteRule={(layerId, ruleIndex, rule) => {
                const target = layers.find((l) => l.layerId === layerId);
                if (!target) return;
                setEditorState({
                  mode: 'delete',
                  layer: target,
                  ruleIndex,
                  existingRule: rule,
                });
              }}
              onAddRule={(layerId) => {
                const target = layers.find((l) => l.layerId === layerId);
                if (!target) return;
                setEditorState({ mode: 'add', layer: target });
              }}
            />
          ))}
        </Accordion>
        </Card>
      )}

      {/* Operator legend (collapsed by default) */}
      <OperatorLegend />

      {editorState && (
        <RuleEditorDialog
          open={editorState !== null}
          onOpenChange={(open) => {
            if (!open) setEditorState(null);
          }}
          mode={editorState.mode}
          layer={editorState.layer}
          ruleIndex={editorState.ruleIndex}
          existingRule={editorState.existingRule}
          onCommitted={(result: ConstitutionalRuleMutationResult) => {
            const action = result.action;
            const verb =
              action === 'add'
                ? 'added'
                : action === 'update'
                  ? 'updated'
                  : 'deleted';
            toast.success(`Rule ${verb} on ${result.layerId}`);
            // Trigger a re-fetch of layers + stats so the page reflects
            // the new rule list and the stats window catches up.
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </PageContainer>
  );
}

export default GovernanceConstitution;
