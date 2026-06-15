/**
 * Dashboard Chart Row 4: System Health, Recent Activity, Quick Actions
 * Lazy-loaded — rendered when scrolled into view.
 */
import { useState, useEffect } from 'react';
import {
  Activity, Cpu, Workflow, Plug, Zap, Clock, CheckCircle,
  Plus, Users, BarChart3,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { appApiService } from '../../services/appApiService';
import { Skeleton } from '../../components/ui/skeleton';
import { Button } from '../../components/ui/button';

interface ChartRow4Props {
  counts: any;
  dataStores: any[];
}

const ENTITY_COLORS: Record<string, string> = {
  project: 'bg-chart-1', agent: 'bg-chart-2', workflow: 'bg-chart-4', integration: 'bg-chart-3',
};
const ENTITY_TAGS: Record<string, string> = {
  project: 'request', agent: 'agent', workflow: 'workflow', integration: 'integration',
};

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function healthPct(connected: number, total: number) {
  return total > 0 ? Math.round((connected / total) * 100) : 0;
}

function badgeLabel(score: number) {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Degraded';
  return 'Critical';
}

export default function ChartRow4({ counts, dataStores: _dataStores }: ChartRow4Props) {
  const [activity, setActivity] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  useEffect(() => {
    appApiService.getRecentActivity('default', 5)
      .then(r => setActivity(r?.items || []))
      .catch(() => setActivity([]))
      .finally(() => setActivityLoading(false));
  }, []);

  const agentsHealth = healthPct(counts.deployedAgents, counts.deployedAgents + (counts.totalWorkflows > 0 ? 1 : 0) || 1);
  const workflowsHealth = counts.totalWorkflows > 0 ? 100 : 0;
  const integrationsHealth = healthPct(counts.connectedIntegrations, counts.connectedIntegrations + 1);
  const infraHealth = healthPct(counts.connectedDataStores, counts.totalDataStores);
  const overall = Math.round(agentsHealth * 0.3 + workflowsHealth * 0.25 + integrationsHealth * 0.25 + infraHealth * 0.2);
  const securityOk = integrationsHealth >= 95;

  return (
    <div data-testid="chart-row-4">
      <div className="flex gap-6 mt-5">
        <Card className="w-1/2 bg-accent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="size-5" />
              System Health
            </CardTitle>
            <CardDescription>Real-time status of your AI factory components</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <HealthBar label="Overall Health" value={overall} badge={badgeLabel(overall)} />
              <HealthBarWithIcon icon={<Cpu className="size-4 text-muted-foreground" />} label="Agents" value={agentsHealth} />
              <HealthBarWithIcon icon={<Workflow className="size-4 text-chart-4" />} label="Workflows" value={workflowsHealth} />
              <HealthBarWithIcon icon={<Plug className="size-4 text-destructive" />} label="Integrations" value={integrationsHealth} />
              <HealthBarWithIcon icon={<Activity className="size-4 text-chart-2" />} label="Infrastructure" value={infraHealth} />
              <div className="pt-4 border-t border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="size-4 text-chart-1" />
                    <span className="text-foreground text-sm font-medium">Security Status</span>
                  </div>
                  <span className={`px-3 py-1 text-xs rounded-md font-medium ${securityOk ? 'bg-chart-1 text-surface-0' : 'bg-chart-3 text-surface-0'}`}>
                    {securityOk ? 'All Clear' : 'Warning'}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="w-1/2 bg-accent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="size-5" />
              Recent Activity
            </CardTitle>
            <CardDescription>Latest updates across your AI factory</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {activityLoading ? (
                <div className="flex flex-col gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : activity.length === 0 ? (
                <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">No recent activity</div>
              ) : (
                activity.map((item, i) => (
                  <ActivityItem key={item.entityId || i}
                    color={ENTITY_COLORS[item.entityType] || 'bg-muted'}
                    title={item.title} description={item.description}
                    tag={ENTITY_TAGS[item.entityType] || item.entityType}
                    time={relativeTime(item.timestamp)}
                    noBorder={i === activity.length - 1} />
                ))
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full mt-4 rounded-lg text-sm font-medium"
              >
                View All Activity
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Get started with common tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <QuickActionButton icon={<Plus className="size-4" />} label="Deploy New Agent" />
            <QuickActionButton icon={<Workflow className="size-4" />} label="Create Workflow" />
            <QuickActionButton icon={<Plug className="size-4" />} label="Add Integration" />
            <QuickActionButton icon={<Users className="size-4" />} label="Invite Team Member" />
            <QuickActionButton icon={<BarChart3 className="size-4" />} label="View Analytics" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function HealthBar({ label, value, badge }: { label: string; value: number; badge?: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-foreground text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-bold">{value}%</span>
          {badge && <span className="px-2 py-0.5 bg-chart-1 text-surface-0 text-xs rounded-full font-medium">{badge}</span>}
        </div>
      </div>
      <div className="w-full rounded-full bg-border-border h-2">
        <div className="rounded-full bg-primary h-2" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function HealthBarWithIcon({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">{icon}<span className="text-foreground text-sm">{label}</span></div>
        <span className="text-foreground text-sm">{value}%</span>
      </div>
      <div className="w-full rounded-full bg-border-border h-2">
        <div className="rounded-full bg-primary h-2" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function ActivityItem({ color, title, description, tag, time, noBorder }: {
  color: string; title: string; description: string; tag: string; time: string; noBorder?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 pb-4 ${noBorder ? '' : 'border-b border-border'}`}>
      <div className={`size-2.5 rounded-full mt-1.5 flex-shrink-0 ${color}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="text-foreground text-sm font-medium">{title}</p>
          <span className="px-2 py-0.5 bg-accent text-muted-foreground text-xs rounded-md whitespace-nowrap">{tag}</span>
        </div>
        <p className="text-muted-foreground text-xs">{description}</p>
        <div className="flex items-center gap-1 mt-1">
          <Clock className="size-3 text-muted-foreground" />
          <span className="text-muted-foreground text-xs">{time}</span>
        </div>
      </div>
    </div>
  );
}

function QuickActionButton({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="bg-accent rounded-lg text-sm font-medium"
    >
      {icon}{label}
    </Button>
  );
}
