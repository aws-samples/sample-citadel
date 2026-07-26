/**
 * CostByDimensionChart
 *
 * Renders a `/cost/summary` response as a BarChart, one bar per dimension
 * bucket (app/agent/model/project). Honest states: EstimateBadge shown
 * alongside real data, UnpricedChip shows the unpriced-row count, empty
 * state when there are no buckets, and a currency-mixed warning when the
 * org's rows span more than one currency (costs cannot be meaningfully
 * summed across currencies — see cost-query-handler.ts's `currencyMixed`).
 */
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { EstimateBadge } from './EstimateBadge';
import { UnpricedChip } from './UnpricedChip';
import type { CostSummaryResponse } from '../../services/costService';
import { CHART_GRID_STROKE, CHART_AXIS_STROKE, CHART_TOOLTIP_STYLE, cssVar } from '../../pages/dashboard/chartStyles';

export interface CostByDimensionChartProps {
  title?: string;
  description?: string;
  data: CostSummaryResponse | null;
  loading: boolean;
}

function formatCost(costMicros: number, currency: string | null): string {
  const amount = (costMicros / 1_000_000).toFixed(2);
  return currency ? `${amount} ${currency}` : amount;
}

export function CostByDimensionChart({
  title = 'Cost by Dimension',
  description = 'Estimated spend grouped by dimension',
  data,
  loading,
}: CostByDimensionChartProps) {
  const buckets = data?.buckets ?? [];
  const chartData = buckets.map((b) => ({
    label: b.label,
    cost: b.costMicros / 1_000_000,
  }));

  return (
    <Card className="rounded-lg p-[15px] gap-0" data-testid="cost-by-dimension-chart">
      <CardHeader className="p-0 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg font-semibold">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {data && (
            <div className="flex items-center gap-2">
              <EstimateBadge show={buckets.length > 0} />
              <UnpricedChip count={data.unpricedRows} />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {data?.currencyMixed && (
          <div className="text-xs text-chart-4 mb-2">
            Spend spans multiple currencies — totals are shown per-currency, not summed.
          </div>
        )}
        {loading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : chartData.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">
            No cost data available for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="label" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
              <YAxis stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value: number) => formatCost(value * 1_000_000, data?.currency ?? null)}
              />
              <Bar dataKey="cost" fill={cssVar('--chart-2')} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export default CostByDimensionChart;
