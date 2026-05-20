import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Database,
  Loader2,
  Check,
  AlertCircle,
  Wrench,
  LucideIcon,
  Cloud,
  BarChart3,
  FileText,
  Zap,
  Search,
  BookOpen,
  Layers,
  Share2,
  Clock,
  Key,
  Shield,
  Brain,
  Globe,
  AlertTriangle,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { fabricatorService } from '../services/fabricatorService';
import {
  datastoreService,
  DataStore,
  DataStoreStatus,
  DataStoreUsage,
  DATA_STORE_TYPE_META,
} from '../services/datastoreService';
import { useOrganization } from '../contexts/OrganizationContext';
import {
  getAvailableOperationsForUsage,
  isWriteOperationForKnowledgeStore,
  getDataStoreOperationsForType,
} from './datastore-wizard-usage-utils';

// --- Data Store Operations Mapping ---

const DATASTORE_OPERATIONS: Record<string, string[]> = {
  S3: ['read_object', 'write_object', 'list_objects', 'delete_object'],
  DYNAMODB: ['get_item', 'put_item', 'query', 'scan', 'delete_item'],
  RDS_POSTGRESQL: ['execute_query', 'list_tables'],
  RDS_MYSQL: ['execute_query', 'list_tables'],
  AURORA_POSTGRESQL: ['execute_query', 'list_tables'],
  AURORA_MYSQL: ['execute_query', 'list_tables'],
  KNOWLEDGE_BASE: ['query_knowledge_base', 'retrieve_documents'],
  REDSHIFT: ['execute_query', 'list_tables'],
  OPENSEARCH: ['search', 'index_document', 'delete_document'],
  NEPTUNE: ['execute_query', 'list_graphs'],
  TIMESTREAM: ['query', 'write_records'],
  DOCUMENTDB: ['find', 'insert', 'update', 'delete'],
  ELASTICACHE_REDIS: ['get', 'set', 'delete', 'scan'],
};

const GENERIC_OPERATIONS = ['read', 'write'];

export function getDataStoreOperations(dataStoreType: string): string[] {
  return DATASTORE_OPERATIONS[dataStoreType] || GENERIC_OPERATIONS;
}

// --- Icon mapping ---

const iconMap: Record<string, LucideIcon> = {
  Cloud,
  Database,
  BarChart3,
  FileText,
  Zap,
  Search,
  BookOpen,
  Layers,
  Share2,
  Clock,
  Key,
  Shield,
  Brain,
  Globe,
};

const getIconComponent = (iconName: string): LucideIcon => {
  return iconMap[iconName] || Database;
};

// --- Wizard Steps ---

type WizardStep = 'select-datastore' | 'select-operations' | 'configure' | 'review';

const STEPS: WizardStep[] = ['select-datastore', 'select-operations', 'configure', 'review'];

const STEP_LABELS: Record<WizardStep, string> = {
  'select-datastore': 'Select Data Store',
  'select-operations': 'Select Operations',
  configure: 'Configure Tool',
  review: 'Review & Submit',
};

// --- Usage filter options ---

type UsageFilter = 'all' | 'knowledge' | 'operational' | 'both';

const USAGE_FILTER_LABELS: Record<UsageFilter, string> = {
  all: 'All',
  knowledge: 'Knowledge',
  operational: 'Operational',
  both: 'Both',
};

// --- Direction options ---

type BindingDirection = 'INPUT' | 'OUTPUT' | 'BIDIRECTIONAL';

const DIRECTION_LABELS: Record<BindingDirection, string> = {
  INPUT: '← Input',
  OUTPUT: '→ Output',
  BIDIRECTIONAL: '↔ Bidirectional',
};

// --- Usage badge helpers ---

function getUsageBadgeStyle(usage?: string): string {
  switch (usage?.toUpperCase()) {
    case 'KNOWLEDGE':
      return 'bg-primary/10 text-primary border-primary/30';
    case 'OPERATIONAL':
      return 'bg-chart-5/10 text-chart-5 border-chart-5/30';
    case 'BOTH':
      return 'bg-teal-500/10 text-teal-400 border-teal-500/30';
    default:
      return 'bg-teal-500/10 text-teal-400 border-teal-500/30';
  }
}

function getUsageLabel(usage?: string): string {
  switch (usage?.toUpperCase()) {
    case 'KNOWLEDGE':
      return 'Knowledge';
    case 'OPERATIONAL':
      return 'Operational';
    case 'BOTH':
      return 'Both';
    default:
      return 'Both';
  }
}

/** Returns an array of {label, style} for the usage badges. BOTH expands to two separate badges. */
function getUsageBadges(usage?: string): Array<{ label: string; style: string }> {
  const upper = usage?.toUpperCase();
  if (upper === 'BOTH' || !upper) {
    return [
      { label: 'Knowledge', style: getUsageBadgeStyle('KNOWLEDGE') },
      { label: 'Operational', style: getUsageBadgeStyle('OPERATIONAL') },
    ];
  }
  return [{ label: getUsageLabel(usage), style: getUsageBadgeStyle(usage) }];
}

// --- Component Props ---

interface DataStoreToolWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function DataStoreToolWizard({ onComplete, onCancel }: DataStoreToolWizardProps) {
  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || 'default';

  // Wizard state
  const [currentStep, setCurrentStep] = useState<WizardStep>('select-datastore');
  const [dataStores, setDataStores] = useState<DataStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selection state
  const [selectedDataStore, setSelectedDataStore] = useState<DataStore | null>(null);
  const [selectedOperations, setSelectedOperations] = useState<string[]>([]);
  const [toolName, setToolName] = useState('');
  const [toolDescription, setToolDescription] = useState('');
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all');
  const [bindingDirection, setBindingDirection] = useState<BindingDirection>('BIDIRECTIONAL');

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load connected data stores on mount
  useEffect(() => {
    const loadDataStores = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const allStores = await datastoreService.listDataStores(orgId);
        setDataStores(allStores.filter((ds) => ds.status === DataStoreStatus.CONNECTED));
      } catch (err: any) {
        console.error('Failed to load data stores:', err);
        setLoadError(err.message || 'Failed to load data stores');
      } finally {
        setLoading(false);
      }
    };
    loadDataStores();
  }, [orgId]);

  // Navigation helpers
  const currentStepIndex = STEPS.indexOf(currentStep);

  const goNext = () => {
    if (currentStepIndex < STEPS.length - 1) {
      setCurrentStep(STEPS[currentStepIndex + 1]);
    }
  };

  const goBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(STEPS[currentStepIndex - 1]);
    }
  };

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 'select-datastore':
        return selectedDataStore !== null;
      case 'select-operations':
        return selectedOperations.length > 0;
      case 'configure':
        return toolName.trim().length > 0 && toolDescription.trim().length > 0;
      case 'review':
        return true;
      default:
        return false;
    }
  };

  // Operation toggle
  const toggleOperation = (op: string) => {
    setSelectedOperations((prev) =>
      prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]
    );
  };

  // Data store selection
  const handleSelectDataStore = (ds: DataStore) => {
    setSelectedDataStore(ds);
    // Pre-select operations based on usage type
    const usage = (ds.usage || DataStoreUsage.BOTH).toLowerCase() as 'knowledge' | 'operational' | 'both';
    const defaultOps = getAvailableOperationsForUsage(ds.type, usage);
    setSelectedOperations(defaultOps);
  };

  // Submit handler
  const handleSubmit = async () => {
    if (!selectedDataStore) return;

    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const meta = DATA_STORE_TYPE_META[selectedDataStore.type];
      const enhancedDescription = [
        toolDescription.trim(),
        `\nData Store Type: ${meta?.displayName || selectedDataStore.type}`,
        `Operations: ${selectedOperations.join(', ')}`,
        `Provider: ${selectedDataStore.provider}`,
      ].join('\n');

      await fabricatorService.requestToolCreation({
        toolName: toolName.trim(),
        toolDescription: enhancedDescription,
        dataStoreBindings: [
          {
            dataStoreId: selectedDataStore.dataStoreId,
            dataStoreType: selectedDataStore.type,
            operations: selectedOperations,
            direction: bindingDirection,
          },
        ],
      });

      onComplete();
    } catch (err: any) {
      console.error('Failed to create data store tool:', err);
      setSubmitError(err.message || 'Failed to create tool. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- No connected data stores ---
  if (!loading && !loadError && dataStores.length === 0) {
    return (
      <div className="min-h-screen bg-card p-6">
        <div className="mb-6">
          <Button variant="ghost" className="text-muted-foreground hover:text-foreground mb-4" onClick={onCancel}>
            <ArrowLeft className="size-4 mr-2" />
            Back to Tools
          </Button>
        </div>
        <div className="max-w-lg mx-auto text-center py-16">
          <div className="size-16 rounded-full bg-accent border border-border flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="size-8 text-amber-500" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-3">No Connected Data Stores</h2>
          <p className="text-muted-foreground mb-6">
            You need at least one connected data store to create a data store tool.
            Visit the Data Stores page to connect a data store first.
          </p>
          <Button
            variant="outline"
            className="border-border text-foreground hover:bg-accent"
            onClick={onCancel}
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  // --- Available operations for selected data store (usage-aware) ---
  const selectedUsage = selectedDataStore
    ? ((selectedDataStore.usage || DataStoreUsage.BOTH).toLowerCase() as 'knowledge' | 'operational' | 'both')
    : 'both';
  const availableOperations = selectedDataStore
    ? getDataStoreOperationsForType(selectedDataStore.type)
    : [];
  const defaultOperations = selectedDataStore
    ? getAvailableOperationsForUsage(selectedDataStore.type, selectedUsage)
    : [];
  const isKnowledgeStore = selectedUsage === 'knowledge';

  // --- Filter data stores by usage ---
  const filteredDataStores = dataStores.filter((ds) => {
    if (usageFilter === 'all') return true;
    const dsUsage = (ds.usage || DataStoreUsage.BOTH).toUpperCase();
    if (usageFilter === 'knowledge') return dsUsage === 'KNOWLEDGE' || dsUsage === 'BOTH';
    if (usageFilter === 'operational') return dsUsage === 'OPERATIONAL' || dsUsage === 'BOTH';
    if (usageFilter === 'both') return dsUsage === 'BOTH';
    return true;
  });

  // --- Render ---
  return (
    <div className="min-h-screen bg-card p-6">
      {/* Header */}
      <div className="mb-6">
        <Button variant="ghost" className="text-muted-foreground hover:text-foreground mb-4" onClick={onCancel}>
          <ArrowLeft className="size-4 mr-2" />
          Back to Tools
        </Button>
        <div className="flex items-center gap-3">
          <div className="size-12 rounded-lg bg-accent border border-border flex items-center justify-center">
            <Database className="size-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Wrap a Data Store</h1>
            <p className="text-muted-foreground text-sm">
              Create a tool that wraps access to a connected data store
            </p>
          </div>
        </div>
      </div>

      {/* Step Indicator */}
      <div className="max-w-3xl mb-8">
        <div className="flex items-center gap-2">
          {STEPS.map((step, idx) => {
            const isActive = idx === currentStepIndex;
            const isCompleted = idx < currentStepIndex;
            return (
              <div key={step} className="flex items-center gap-2 flex-1">
                <div
                  className={`size-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${
                    isCompleted
                      ? 'bg-primary text-foreground'
                      : isActive
                        ? 'bg-primary/20 text-primary border border-primary'
                        : 'bg-accent text-muted-foreground border border-border'
                  }`}
                >
                  {isCompleted ? <Check className="size-4" /> : idx + 1}
                </div>
                <span
                  className={`text-xs hidden sm:inline ${
                    isActive ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {STEP_LABELS[step]}
                </span>
                {idx < STEPS.length - 1 && (
                  <div
                    className={`flex-1 h-px ${
                      isCompleted ? 'bg-primary' : 'bg-accent'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step Content */}
      <div className="max-w-3xl">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-8 text-primary animate-spin" />
          </div>
        ) : loadError ? (
          <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
            <p className="text-destructive">{loadError}</p>
          </div>
        ) : (
          <>
            {/* Step 1: Select Data Store */}
            {currentStep === 'select-datastore' && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Select a Data Store</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Choose a connected data store to wrap with a tool
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {/* Usage filter tabs */}
                  <div className="flex gap-2 mb-4">
                    {(Object.keys(USAGE_FILTER_LABELS) as UsageFilter[]).map((filter) => (
                      <Button
                        key={filter}
                        variant={usageFilter === filter ? 'default' : 'outline'}
                        size="sm"
                        className={
                          usageFilter === filter
                            ? 'bg-primary text-foreground hover:bg-primary/90'
                            : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                        }
                        onClick={() => setUsageFilter(filter)}
                      >
                        {USAGE_FILTER_LABELS[filter]}
                      </Button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filteredDataStores.map((ds) => {
                      const Icon = getIconComponent(ds.icon);
                      const meta = DATA_STORE_TYPE_META[ds.type];
                      const isSelected = selectedDataStore?.dataStoreId === ds.dataStoreId;

                      return (
                        <button
                          key={ds.dataStoreId}
                          type="button"
                          onClick={() => handleSelectDataStore(ds)}
                          className={`relative flex items-start gap-3 p-4 rounded-lg border transition-all text-left ${
                            isSelected
                              ? 'bg-primary/10 border-primary'
                              : 'bg-card border-border hover:border-input'
                          }`}
                        >
                          <div
                            className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${
                              isSelected ? 'bg-primary/20' : 'bg-accent'
                            }`}
                          >
                            <Icon className={`size-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="text-foreground text-sm font-medium truncate">{ds.name}</h4>
                              {isSelected && <Check className="size-4 text-primary shrink-0" />}
                            </div>
                            <p className="text-muted-foreground text-xs mt-0.5">
                              {meta?.displayName || ds.type}
                            </p>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {getUsageBadges(ds.usage).map((b) => (
                                <Badge key={b.label} variant="secondary" className={`text-xs ${b.style}`}>
                                  {b.label}
                                </Badge>
                              ))}
                              <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                                {ds.category.replace(/_/g, ' ')}
                              </Badge>
                              <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                                {ds.provider}
                              </Badge>
                              <Badge variant="secondary" className="text-xs bg-chart-2/10 text-chart-2 border-chart-2/30">
                                {ds.status}
                              </Badge>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Step 2: Select Operations */}
            {currentStep === 'select-operations' && selectedDataStore && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Select Operations</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Choose which operations the tool should support for{' '}
                    <span className="text-foreground font-medium">{selectedDataStore.name}</span> (
                    {DATA_STORE_TYPE_META[selectedDataStore.type]?.displayName || selectedDataStore.type})
                    {isKnowledgeStore && (
                      <span className="block mt-1 text-primary text-xs">
                        This is a knowledge store — read-only operations are pre-selected.
                      </span>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-3">
                    {availableOperations.map((op) => {
                      const isChecked = selectedOperations.includes(op);
                      const isWriteOp = isKnowledgeStore && isWriteOperationForKnowledgeStore(selectedDataStore.type, op);
                      return (
                        <div key={op}>
                          <label
                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                              isChecked
                                ? isWriteOp
                                  ? 'bg-chart-4/10 border-chart-4/50'
                                  : 'bg-primary/10 border-primary'
                                : 'bg-card border-border hover:border-input'
                            }`}
                          >
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={() => toggleOperation(op)}
                            />
                            <span className="text-foreground text-sm font-mono">{op}</span>
                            {isWriteOp && (
                              <Badge variant="secondary" className="text-xs bg-chart-4/10 text-chart-4 border-chart-4/30 ml-auto">
                                write
                              </Badge>
                            )}
                          </label>
                          {isChecked && isWriteOp && (
                            <div className="flex items-center gap-2 mt-1 ml-10 text-xs text-chart-4">
                              <AlertTriangle className="size-3 shrink-0" />
                              <span>Write operations are atypical for knowledge stores</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground text-xs"
                      onClick={() => setSelectedOperations([...availableOperations])}
                    >
                      Select All
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground text-xs"
                      onClick={() => setSelectedOperations(isKnowledgeStore ? [...defaultOperations] : [])}
                    >
                      {isKnowledgeStore ? 'Reset to Read-Only' : 'Clear All'}
                    </Button>
                  </div>

                  {/* Direction selector */}
                  <div className="mt-6 pt-4 border-t border-border">
                    <Label className="text-foreground text-sm mb-2 block">Binding Direction</Label>
                    <p className="text-muted-foreground text-xs mb-3">
                      Specify how this tool uses the data store
                    </p>
                    <div className="flex gap-2">
                      {(Object.keys(DIRECTION_LABELS) as BindingDirection[]).map((dir) => (
                        <Button
                          key={dir}
                          variant={bindingDirection === dir ? 'default' : 'outline'}
                          size="sm"
                          className={
                            bindingDirection === dir
                              ? 'bg-primary text-foreground hover:bg-primary/90'
                              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                          }
                          onClick={() => setBindingDirection(dir)}
                        >
                          {DIRECTION_LABELS[dir]}
                        </Button>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Step 3: Configure */}
            {currentStep === 'configure' && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Configure Tool</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Set a name and description for the generated tool
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="ds-tool-name" className="text-foreground">
                      Tool Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="ds-tool-name"
                      placeholder="e.g., query_customer_db, read_s3_reports"
                      value={toolName}
                      onChange={(e) => setToolName(e.target.value)}
                      className="bg-card border-border text-foreground placeholder:text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">Use snake_case for the tool function name</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="ds-tool-desc" className="text-foreground">
                      Tool Description <span className="text-destructive">*</span>
                    </Label>
                    <Textarea
                      id="ds-tool-desc"
                      placeholder="Describe what this tool does and how agents should use it."
                      value={toolDescription}
                      onChange={(e) => setToolDescription(e.target.value)}
                      className="bg-card border-border text-foreground placeholder:text-muted-foreground min-h-[120px]"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Step 4: Review & Submit */}
            {currentStep === 'review' && selectedDataStore && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Review & Submit</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Confirm the details before creating the tool
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  {/* Data Store */}
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wider">Data Store</Label>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-foreground font-medium">{selectedDataStore.name}</span>
                      <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                        {DATA_STORE_TYPE_META[selectedDataStore.type]?.displayName || selectedDataStore.type}
                      </Badge>
                    </div>
                  </div>

                  {/* Operations */}
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wider">Operations</Label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {selectedOperations.map((op) => (
                        <Badge key={op} variant="secondary" className="text-xs bg-card text-foreground border-border font-mono">
                          {op}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Tool Name */}
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wider">Tool Name</Label>
                    <p className="mt-1 text-foreground font-mono">{toolName}</p>
                  </div>

                  {/* Tool Description */}
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wider">Description</Label>
                    <p className="mt-1 text-muted-foreground text-sm whitespace-pre-wrap">{toolDescription}</p>
                  </div>

                  {/* Binding Info */}
                  <div className="bg-card border border-border rounded-lg p-4">
                    <h4 className="text-foreground text-sm font-medium mb-2">Data Store Binding</h4>
                    <div className="flex flex-col text-xs text-muted-foreground gap-1">
                      <p>
                        <span className="text-muted-foreground">ID:</span> {selectedDataStore.dataStoreId}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Type:</span> {selectedDataStore.type}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Usage:</span>{' '}
                        {getUsageBadges(selectedDataStore.usage).map((b) => (
                          <Badge key={b.label} variant="secondary" className={`text-xs ${b.style}`}>
                            {b.label}
                          </Badge>
                        ))}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Direction:</span> {DIRECTION_LABELS[bindingDirection]}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Operations:</span> {selectedOperations.join(', ')}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-3">
                      This binding ensures the agent receives scoped credentials for this data store at runtime.
                    </p>
                  </div>

                  {/* Submit Error */}
                  {submitError && (
                    <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
                      <p className="text-destructive text-sm">{submitError}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Navigation Buttons */}
            <div className="flex justify-between mt-6">
              <Button
                variant="outline"
                className="border-border text-foreground hover:bg-accent"
                onClick={currentStepIndex === 0 ? onCancel : goBack}
                disabled={isSubmitting}
              >
                <ArrowLeft className="size-4 mr-2" />
                {currentStepIndex === 0 ? 'Cancel' : 'Back'}
              </Button>

              {currentStep === 'review' ? (
                <Button
                  className="bg-primary text-foreground hover:bg-primary/90"
                  onClick={handleSubmit}
                  disabled={isSubmitting || !canGoNext()}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 mr-2 animate-spin" />
                      Creating Tool...
                    </>
                  ) : (
                    <>
                      <Wrench className="size-4 mr-2" />
                      Create Tool
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  className="bg-primary text-foreground hover:bg-primary/90"
                  onClick={goNext}
                  disabled={!canGoNext()}
                >
                  Next
                  <ArrowRight className="size-4 ml-2" />
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
