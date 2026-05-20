/**
 * Dashboard Chart Row 3: Monthly Request Volume, Pipeline Stage Performance
 * Lazy-loaded — rendered when scrolled into view.
 */
import { Activity } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../../components/ui/chart';
import {
  CHART_GRID_STROKE, CHART_AXIS_STROKE, CHART_LEGEND_STYLE, cssVar,
} from './chartStyles';

const PHASE_MAP: Record<string, string> = {
  assessment: 'Assess', design: 'Plan', planning: 'Plan',
  implementation: 'Implement', iteration: 'Iterate',
};

function computePipelineData(projects: any[]) {
  const stages: Record<string, number> = { Assess: 0, Plan: 0, Implement: 0, Iterate: 0 };
  for (const p of projects) {
    const phase = p.progress?.currentPhase?.toLowerCase() || '';
    const stage = PHASE_MAP[phase] || 'Assess';
    stages[stage]++;
  }
  return Object.entries(stages).map(([stage, requestCount]) => ({ stage, requestCount, avgTime: requestCount * 15 }));
}

function computeMonthlyVolume(dailyActivity: Array<{ date: string; successCount: number; errorCount: number }>) {
  const months: Record<string, number> = {};
  for (const d of dailyActivity) {
    const month = d.date.substring(0, 7);
    months[month] = (months[month] || 0) + d.successCount + d.errorCount;
  }
  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, requests]) => ({
      month: new Date(month + '-01').toLocaleString('default', { month: 'short' }),
      requests,
    }));
}

const volumeChartConfig: ChartConfig = {
  requests: { label: 'Monthly Requests', color: 'var(--chart-3)' },
};

const pipelineChartConfig: ChartConfig = {
  avgTime: { label: 'Avg Time (min)', color: 'var(--chart-4)' },
  requestCount: { label: 'Request Count', color: 'var(--chart-2)' },
};

interface ChartRow3Props {
  projects: any[];
  dashboardMetrics: any;
}

export default function ChartRow3({ projects, dashboardMetrics }: ChartRow3Props) {
  const pipelineData = computePipelineData(projects);
  const monthlyData = computeMonthlyVolume(dashboardMetrics?.dailyActivity || []);
  const currentMonth = monthlyData.length > 0 ? monthlyData[monthlyData.length - 1].requests : 0;
  const prevMonth = monthlyData.length > 1 ? monthlyData[monthlyData.length - 2].requests : 0;
  const pctChange = prevMonth > 0 ? (((currentMonth - prevMonth) / prevMonth) * 100).toFixed(1) : '0.0';
  const avgMonthly = monthlyData.length > 0 ? Math.round(monthlyData.reduce((s, m) => s + m.requests, 0) / monthlyData.length) : 0;

  return (
    <div className="flex gap-6 mt-5" data-testid="chart-row-3">
      <Card className="w-1/2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5" />
            Monthly Request Volume
          </CardTitle>
          <CardDescription>Total API requests across all published apps</CardDescription>
        </CardHeader>
        <CardContent>
          {monthlyData.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">No data available</div>
          ) : (
            <ChartContainer config={volumeChartConfig} className="h-[300px] w-full">
              <LineChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                <XAxis dataKey="month" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                <YAxis stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend wrapperStyle={CHART_LEGEND_STYLE} formatter={() => 'Monthly Requests'} />
                <Line type="monotone" dataKey="requests" stroke={cssVar('--chart-3')} strokeWidth={2} dot={{ fill: cssVar('--chart-3'), r: 4 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ChartContainer>
          )}
          <div className="flex gap-3 mt-4">
            <div className="flex-1 rounded-lg p-2 text-center bg-accent">
              <p className="text-foreground text-2xl font-bold mb-1">{currentMonth.toLocaleString()}</p>
              <p className="text-muted-foreground text-xs">Current Month</p>
            </div>
            <div className="flex-1 rounded-lg p-2 text-center bg-accent">
              <p className={`text-2xl font-bold mb-1 ${Number(pctChange) >= 0 ? 'text-chart-1' : 'text-destructive'}`}>{Number(pctChange) >= 0 ? '+' : ''}{pctChange}%</p>
              <p className="text-muted-foreground text-xs">vs Last Month</p>
            </div>
            <div className="flex-1 rounded-lg p-2 text-center bg-accent">
              <p className="text-foreground text-2xl font-bold mb-1">{avgMonthly.toLocaleString()}</p>
              <p className="text-muted-foreground text-xs">Avg Monthly</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="w-1/2">
        <CardHeader>
          <CardTitle>Pipeline Stage Performance</CardTitle>
          <CardDescription>Average processing time and volume by stage</CardDescription>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">No projects</div>
          ) : (
            <ChartContainer config={pipelineChartConfig} className="h-[300px] w-full">
              <BarChart data={pipelineData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                <XAxis dataKey="stage" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                <YAxis yAxisId="left" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} label={{ value: 'Avg Time (min)', angle: -90, position: 'insideLeft', style: { fill: CHART_AXIS_STROKE, fontSize: '12px' } }} />
                <YAxis yAxisId="right" orientation="right" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} label={{ value: 'Request Count', angle: 90, position: 'insideRight', style: { fill: CHART_AXIS_STROKE, fontSize: '12px' } }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="square" />
                <Bar yAxisId="left" dataKey="avgTime" fill={cssVar('--chart-4')} radius={[4, 4, 0, 0]} name="Avg Time (min)" />
                <Bar yAxisId="right" dataKey="requestCount" fill={cssVar('--chart-2')} radius={[4, 4, 0, 0]} name="Request Count" />
              </BarChart>
            </ChartContainer>
          )}
          <div className="mt-4 rounded-lg p-2 text-center bg-accent">
            <p className="text-foreground text-2xl font-bold mb-1">{pipelineData.reduce((s, d) => s + d.avgTime, 0)} minutes avg</p>
            <p className="text-muted-foreground text-xs">Total Pipeline Time</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
