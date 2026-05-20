import { useState, useEffect } from 'react';
import { Activity, Cpu, Workflow, Plug } from 'lucide-react';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Banner } from '../components/ui/banner';
import { PageContainer } from '../components/PageContainer';
import { LazyLoadSection } from '../components/LazyLoadSection';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Skeleton } from '../components/ui/skeleton';
import { ChartRow2Skeleton, ChartRow3Skeleton, ChartRow4Skeleton } from '../components/ChartSkeletons';
import ChartRow2 from './dashboard/ChartRow2';
import ChartRow3 from './dashboard/ChartRow3';
import ChartRow4 from './dashboard/ChartRow4';
import { useDashboardData } from '../hooks/useDashboardData';
import { appApiService } from '../services/appApiService';
import { CHART_TOOLTIP_STYLE, CHART_GRID_STROKE, CHART_AXIS_STROKE, CHART_LEGEND_STYLE } from './dashboard/chartStyles';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function computeWeeklyData(dailyActivity: Array<{ date: string; successCount: number; errorCount: number }>) {
  return dailyActivity.map(d => ({
    day: DAY_NAMES[new Date(d.date + 'T00:00:00Z').getUTCDay()],
    Completed: d.successCount,
    Failed: d.errorCount,
  }));
}

function computeGrowthData(agents: any[]) {
  const validAgents = agents.filter(a => a.createdAt);
  if (validAgents.length === 0) return [];

  const now = new Date();
  const months: string[] = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().substring(0, 7));
  }

  return months.map(month => {
    const upToMonth = validAgents.filter(a => a.createdAt.substring(0, 7) <= month);
    const activeUpToMonth = upToMonth.filter(a => a.state === 'active');
    const label = new Date(month + '-01').toLocaleString('default', { month: 'short' });
    return {
      month: label,
      Agents: upToMonth.length,
      Utilization: upToMonth.length > 0 ? Math.round((activeUpToMonth.length / upToMonth.length) * 100) : 0,
    };
  });
}

function MetricCard({ label, value, loading, error, icon, borderClass, iconBgClass, subtitle, delta }: {
  label: string; value: number; loading: boolean; error: string | null;
  icon: React.ReactNode; borderClass: string; iconBgClass: string;
  subtitle: string; delta: number;
}) {
  return (
    <div className={`border ${borderClass} rounded-lg p-5 w-1/4`}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-muted-foreground text-sm mb-1">{label}</p>
          {loading ? <Skeleton className="h-9 w-16" /> : (
            <p className="text-foreground text-3xl font-bold">{error ? '\u2014' : value}</p>
          )}
        </div>
        <div className={`size-10 rounded-lg ${iconBgClass} flex items-center justify-center`}>{icon}</div>
      </div>
      <p className="text-muted-foreground text-xs">{subtitle}</p>
      {loading ? <p className="text-muted-foreground text-xs mt-1">{'\u2014'}</p> : (
        <p className={`text-xs mt-1 ${delta > 0 ? 'text-chart-2' : delta < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
          {delta > 0 ? `\u2191 +${delta} this week` : delta < 0 ? `\u2193 ${delta} this week` : '\u2014 No change'}
        </p>
      )}
    </div>
  );
}

export function Dashboard() {
  const { projects, agents, workflows, integrations, dataStores, counts, loading, error } = useDashboardData();
  const [weeklyData, setWeeklyData] = useState<any[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [dashboardMetrics, setDashboardMetrics] = useState<any>(null);

  useEffect(() => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    appApiService.getDashboardMetrics('default', weekAgo.toISOString(), now.toISOString())
      .then(metrics => {
        setDashboardMetrics(metrics);
        setWeeklyData(computeWeeklyData(metrics?.dailyActivity || []));
      })
      .catch(() => setWeeklyData([]))
      .finally(() => setMetricsLoading(false));
  }, []);

  const growthData = computeGrowthData(agents);

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <Banner />
      <div className="flex-1">
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">Dashboard</h2>
          <p className="text-muted-foreground text-sm">Welcome to your AI Factory. Monitor your agents, workflows, and requests.</p>
        </div>

        <div className="flex gap-4 mb-6 flex-1">
          <MetricCard label="Active Requests" value={counts.activeRequests} loading={loading} error={error}
            icon={<Activity className="size-5 text-primary" />} borderClass="border-border" iconBgClass="bg-primary/20"
            subtitle="Currently processing" delta={counts.deltas.activeRequests} />
          <MetricCard label="Deployed Agents" value={counts.deployedAgents} loading={loading} error={error}
            icon={<Cpu className="size-5 text-emerald-500" />} borderClass="border-chart-2" iconBgClass="bg-chart-2/20"
            subtitle="AI agents available" delta={counts.deltas.deployedAgents} />
          <MetricCard label="Workflows" value={counts.totalWorkflows} loading={loading} error={error}
            icon={<Workflow className="size-5 text-chart-5" />} borderClass="border-border" iconBgClass="bg-chart-5/20"
            subtitle="Automation pipelines" delta={counts.deltas.workflows} />
          <MetricCard label="Integrations" value={counts.connectedIntegrations} loading={loading} error={error}
            icon={<Plug className="size-5 text-primary" />} borderClass="border-border" iconBgClass="bg-chart-4/20"
            subtitle="Connected services" delta={counts.deltas.integrations} />
        </div>

        <div className="flex gap-6">
          <div className="border border-border rounded-lg p-[15px] w-1/2">
            <div className="mb-4">
              <h3 className="text-foreground text-lg font-semibold mb-1">Weekly Request Activity</h3>
              <p className="text-muted-foreground text-sm">Request volume and completion rate over the past week</p>
            </div>
            {metricsLoading ? <Skeleton className="h-[300px] w-full" /> : weeklyData.length === 0 ? (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">No data available</div>
            ) : (
              <ResponsiveContainer width="100%" height={300} style={{padding:"15px"}}>
                <BarChart data={weeklyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                  <XAxis dataKey="day" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                  <YAxis stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="square" />
                  <Bar dataKey="Completed" fill="#00C896" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Failed" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="border border-border rounded-lg p-[15px] w-1/2">
            <div className="mb-4">
              <h3 className="text-foreground text-lg font-semibold mb-1">Agent Growth & Utilization</h3>
              <p className="text-muted-foreground text-sm">Agent count and average utilization over time</p>
            </div>
            {loading ? <Skeleton className="h-[300px] w-full" /> : growthData.length === 0 ? (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground text-sm">No agents yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={growthData}>
                  <defs>
                    <linearGradient id="colorAgents" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6B4DE6" stopOpacity={0.8}/>
                      <stop offset="95%" stopColor="#6B4DE6" stopOpacity={0.1}/>
                    </linearGradient>
                    <linearGradient id="colorUtilization" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.6}/>
                      <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0.05}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                  <XAxis dataKey="month" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                  <YAxis yAxisId="left" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                  <YAxis yAxisId="right" orientation="right" stroke={CHART_AXIS_STROKE} style={{ fontSize: '12px' }} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Legend wrapperStyle={CHART_LEGEND_STYLE} iconType="line" />
                  <Area yAxisId="left" type="monotone" dataKey="Agents" stroke="#6B4DE6" strokeWidth={2} fillOpacity={1} fill="url(#colorAgents)" />
                  <Area yAxisId="right" type="monotone" dataKey="Utilization" stroke="#8B5CF6" strokeWidth={2} fillOpacity={1} fill="url(#colorUtilization)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <ErrorBoundary>
          <LazyLoadSection fallback={<ChartRow2Skeleton />}>
            <ChartRow2 projects={projects} agents={agents} dashboardMetrics={dashboardMetrics} counts={counts} />
          </LazyLoadSection>
        </ErrorBoundary>

        <ErrorBoundary>
          <LazyLoadSection fallback={<ChartRow3Skeleton />}>
            <ChartRow3 projects={projects} dashboardMetrics={dashboardMetrics} />
          </LazyLoadSection>
        </ErrorBoundary>

        <ErrorBoundary>
          <LazyLoadSection fallback={<ChartRow4Skeleton />}>
            <ChartRow4 counts={counts} dataStores={dataStores} />
          </LazyLoadSection>
        </ErrorBoundary>
      </div>
    </PageContainer>
  );
}
