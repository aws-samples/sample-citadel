import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { AgentConfig, agentConfigService } from '../services/agentConfigService';
import { AgentTrayItem } from './AgentTrayItem';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { cn } from './ui/utils';
import { toast } from 'sonner';
import { RefreshCwIcon } from 'lucide-react';

interface AgentTrayProps {
  onDragStart?: (event: React.DragEvent, agent: AgentConfig) => void;
}

type TabType = 'active' | 'inactive';

export const AgentTray = memo(function AgentTray({ onDragStart }: AgentTrayProps) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<TabType>('active');

  // Fetch agents from the catalog
  const fetchAgents = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const fetchedAgents = await agentConfigService.listAgentConfigs();
      setAgents(fetchedAgents);
      
      // Show success toast if agents loaded (only on retry, not initial load)
      if (fetchedAgents.length > 0 && error) {
        toast.success('Agent catalog loaded', {
          description: `${fetchedAgents.length} agents available`,
        });
      }
    } catch (err) {
      console.error('Failed to fetch agents:', err);
      const errorMessage = 'Failed to load agents. Please try again.';
      setError(errorMessage);
      
      // Show error toast
      toast.error('Failed to load agent catalog', {
        description: errorMessage,
      });
    } finally {
      setIsLoading(false);
    }
  }, [error]);

  useEffect(() => {
    fetchAgents();
  }, []);

  // Separate agents into active and inactive
  const { activeAgents, inactiveAgents } = useMemo(() => {
    const active: AgentConfig[] = [];
    const inactive: AgentConfig[] = [];
    
    agents.forEach((agent) => {
      if (agent.state === 'active') {
        active.push(agent);
      } else {
        inactive.push(agent);
      }
    });
    
    return { activeAgents: active, inactiveAgents: inactive };
  }, [agents]);

  // Get current tab's agents
  const currentTabAgents = useMemo(() => {
    return activeTab === 'active' ? activeAgents : inactiveAgents;
  }, [activeTab, activeAgents, inactiveAgents]);

  // Extract unique categories from current tab's agents
  const categories = useMemo(() => {
    const categorySet = new Set<string>();
    currentTabAgents.forEach((agent) => {
      if (agent.categories && agent.categories.length > 0) {
        agent.categories.forEach((cat) => categorySet.add(cat));
      } else {
        categorySet.add('Uncategorized');
      }
    });
    return ['all', ...Array.from(categorySet).sort()];
  }, [currentTabAgents]);

  // Filter agents based on search query and selected category
  const filteredAgents = useMemo(() => {
    return currentTabAgents.filter((agent) => {
      // Category filter
      if (selectedCategory !== 'all') {
        const agentCategories = agent.categories || ['Uncategorized'];
        if (!agentCategories.includes(selectedCategory)) {
          return false;
        }
      }

      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const agentName = (agent.config?.name || agent.agentId).toLowerCase();
        const agentDescription = (agent.config?.description || '').toLowerCase();
        const agentCategory = (agent.categories?.[0] || '').toLowerCase();

        return (
          agentName.includes(query) ||
          agentDescription.includes(query) ||
          agentCategory.includes(query)
        );
      }

      return true;
    });
  }, [currentTabAgents, searchQuery, selectedCategory]);

  const handleDragStart = (event: React.DragEvent, agent: AgentConfig) => {
    console.log('Drag started for agent:', agent.config?.name || agent.agentId);
    
    // Set drag data for the workflow canvas to consume
    const dragData = {
      type: 'agentNode',
      agentId: agent.agentId,
      agentConfig: agent,
    };
    
    console.log('Setting drag data:', dragData);
    
    event.dataTransfer.setData(
      'application/reactflow',
      JSON.stringify(dragData)
    );
    event.dataTransfer.effectAllowed = 'move';

    // Call parent handler if provided
    if (onDragStart) {
      onDragStart(event, agent);
    }
  };

  return (
    <nav 
      className="flex flex-col h-full w-80 border-r border-border bg-background shadow-lg"
      aria-label="Agent catalog"
    >
      {/* Header */}
      <div className="shrink-0 p-4 border-b border-border bg-linear-to-b from-surface-0 to-surface-1">
        <h2 className="text-lg font-semibold text-foreground mb-3">Agent Catalog</h2>
        
        {/* Tab Navigation */}
        <div 
          className="flex gap-1 mb-3 p-1 bg-accent rounded-lg border border-border"
          role="tablist"
          aria-label="Agent status tabs"
        >
          <button
            role="tab"
            aria-selected={activeTab === 'active'}
            aria-controls="active-agents-panel"
            onClick={() => {
              setActiveTab('active');
              setSearchQuery('');
              setSelectedCategory('all');
            }}
            className={cn(
              "flex-1 px-3 py-2 rounded text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500",
              activeTab === 'active'
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            Active
            <span className="ml-2 text-xs opacity-75">
              ({activeAgents.length})
            </span>
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'inactive'}
            aria-controls="inactive-agents-panel"
            onClick={() => {
              setActiveTab('inactive');
              setSearchQuery('');
              setSelectedCategory('all');
            }}
            className={cn(
              "flex-1 px-3 py-2 rounded text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500",
              activeTab === 'inactive'
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            Inactive
            <span className="ml-2 text-xs opacity-75">
              ({inactiveAgents.length})
            </span>
          </button>
        </div>
        
        {/* Search Input */}
        <Input
          type="text"
          placeholder="Search agents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="mb-3"
          aria-label="Search agents by name, description, or category"
        />

        {/* Category Filter */}
        <div 
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Filter agents by category"
        >
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              aria-pressed={selectedCategory === category}
              aria-label={`Filter by ${category} category`}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500",
                selectedCategory === category
                  ? "bg-primary text-primary-foreground"
                  : "bg-accent text-muted-foreground hover:bg-accent border border-border"
              )}
            >
              {category.charAt(0).toUpperCase() + category.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Agent List */}
      <ScrollArea className="flex-1 agent-tray-scroll">
        {/* Performance: For very large agent lists (100+), consider using react-window or react-virtual
             for virtualization. Current implementation is optimized with React.memo on AgentTrayItem
             to prevent unnecessary re-renders. */}
        <div 
          id={`${activeTab}-agents-panel`}
          role="tabpanel"
          aria-labelledby={`${activeTab}-tab`}
          className="flex flex-col p-4 gap-3"
        >
          <div 
            role="list"
            aria-label={`${filteredAgents.length} ${activeTab} agents available`}
          >
            {isLoading && (
              <div 
                className="flex flex-col items-center justify-center py-12 text-center"
                role="status"
                aria-live="polite"
              >
                <div className="relative size-12 mb-3">
                  <div className="absolute inset-0 border-2 border-input border-t-primary rounded-full animate-spin" />
                  <div className="absolute inset-2 border-2 border-border border-t-primary/50 rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1s' }} />
                </div>
                <p className="text-sm text-muted-foreground">Loading agents...</p>
              </div>
            )}

            {error && !isLoading && (
              <div 
                className="flex flex-col items-center justify-center py-12 text-center"
                role="alert"
                aria-live="assertive"
              >
                <div className="size-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                  <span className="text-2xl" aria-hidden="true">⚠️</span>
                </div>
                <p className="text-sm text-destructive mb-3">{error}</p>
                <Button
                  onClick={fetchAgents}
                  variant="outline"
                  size="sm"
                  aria-label="Retry loading agents"
                >
                  <RefreshCwIcon className="size-4 mr-2" aria-hidden="true" />
                  Retry
                </Button>
              </div>
            )}

            {!isLoading && !error && filteredAgents.length === 0 && (
              <div 
                className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-300"
                role="status"
                aria-live="polite"
              >
                <div className="size-12 rounded-full bg-accent border-2 border-border flex items-center justify-center mb-3 shadow-lg">
                  <span className="text-2xl" aria-hidden="true">🔍</span>
                </div>
                <p className="text-sm text-muted-foreground px-4">
                  {searchQuery || selectedCategory !== 'all'
                    ? `No ${activeTab} agents match your filters`
                    : `No ${activeTab} agents available`}
                </p>
                {(searchQuery || selectedCategory !== 'all') && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedCategory('all');
                    }}
                    className="mt-3 text-xs text-primary hover:underline transition-all hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-2 py-1"
                    aria-label="Clear all filters"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}

            {!isLoading && !error && filteredAgents.length > 0 && (
              <>
                {filteredAgents.map((agent) => (
                  <AgentTrayItem
                    key={agent.agentId}
                    agent={agent}
                    onDragStart={handleDragStart}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Footer Info */}
      {!isLoading && !error && filteredAgents.length > 0 && (
        <div 
          className="shrink-0 p-3 border-t border-border bg-background"
          role="status"
          aria-live="polite"
        >
          <p className="text-xs text-muted-foreground text-center">
            {filteredAgents.length} {filteredAgents.length === 1 ? 'agent' : 'agents'}
            {searchQuery || selectedCategory !== 'all' ? ' (filtered)' : ''}
          </p>
        </div>
      )}
    </nav>
  );
});
