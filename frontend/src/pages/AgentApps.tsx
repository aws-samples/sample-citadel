import { useState, useEffect, useMemo } from 'react';
import { Plus, Bot, GitBranch, RefreshCw, AppWindow, BarChart3 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { useOrganization } from '../contexts/OrganizationContext';
import { appApiService } from '../services/appApiService';
import { filterAppsBySearch, filterAppsByStatus } from '../utils/appFilters';
import { cn } from '../components/ui/utils';
import { PageContainer } from '../components/PageContainer';
import { SearchInput } from '../components/SearchInput';

interface AgentAppsProps {
  onNavigate?: (view: string) => void;
}

interface RegistryAgentRecordSummary {
  appId: string;
  orgId: string;
  name: string;
  description: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DEPRECATED' | 'CREATING' | 'UPDATING' | 'CREATE_FAILED' | 'UPDATE_FAILED' | 'PUBLISHED';
  workflowIds?: string[];
  agentBindings?: { agentId: string }[];
  updatedAt: string;
}

const STATUS_TABS = ['All', 'DRAFT', 'APPROVED', 'DEPRECATED'] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  DRAFT: { bg: 'bg-primary/20', text: 'text-primary' },
  APPROVED: { bg: 'bg-chart-2/20', text: 'text-chart-2' },
  PUBLISHED: { bg: 'bg-chart-5/20', text: 'text-chart-5' },
  DEPRECATED: { bg: 'bg-muted/20', text: 'text-muted-foreground' },
};

export function AgentApps({ onNavigate }: AgentAppsProps) {
  const { selectedOrganization } = useOrganization();
  const [apps, setApps] = useState<RegistryAgentRecordSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');

  useEffect(() => {
    loadApps();
  }, [selectedOrganization]);

  const loadApps = async () => {
    if (!selectedOrganization) return;
    try {
      setLoading(true);
      setError(null);
      const result = await appApiService.listApps(selectedOrganization);
      setApps(result.items || []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load apps';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const filteredApps = useMemo(() => {
    const searchFiltered = filterAppsBySearch(apps, searchQuery);
    return filterAppsByStatus(searchFiltered, statusFilter);
  }, [apps, searchQuery, statusFilter]);

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <PageContainer>
        <div className="flex flex-col gap-6">
          {/* Header */}
          <div className="flex items-center justify-between px-2">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Agent Apps</h1>
              <p className="text-sm mt-1 text-muted-foreground">
                Build, deploy, and manage application bundles
              </p>
            </div>
            <Button
              variant="outline"
              className="gap-1 text-xs py-1 px-2 h-7"
              onClick={() => onNavigate?.('app-builder')}
            >
              <Plus className="size-4 mr-1" />
              Create App
            </Button>
          </div>

          {/* Search */}
          <div className="flex gap-4">
            <div className="flex-1">
              <SearchInput
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search apps..."
              />
            </div>
          </div>

          {/* Status filter tabs */}
          <div className="flex gap-2">
            {STATUS_TABS.map((tab) => (
              <Button
                key={tab}
                variant="ghost"
                size="sm"
                onClick={() => setStatusFilter(tab)}
                className={cn(
                  'text-sm font-medium transition-colors',
                  statusFilter === tab
                    ? 'bg-accent text-foreground border-b-2 border-primary rounded-b-none'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                )}
              >
                {tab === 'All' ? 'All' : tab.charAt(0) + tab.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>

          {/* Error state */}
          {error && (
            <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
              <p className="text-destructive mb-2">{error}</p>
              <Button variant="outline" size="sm" onClick={loadApps} className="gap-2">
                <RefreshCw className="size-4" />
                Retry
              </Button>
            </div>
          )}

          {/* Loading skeleton */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Card
                  key={i}
                  className="rounded-lg border-border/50 p-4 animate-pulse gap-0"
                >
                  <div className="h-5 bg-accent rounded w-2/3 mb-3" />
                  <div className="h-4 bg-accent rounded w-full mb-2" />
                  <div className="h-4 bg-accent rounded w-1/2 mb-4" />
                  <div className="flex gap-2">
                    <div className="h-5 bg-accent rounded w-16" />
                    <div className="h-5 bg-accent rounded w-16" />
                  </div>
                </Card>
              ))}
            </div>
          ) : !error && filteredApps.length === 0 ? (
            /* Empty state */
            <div className="text-center py-12">
              <AppWindow className="size-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground mb-4">
                {apps.length === 0
                  ? 'No apps yet. Create your first app to get started.'
                  : 'No apps match your filters.'}
              </p>
              {apps.length === 0 && (
                <Button
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => onNavigate?.('app-builder')}
                >
                  <Plus className="size-4 mr-2" />
                  Create App
                </Button>
              )}
            </div>
          ) : (
            /* App cards grid */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredApps.map((app) => {
                const colors = STATUS_COLORS[app.status] || STATUS_COLORS.DRAFT;
                const agentCount = app.agentBindings?.length ?? 0;
                const workflowCount = app.workflowIds?.length ?? 0;

                return (
                  <Card
                    key={app.appId}
                    className="rounded-lg border-border/50 p-4 cursor-pointer transition-colors hover:border-border hover:bg-card gap-0"
                    onClick={() => onNavigate?.(`app-detail:${app.appId}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onNavigate?.(`app-detail:${app.appId}`);
                      }
                    }}
                  >
                    {/* Name + status */}
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-foreground truncate mr-2">
                        {app.name}
                      </h3>
                      <Badge
                        className={cn(colors.bg, colors.text, 'text-xs border-0')}
                      >
                        {app.status}
                      </Badge>
                    </div>

                    {/* Description (2-line truncation) */}
                    <p
                      className="text-xs text-muted-foreground mb-3 line-clamp-2"
                    >
                      {app.description || 'No description'}
                    </p>

                    {/* Counts + date + quick actions */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Bot className="size-3" />
                        {agentCount}
                      </span>
                      <span className="flex items-center gap-1">
                        <GitBranch className="size-3" />
                        {workflowCount}
                      </span>
                      {app.status === 'PUBLISHED' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigate?.(`app-api-dashboard:${app.appId}`);
                          }}
                          className="size-5 text-muted-foreground hover:text-foreground"
                          aria-label="Open API Dashboard"
                          title="API Dashboard"
                        >
                          <BarChart3 className="size-3.5" />
                        </Button>
                      )}
                      <span className="ml-auto">{formatDate(app.updatedAt)}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
    </PageContainer>
  );
}
