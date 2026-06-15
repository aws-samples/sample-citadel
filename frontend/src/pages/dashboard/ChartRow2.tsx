/**
 * Dashboard Chart Row 2: Request Status, Agent Types, System Performance
 * Lazy-loaded — rendered when scrolled into view.
 */
import {
  PieChart, Pie, Cell, RadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Radar,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../../components/ui/chart';
import {
  STATUS_COLORS, AGENT_COLORS, CHART_GRID_STROKE, CHART_AXIS_STROKE, cssVar,
} from './chartStyles';

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Completed', IN_PROGRESS: 'In Progress', CREATED: 'Planning',
  ERROR: 'Failed', ASSESSMENT_COMPLETE: 'In Progress', DESIGN_COMPLETE: 'In Progress',
  PLANNING_COMPLETE: 'In Progress', IMPLEMENTATION_READY: 'In Progress',
};

function computeStatusData(projects: any[]) {
  const groups: Record<string, number> = {};
  for (const p of projects) {
    const label = STATUS_LABELS[p.status] || p.status;
    groups[label] = (groups[label] || 0) + 1;
  }
  const total = projects.length || 1;
  return Object.entries(groups).map(([name, value]) => ({ name, value, percentage: Math.round((value / total) * 100) }));
}

function computeAgentTypesData(agents: any[]) {
  const groups: Record<string, number> = {};
  for (const a of agents) {
    const cat = a.categories?.[0] || 'Uncategorized';
    groups[cat] = (groups[cat] || 0) + 1;
  }
  return Object.entries(groups).map(([name, value]) => ({ name, value }));
}

function clamp(v: number) { return Math.max(0, Math.min(100, Math.round(v))); }

function computePerformanceData(counts: any, metrics: any) {
  const uptime = counts.totalDataStores > 0 ? (counts.connectedDataStores / counts.totalDataStores) * 100 : 0;
  const latency = metrics?.avgLatency ?? 2000;
  const responseTime = latency < 100 ? 100 : Math.max(0, 100 - ((latency - 100) / 19));
  const successRate = metrics?.successRate ?? 0;
  const resourceUtil = (counts.deployedAgents + counts.totalWorkflows) > 0
    ? (counts.deployedAgents / (counts.deployedAgents + (counts.totalWorkflows - counts.deployedAgents || 1))) * 100 : 0;
  const totalInt = counts.connectedIntegrations + (counts.totalDataStores - counts.connectedDataStores);
  const securityScore = totalInt > 0 ? (counts.connectedIntegrations / (totalInt || 1)) * 100 : 0;
  return [
    { metric: 'Uptime', value: clamp(uptime) },
    { metric: 'Response Time', value: clamp(responseTime) },
    { metric: 'Success Rate', value: clamp(successRate) },
    { metric: 'Resource Util', value: clamp(resourceUtil) },
    { metric: 'Security Score', value: clamp(securityScore) },
  ];
}

const statusChartConfig: ChartConfig = {
  value: { label: 'Count' },
};

const agentChartConfig: ChartConfig = {
  value: { label: 'Count' },
};

const perfChartConfig: ChartConfig = {
  value: { label: 'Performance', color: 'var(--chart-1)' },
};

interface ChartRow2Props {
  projects: any[];
  agents: any[];
  dashboardMetrics: any;
  counts: any;
}

export default function ChartRow2({ projects, agents, dashboardMetrics, counts }: ChartRow2Props) {
  const statusData = computeStatusData(projects);
  const agentTypesData = computeAgentTypesData(agents);
  const perfData = computePerformanceData(counts, dashboardMetrics);
  const overallHealth = perfData.reduce((s, d) => s + d.value, 0) / perfData.length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-5" data-testid="chart-row-2">
      <Card>
        <CardHeader>
          <CardTitle>Request Status</CardTitle>
          <CardDescription>Current status breakdown</CardDescription>
        </CardHeader>
        <CardContent>
          {statusData.length === 0 ? (
            <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">No projects</div>
          ) : (
            <>
              <ChartContainer config={statusChartConfig} className="h-[280px] w-full">
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={2} dataKey="value">
                    {statusData.map((_e, i) => <Cell key={i} fill={STATUS_COLORS[i % STATUS_COLORS.length]} />)}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ChartContainer>
              <div className="mt-4 flex flex-col gap-2">
                {statusData.map((item, i) => (
                  <div key={item.name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      {/* Inline style required: dynamic chart legend color from token array */}
                      <div className="size-3 rounded-full" style={{ backgroundColor: STATUS_COLORS[i % STATUS_COLORS.length] }} />
                      <span className="text-foreground">{item.name}</span>
                    </div>
                    <span className="text-muted-foreground">{item.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Types</CardTitle>
          <CardDescription>Distribution by agent category</CardDescription>
        </CardHeader>
        <CardContent>
          {agentTypesData.length === 0 ? (
            <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">No agents</div>
          ) : (
            <>
              <ChartContainer config={agentChartConfig} className="h-[280px] w-full">
                <PieChart>
                  <Pie data={agentTypesData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={2} dataKey="value" label={(e) => e.value} labelLine={false}>
                    {agentTypesData.map((_e, i) => <Cell key={i} fill={AGENT_COLORS[i % AGENT_COLORS.length]} />)}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ChartContainer>
              <div className="mt-4 flex flex-col gap-2">
                {agentTypesData.map((item, i) => (
                  <div key={item.name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      {/* Inline style required: dynamic chart legend color from token array */}
                      <div className="size-3 rounded-full" style={{ backgroundColor: AGENT_COLORS[i % AGENT_COLORS.length] }} />
                      <span className="text-foreground">{item.name}</span>
                    </div>
                    <span className="text-muted-foreground">{item.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System Performance</CardTitle>
          <CardDescription>Multi-dimensional health metrics</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={perfChartConfig} className="h-[280px] w-full">
            <RadarChart data={perfData}>
              <PolarGrid stroke={CHART_GRID_STROKE} />
              <PolarAngleAxis dataKey="metric" tick={{ fill: CHART_AXIS_STROKE, fontSize: 11 }} />
              <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fill: CHART_AXIS_STROKE, fontSize: 10 }} stroke={CHART_GRID_STROKE} />
              <Radar name="Performance" dataKey="value" stroke={cssVar('--chart-1')} fill={cssVar('--chart-1')} fillOpacity={0.6} />
              <ChartTooltip content={<ChartTooltipContent />} />
            </RadarChart>
          </ChartContainer>
          <div className="mt-4 text-center">
            <p className="text-foreground text-3xl font-bold">{Math.round(overallHealth)}%</p>
            <p className="text-muted-foreground text-sm">Overall Health Score</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
