import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, Filter, Wrench, Code, Database, Cloud, Save, ChevronDown, FileText, Link, Layers } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import { toolConfigService, ToolConfig } from '../services/toolConfigService';
import { CreateToolWizard } from '../components/CreateToolWizard';
import { DataStoreToolWizard } from '../components/DataStoreToolWizard';
import { IntegrationToolWizard } from '../components/IntegrationToolWizard';
import { DataPipelineWizard } from '../components/DataPipelineWizard';
import { ToolCard } from '../components/ToolCard';
import { FabricationButton } from '../components/FabricationButton';
import { FabricationTray } from '../components/FabricationTray';
import { useFabricatorQueue } from '../hooks/useFabricatorQueue';
import { useOrganization } from '../contexts/OrganizationContext';
import { PageContainer } from '../components/PageContainer';

type WizardMode = 'none' | 'describe' | 'datastore' | 'integration' | 'pipeline';

// Simple dropdown menu for Create Tool button
function CreateToolMenu({ onSelect }: { onSelect: (mode: WizardMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const items = [
    { mode: 'pipeline' as WizardMode, icon: Layers, label: 'Build a Tool' },
    { mode: 'describe' as WizardMode, icon: FileText, label: 'Describe a Tool' },
    { mode: 'datastore' as WizardMode, icon: Database, label: 'Wrap a Data Store' },
    { mode: 'integration' as WizardMode, icon: Link, label: 'Wrap an Integration' },
  ];

  return (
    <div ref={ref} className="relative inline-block">
      <Button
        variant="outline"
        className="gap-1 text-xs py-1 px-2 h-7"
        onClick={() => setOpen(!open)}
      >
        <Save className="size-4 mr-1" />
        Create Tool
        <ChevronDown className="size-3 ml-1" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-accent border border-input rounded-md min-w-[200px] z-50 p-1 shadow-lg">
          {items.map(({ mode, icon: Icon, label }) => (
            <Button
              key={mode}
              variant="ghost"
              size="sm"
              onClick={() => { setOpen(false); onSelect(mode); }}
              className="flex items-center justify-start gap-2 w-full px-3 py-2 text-muted-foreground text-[13px] rounded text-left hover:bg-border-border h-auto font-normal"
            >
              <Icon className="size-4 text-muted-foreground" />
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// Icon mapping for categories
const categoryIcons: { [key: string]: any } = {
  integration: Cloud,
  database: Database,
  utility: Wrench,
  development: Code,
  default: Wrench,
};

export function Tools() {
  const { currentUser } = useOrganization();
  const [wizardMode, setWizardMode] = useState<WizardMode>('none');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [tools, setTools] = useState<ToolConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFabricationTrayOpen, setIsFabricationTrayOpen] = useState(false);
  
  const { queueItems, reload: reloadQueue, addPendingItem } = useFabricatorQueue({
    onFabricationComplete: () => { loadTools(); },
  });

  useEffect(() => { loadTools(); }, []);

  const loadTools = async () => {
    try {
      setLoading(true); setError(null);
      const data = await toolConfigService.listToolConfigs();
      setTools(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load tools');
    } finally { setLoading(false); }
  };

  const handleToggleState = async (tool: ToolConfig) => {
    try {
      setError(null);
      const newState = tool.state === 'active' ? 'inactive' : 'active';
      await toolConfigService.updateToolConfig({ toolId: tool.toolId, state: newState });
      await loadTools();
    } catch (err: any) { setError(err.message || 'Failed to update tool state'); }
  };

  const handleBackToCatalog = () => { setWizardMode('none'); loadTools(); };

  const handleConfigureTool = (_toolId: string) => {
    // BLOCKED pending ToolDetails view spec (sub-view shape, editable surface,
    // permissions for bindings vs basic config, governance/audit). Backend
    // tool-config CRUD exists; UI surface does not. No-op until specified.
  };

  const categories = useMemo(() => {
    const categoryMap = new Map<string, number>();
    tools.forEach((tool) => {
      if (tool.categories && tool.categories.length > 0) {
        tool.categories.forEach((cat) => { categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1); });
      }
    });
    const categoryList = [{ id: 'all', label: 'All Tools', icon: Wrench, count: tools.length }];
    Array.from(categoryMap.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([category, count]) => {
      categoryList.push({
        id: category, label: category.charAt(0).toUpperCase() + category.slice(1),
        icon: categoryIcons[category.toLowerCase()] || categoryIcons.default, count,
      });
    });
    return categoryList;
  }, [tools]);

  const filteredTools = useMemo(() => {
    return tools.filter((tool) => {
      const config = typeof tool.config === 'string'
        ? (() => { try { return JSON.parse(tool.config as string); } catch { return {}; } })()
        : (tool.config ?? {});
      const matchesSearch = searchQuery === '' ||
        tool.toolId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        config?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        config?.description?.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = selectedCategory === 'all' ||
        (tool.categories && tool.categories.includes(selectedCategory));
      return matchesSearch && matchesCategory;
    });
  }, [tools, searchQuery, selectedCategory]);

  // Render active wizard
  if (wizardMode === 'describe') {
    return (
      <CreateToolWizard onBack={handleBackToCatalog} onComplete={handleBackToCatalog}
        onRequestSubmitted={(requestId, toolName, toolDescription) => { addPendingItem(requestId, toolName, toolDescription); }} />
    );
  }
  if (wizardMode === 'datastore') {
    return <DataStoreToolWizard onComplete={handleBackToCatalog} onCancel={handleBackToCatalog} />;
  }
  if (wizardMode === 'integration') {
    return <IntegrationToolWizard onComplete={handleBackToCatalog} onCancel={handleBackToCatalog} />;
  }
  if (wizardMode === 'pipeline') {
    return <DataPipelineWizard onComplete={handleBackToCatalog} onCancel={handleBackToCatalog} />;
  }

  return (
    <PageContainer className="flex flex-col gap-6">
      <div className="flex items-center justify-between px-2">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Tools</h1>
          <p className="text-sm mt-1 text-muted-foreground">Available tools and utilities for your agents</p>
        </div>
        <div className="flex gap-2">
          <CreateToolMenu onSelect={setWizardMode} />
        </div>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="flex-1 relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10">
            <Search className="size-4 text-muted-foreground" />
          </div>
          <Input type="text" placeholder="Search tools..."
            className="bg-transparent border border-input text-foreground text-sm pl-9 focus:border-border-input transition-colors"
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>
        <Button variant="outline" className="gap-2 h-10 px-4 font-medium rounded-md inline-flex items-center transition-colors bg-transparent border border-input text-foreground text-sm cursor-pointer hover:bg-accent"
          >
          <Filter className="size-4" /> Filter
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 mt-5">
        {categories.map((category) => {
          const Icon = category.icon;
          const isActive = selectedCategory === category.id;
          return (
            <Button key={category.id} variant="outline"
              className={cn(
                                "gap-2 h-9 px-3 font-medium rounded-md inline-flex items-center transition-all border-none cursor-pointer text-sm",
                                isActive
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-accent text-muted-foreground hover:bg-border-border"
                              )}
              onClick={() => setSelectedCategory(category.id)}>
              <Icon className="size-4" /> <span>{category.label}</span>
              <Badge variant="secondary" className={cn(
                                  "ml-1 text-[11px] px-1.5 py-0.5 font-semibold rounded min-w-[20px] text-center",
                                  isActive
                                    ? "bg-primary-foreground text-primary"
                                    : "bg-background text-muted-foreground"
                                )}>
                {category.count}
              </Badge>
            </Button>
          );
        })}
        <FabricationButton queueCount={queueItems.length} onClick={() => setIsFabricationTrayOpen(true)} />
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4 mb-6">
          <p className="text-destructive">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full size-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading tools...</p>
          </div>
        </div>
      ) : filteredTools.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-4">No tools found</p>
          <CreateToolMenu onSelect={setWizardMode} />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredTools.map((tool) => (
            <ToolCard key={tool.toolId} tool={tool} onToggleState={handleToggleState}
              onConfigure={handleConfigureTool} userRole={currentUser?.role}
              configureDisabled={true} />
          ))}
        </div>
      )}

      <FabricationTray isOpen={isFabricationTrayOpen} onClose={() => setIsFabricationTrayOpen(false)}
        queueItems={queueItems} onRefresh={reloadQueue} />
    </PageContainer>
  );
}
