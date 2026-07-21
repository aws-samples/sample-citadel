import { useState, useEffect, useMemo } from 'react';
import { Filter, BarChart3, Palette, Code, FileText, Eye, Briefcase, Download, Save, Bot, Users } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { agentConfigService, AgentConfig } from '../services/agentConfigService';
import { AgentDetails } from '../components/AgentDetails';
import { CreateAgentWizard } from '../components/CreateAgentWizard';
import { AgentCard } from '../components/AgentCard';
import { TaskRunner } from '../components/TaskRunner';
import { useOrganization } from '../contexts/OrganizationContext';
import { FabricationButton } from '../components/FabricationButton';
import { summarizeFabricationQueue } from '../components/fabricationGrouping';
import { FabricationTray } from '../components/FabricationTray';
import { useFabricatorQueue } from '../hooks/useFabricatorQueue';
import { cn } from '../components/ui/utils';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PageContainer } from '../components/PageContainer';
import { SearchInput } from '../components/SearchInput';
import { ImportAgentWizard } from '../components/ImportAgentWizard';

type SubView = 'catalog' | 'details' | 'create' | 'import';
type TabView = 'agents' | 'supervisor';

// Icon mapping for categories
const categoryIcons: { [key: string]: any } = {
  analytics: BarChart3,
  design: Palette,
  development: Code,
  nlp: FileText,
  vision: Eye,
  business: Briefcase,
  default: FileText,
};

export function AgentCatalog() {
  const { currentUser } = useOrganization();
  const [activeTab, setActiveTab] = useState<TabView>('agents');
  const [subView, setSubView] = useState<SubView>('catalog');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFabricationTrayOpen, setIsFabricationTrayOpen] = useState(false);
  
  // Integrate fabricator queue hook with callback to refresh agents on completion
  const { queueItems, reload: reloadQueue, addPendingItem } = useFabricatorQueue({
    onFabricationComplete: () => {
      // Refresh agent catalog when fabrication completes
      loadAgents();
    },
  });
  const queueSummary = summarizeFabricationQueue(queueItems);

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await agentConfigService.listAgentConfigs();
      console.debug('Loaded agents:', data);
      console.debug('First agent config:', data[0]?.config);
      console.debug('First agent config type:', typeof data[0]?.config);
      setAgents(data);
    } catch (err: any) {
      console.error('Failed to load agents:', err);
      setError(err.message || 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleState = async (agent: AgentConfig) => {
    try {
      setError(null);
      const newState = agent.state === 'active' ? 'inactive' : 'active';
      await agentConfigService.updateAgentConfig({
        agentId: agent.agentId,
        state: newState,
      });
      await loadAgents();
    } catch (err: any) {
      setError(err.message || 'Failed to update agent state');
    }
  };

  const handleConfigureAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setSubView('details');
  };

  const handleCreateAgent = () => {
    setSelectedAgentId(null);
    setSubView('create');
  };

  const handleImportAgent = () => {
    setSelectedAgentId(null);
    setSubView('import');
  };

  const handleBackToCatalog = () => {
    setSelectedAgentId(null);
    setSubView('catalog');
    loadAgents(); // Refresh the list
  };

  // Generate categories from agents (must be before early returns)
  const categories = useMemo(() => {
    const categoryMap = new Map<string, number>();
    
    agents.forEach((agent) => {
      if (agent.categories && agent.categories.length > 0) {
        agent.categories.forEach((cat) => {
          categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1);
        });
      }
    });

    const categoryList = [
      { id: 'all', label: 'All Agents', icon: FileText, count: agents.length },
    ];

    Array.from(categoryMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([category, count]) => {
        categoryList.push({
          id: category,
          label: category.charAt(0).toUpperCase() + category.slice(1),
          icon: categoryIcons[category.toLowerCase()] || categoryIcons.default,
          count,
        });
      });

    return categoryList;
  }, [agents]);

  // Filter agents based on search and category (must be before early returns)
  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      // Parse config if it's a string
      const config = typeof agent.config === 'string' ? (() => { try { return JSON.parse(agent.config); } catch { return {}; } })() : (agent.config ?? {});
      
      const matchesSearch = searchQuery === '' || 
        agent.agentId?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        config?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        config?.description?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesCategory = selectedCategory === 'all' ||
      (agent.categories && agent.categories.includes(selectedCategory));
    
      return matchesSearch && matchesCategory;
    });
  }, [agents, searchQuery, selectedCategory]);

  // Render sub-pages (after all hooks)
  if (subView === 'details' && selectedAgentId) {
    return (
      <AgentDetails
        agentId={selectedAgentId}
        onBack={handleBackToCatalog}
        onSave={handleBackToCatalog}
      />
    );
  }

  if (subView === 'create') {
    return (
      <CreateAgentWizard
        onBack={handleBackToCatalog}
        onComplete={handleBackToCatalog}
        onRequestSubmitted={(requestId, agentName, taskDescription) => {
          // Add the new request to the queue immediately
          addPendingItem(requestId, agentName, taskDescription);
          // Auto-open the fabrication tray so user can see progress
          setIsFabricationTrayOpen(true);
        }}
      />
    );
  }

  if (subView === 'import') {
    return (
      <ImportAgentWizard
        onBack={handleBackToCatalog}
        onComplete={handleBackToCatalog}
      />
    );
  }

  const tabs = [
    { id: 'agents' as TabView, label: 'Agent Catalog', icon: Bot },
    { id: 'supervisor' as TabView, label: 'Supervisor', icon: Users },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Tab Navigation */}
      <div className="border-b border-border/50 bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-1 py-2">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'gap-2 text-sm font-medium transition-colors',
                    activeTab === tab.id
                      ? 'bg-accent text-foreground border-b-2 border-primary rounded-b-none'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  <Icon className="size-4" />
                  {tab.label}
                </Button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content Area */}
      <PageContainer>
        {activeTab === 'supervisor' && (
          <ErrorBoundary>
            <TaskRunner />
          </ErrorBoundary>
        )}
        
        {activeTab === 'agents' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between px-2">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">AI Agents</h1>
            <p className="text-sm mt-1 text-muted-foreground">
              Discover, deploy, and manage AI agents for your workflows
            </p>
          </div>
          <div className="flex gap-2">
            <Button 
              variant="outline" className="gap-1 text-xs py-1 px-2 h-7"
              onClick={handleCreateAgent}
            >
              <Save className="size-4 mr-2" />
              Create Worker
            </Button>
            <Button
              variant="outline" className="gap-1 text-xs py-1 px-2 h-7 cursor-pointer"
              onClick={handleImportAgent}
            >
              <Download className="size-4 mr-2" />
              Import Agent
            </Button>
          </div>
        </div>

        {/* Search and Filter */}
        <div className="flex gap-4 mb-6">
          <div className="flex-1">
            <SearchInput
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents..."
            />
          </div>
          <Button 
            variant="outline" 
            className="gap-2 h-10 px-4 font-medium rounded-md inline-flex items-center transition-colors bg-transparent border border-input text-foreground text-sm cursor-pointer hover:bg-accent"
            >
            <Filter className="size-4" />
            Filter
          </Button>
        </div>

        {/* Category Filters */}
        <div className="flex flex-wrap gap-2 mt-5">
          {categories.map((category) => {
            const isActive = selectedCategory === category.id;

            return (
              <Button
                key={category.id}
                variant="outline"
                className={cn(
                                  "gap-2 h-9 px-3 font-medium rounded-md inline-flex items-center transition-all border-none cursor-pointer text-sm",
                                  isActive
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-accent text-muted-foreground hover:bg-border-border"
                                )}
                onClick={() => setSelectedCategory(category.id)}
              >
                <Bot className="size-4" />
                <span>{category.label}</span>
                <Badge 
                  variant="secondary" 
                  className={cn(
                                      "ml-1 text-[11px] px-1.5 py-0.5 font-semibold rounded min-w-[20px] text-center",
                                      isActive
                                        ? "bg-primary-foreground text-primary"
                                        : "bg-background text-muted-foreground"
                                    )}
                >
                  {category.count}
                </Badge>
              </Button>
            );
          })}
          
          {/* Fabrication Button */}
          <FabricationButton
            activeCount={queueSummary.active}
            completedCount={queueSummary.completed}
            onClick={() => setIsFabricationTrayOpen(true)}
          />
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4 mb-6">
            <p className="text-destructive">{error}</p>
          </div>
        )}

        {/* Loading State */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="animate-spin rounded-full size-12 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading agents...</p>
            </div>
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-4">No agents found</p>
            <div className="flex gap-2 justify-center">
              <Button 
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleCreateAgent}
              >
                <Save className="size-4 mr-2" />
                Create Worker
              </Button>
              <Button
                variant="outline"
                className="border-border text-foreground hover:bg-accent cursor-pointer"
                onClick={handleImportAgent}
              >
                <Download className="size-4 mr-2" />
                Import Agent
              </Button>
            </div>
          </div>
        ) : (
          /* Agent Cards Grid */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAgents.map((agent) => (
              <AgentCard
                key={agent.agentId}
                agent={agent}
                onToggleState={handleToggleState}
                onConfigure={handleConfigureAgent}
                userRole={currentUser?.role}
              />
            ))}
          </div>
        )}
      {/* </div> */}
      
            {/* Fabrication Tray */}
            <FabricationTray
              isOpen={isFabricationTrayOpen}
              onClose={() => setIsFabricationTrayOpen(false)}
              queueItems={queueItems}
              onRefresh={reloadQueue}
            />
          </div>
        )}
      </PageContainer>
    </div>
  );
}
