/**
 * CostOverTimeChart
 *
 * Renders a `/cost/series` response as an AreaChart (cost per time
 * bucket). Honest states: EstimateBadge is always shown alongside real
 * data (every series row is `estimate:true`), UnpricedChip shows the
 * unpriced-call count, and an explicit empty state renders when there are
 * no points rather than a misleadingly flat/zero chart. Loading uses a
 * Skeleton matched to the chart's rendered height to avoid layout shift.
 */
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { EstimateBadge } from './EstimateBadge';
import { UnpricedChip } from './UnpricedChip';
import type { CostSeriesResponse } from '../../services/costService';
import { CHART_GRID_STROKE, CHART_AXIS_STROKE, CHART_TOOLTIP_STYLE, cssVar } from '../../pages/dashboard/chartStyles';

export interface CostOverTimeChartProps {
  title?: string;
  description?: string;
  data: CostSeriesResponse | null;
  loading: boolean;
}

/** costMicros → display dollars, 6 decimal-place micros → 2dp currency string. Never fabricates a currency symbol when currency is unknown. */
function formatCost(costMicros: number, currency: string | null): string {
  const amount = (costMicros / 1_000_000).toFixed(2);
  return currency ? `${amount} ${currency}` : amount;
}

export function CostOverTimeChart({
  title = 'Cost Over Time',
  description = 'Estimated spend per day across the organization',
  data,
  loading,
}: CostOverTimeChartProps) {
  const points = data?.points ?? [];
  const chartData = points.map((p) => ({
    t: p.t,
    cost: p.costMicros / 1_000_000,
  }));

  return (
    <Card className="rounded-lg p-[15px] gap-0" data-testid="cost-over-time-chart">
      <CardHeader className="p-0 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg font-semibold">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {data && (
            <div className="flex items-center gap-2">
              <EstimateBadge show={points.length > 0} />
              <UnpricedChip count={data.unpricedCount} />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : chartData.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">
            No cost data available for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={cssVar('--chart-1')} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={cssVar('--chart-1')} stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="t" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
              <YAxis stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value: number) => formatCost(value * 1_000_000, data?.currency ?? null)}
              />
              <Area type="monotone" dataKey="cost" stroke={cssVar('--chart-1')} strokeWidth={2} fillOpacity={1} fill="url(#colorCost)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export default CostOverTimeChart;
