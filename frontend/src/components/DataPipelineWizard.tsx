import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Check,
  AlertCircle,
  Zap,
  Database,
  Cloud,
  LucideIcon,
  BarChart3,
  FileText,
  Search,
  BookOpen,
  Layers,
  Share2,
  Clock,
  Key,
  Shield,
  Brain,
  Globe,
  MessageSquare,
  Mail,
  Users,
  CreditCard,
  Settings,
  GitBranch,
  Lock,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { fabricatorService } from '../services/fabricatorService';
import { integrationService, Integration } from '../services/integrationService';
import {
  datastoreService,
  DataStore,
  DATA_STORE_TYPE_META,
} from '../services/datastoreService';
import { useOrganization } from '../contexts/OrganizationContext';
import { getDataStoreOperationsForType } from './datastore-wizard-usage-utils';
import {
  buildPipelineToolPayload,
  PipelineResourceSelection,
} from './pipeline-wizard-utils';

// --- Icon mapping ---
const iconMap: Record<string, LucideIcon> = {
  Cloud, Database, BarChart3, FileText, Zap, Search, BookOpen, Layers,
  Share2, Clock, Key, Shield, Brain, Globe, MessageSquare, Mail,
  Users, CreditCard, Settings, GitBranch, Lock,
};
const getIconComponent = (iconName: string): LucideIcon => iconMap[iconName] || Zap;

// --- Wizard Steps ---
type WizardStep = 'select-input' | 'processing' | 'select-output' | 'configure' | 'review';

const STEPS: WizardStep[] = ['select-input', 'processing', 'select-output', 'configure', 'review'];

const STEP_LABELS: Record<WizardStep, string> = {
  'select-input': 'Input Source',
  processing: 'Processing Logic',
  'select-output': 'Output Destination',
  configure: 'Configure Tool',
  review: 'Review & Submit',
};

// --- Source type tab ---
type SourceTab = 'dataStore' | 'integration';

// --- Component Props ---
interface DataPipelineWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function DataPipelineWizard({ onComplete, onCancel }: DataPipelineWizardProps) {
  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || 'default';

  // Wizard navigation
  const [currentStep, setCurrentStep] = useState<WizardStep>('select-input');

  // Data loading
  const [dataStores, setDataStores] = useState<DataStore[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Input source state
  const [inputTab, setInputTab] = useState<SourceTab>('dataStore');
  const [selectedInputDS, setSelectedInputDS] = useState<DataStore | null>(null);
  const [selectedInputInt, setSelectedInputInt] = useState<Integration | null>(null);
  const [inputOperations, setInputOperations] = useState<string[]>([]);

  // Processing logic
  const [processingLogic, setProcessingLogic] = useState('');

  // Output destination state
  const [outputTab, setOutputTab] = useState<SourceTab>('dataStore');
  const [selectedOutputDS, setSelectedOutputDS] = useState<DataStore | null>(null);
  const [selectedOutputInt, setSelectedOutputInt] = useState<Integration | null>(null);
  const [outputOperations, setOutputOperations] = useState<string[]>([]);

  // Tool config
  const [toolName, setToolName] = useState('');
  const [toolDescription, setToolDescription] = useState('');

  // Submission
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Same-resource warning
  const [sameResourceConfirmed, setSameResourceConfirmed] = useState(false);

  // Load data on mount
  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setLoadError(null);

        // Load data stores and integrations independently so one failure doesn't block the other
        let ds: DataStore[] = [];
        let ints: Integration[] = [];

        const [dsResult, intsResult] = await Promise.allSettled([
          datastoreService.listDataStores(orgId),
          integrationService.getConnectedIntegrations(),
        ]);

        if (dsResult.status === 'fulfilled') {
          ds = dsResult.value.filter((d) => d.status === 'CONNECTED');
        } else {
          console.warn('Failed to load data stores:', dsResult.reason);
        }

        if (intsResult.status === 'fulfilled') {
          ints = intsResult.value;
        } else {
          console.warn('Failed to load integrations:', intsResult.reason);
        }

        setDataStores(ds);
        setIntegrations(ints);

        // Only show error if both failed
        if (dsResult.status === 'rejected' && intsResult.status === 'rejected') {
          setLoadError('Failed to load data stores and integrations. Check your connection and try again.');
        }
      } catch (err: any) {
        setLoadError(err.message || 'Failed to load resources');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [orgId]);

  // --- Helpers ---
  const getInputSelection = (): PipelineResourceSelection | null => {
    if (inputTab === 'dataStore' && selectedInputDS) {
      return {
        kind: 'dataStore',
        id: selectedInputDS.dataStoreId,
        type: selectedInputDS.type,
        operations: inputOperations,
      };
    }
    if (inputTab === 'integration' && selectedInputInt) {
      return {
        kind: 'integration',
        id: selectedInputInt.id,
        type: selectedInputInt.name.toUpperCase().replace(/\s+/g, '_'),
        operations: inputOperations,
      };
    }
    return null;
  };

  const getOutputSelection = (): PipelineResourceSelection | null => {
    if (outputTab === 'dataStore' && selectedOutputDS) {
      return {
        kind: 'dataStore',
        id: selectedOutputDS.dataStoreId,
        type: selectedOutputDS.type,
        operations: outputOperations,
      };
    }
    if (outputTab === 'integration' && selectedOutputInt) {
      return {
        kind: 'integration',
        id: selectedOutputInt.id,
        type: selectedOutputInt.name.toUpperCase().replace(/\s+/g, '_'),
        operations: outputOperations,
      };
    }
    return null;
  };

  const isSameResource = (): boolean => {
    const input = getInputSelection();
    const output = getOutputSelection();
    if (!input || !output) return false;
    return input.kind === output.kind && input.id === output.id;
  };

  const getInputLabel = (): string => {
    if (inputTab === 'dataStore' && selectedInputDS) return selectedInputDS.name;
    if (inputTab === 'integration' && selectedInputInt) return selectedInputInt.name;
    return '';
  };

  const getOutputLabel = (): string => {
    if (outputTab === 'dataStore' && selectedOutputDS) return selectedOutputDS.name;
    if (outputTab === 'integration' && selectedOutputInt) return selectedOutputInt.name;
    return '';
  };

  // Navigation
  const currentStepIndex = STEPS.indexOf(currentStep);
  const goNext = () => {
    if (currentStepIndex < STEPS.length - 1) setCurrentStep(STEPS[currentStepIndex + 1]);
  };
  const goBack = () => {
    if (currentStepIndex > 0) setCurrentStep(STEPS[currentStepIndex - 1]);
  };

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 'select-input':
        return getInputSelection() !== null && inputOperations.length > 0;
      case 'processing':
        return processingLogic.trim().length > 0;
      case 'select-output': {
        if (getOutputSelection() === null || outputOperations.length === 0) return false;
        if (isSameResource() && !sameResourceConfirmed) return false;
        return true;
      }
      case 'configure':
        return toolName.trim().length > 0 && toolDescription.trim().length > 0;
      case 'review':
        return true;
      default:
        return false;
    }
  };

  const toggleInputOp = (op: string) => {
    setInputOperations((prev) =>
      prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op],
    );
  };

  const toggleOutputOp = (op: string) => {
    setOutputOperations((prev) =>
      prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op],
    );
  };

  // Submit
  const handleSubmit = async () => {
    const input = getInputSelection();
    const output = getOutputSelection();
    if (!input || !output) return;

    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const payload = buildPipelineToolPayload({
        toolName: toolName.trim(),
        toolDescription: toolDescription.trim(),
        processingLogic: processingLogic.trim(),
        inputSource: input,
        outputDestination: output,
      });

      await fabricatorService.requestToolCreation(payload);
      onComplete();
    } catch (err: any) {
      console.error('Failed to create pipeline tool:', err);
      setSubmitError(err.message || 'Failed to create pipeline tool. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Available operations for data store types
  const getOpsForDS = (ds: DataStore) => getDataStoreOperationsForType(ds.type);

  // --- Render helpers ---
  const renderDataStoreCard = (
    ds: DataStore,
    isSelected: boolean,
    onSelect: () => void,
  ) => {
    const meta = DATA_STORE_TYPE_META[ds.type];
    const Icon = getIconComponent(meta?.icon || ds.icon || 'Database');
    return (
      <button
        key={ds.dataStoreId}
        type="button"
        onClick={onSelect}
        className={`relative flex items-start gap-3 p-4 rounded-lg border transition-all text-left ${
          isSelected
            ? 'bg-primary/10 border-primary'
            : 'bg-card border-border hover:border-input'
        }`}
      >
        <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary/20' : 'bg-accent'}`}>
          <Icon className={`size-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-foreground text-sm font-medium truncate">{ds.name}</h4>
            {isSelected && <Check className="size-4 text-primary shrink-0" />}
          </div>
          <p className="text-muted-foreground text-xs mt-0.5 line-clamp-2">{ds.description || ds.type}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">{ds.type}</Badge>
            <Badge variant="secondary" className="text-xs bg-chart-2/10 text-chart-2 border-chart-2/30">{ds.status}</Badge>
          </div>
        </div>
      </button>
    );
  };

  const renderIntegrationCard = (
    int: Integration,
    isSelected: boolean,
    onSelect: () => void,
  ) => {
    const Icon = getIconComponent(int.icon);
    return (
      <button
        key={int.id}
        type="button"
        onClick={onSelect}
        className={`relative flex items-start gap-3 p-4 rounded-lg border transition-all text-left ${
          isSelected
            ? 'bg-primary/10 border-primary'
            : 'bg-card border-border hover:border-input'
        }`}
      >
        <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary/20' : 'bg-accent'}`}>
          <Icon className={`size-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-foreground text-sm font-medium truncate">{int.name}</h4>
            {isSelected && <Check className="size-4 text-primary shrink-0" />}
          </div>
          <p className="text-muted-foreground text-xs mt-0.5 line-clamp-2">{int.description}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">{int.category}</Badge>
            <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">{int.provider}</Badge>
          </div>
        </div>
      </button>
    );
  };

  const renderOperationCheckboxes = (
    operations: string[],
    selectedOps: string[],
    toggleOp: (op: string) => void,
  ) => (
    <div className="flex flex-col gap-2 mt-4">
      <Label className="text-foreground text-sm">Select Operations</Label>
      <div className="flex flex-col gap-2">
        {operations.map((op) => (
          <label
            key={op}
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
              selectedOps.includes(op)
                ? 'bg-primary/10 border-primary'
                : 'bg-card border-border hover:border-input'
            }`}
          >
            <Checkbox
              checked={selectedOps.includes(op)}
              onCheckedChange={() => toggleOp(op)}
            />
            <span className="text-foreground text-sm font-mono">{op}</span>
          </label>
        ))}
      </div>
    </div>
  );

  // --- Main Render ---
  if (loading) {
    return (
      <div className="min-h-screen bg-card p-6">
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-8 text-primary animate-spin" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-card p-6">
        <Button variant="ghost" className="text-muted-foreground hover:text-foreground mb-4" onClick={onCancel}>
          <ArrowLeft className="size-4 mr-2" /> Back to Tools
        </Button>
        <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
          <p className="text-destructive">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-card p-6">
      {/* Header */}
      <div className="mb-6">
        <Button variant="ghost" className="text-muted-foreground hover:text-foreground mb-4" onClick={onCancel}>
          <ArrowLeft className="size-4 mr-2" /> Back to Tools
        </Button>
        <div className="flex items-center gap-3">
          <div className="size-12 rounded-lg bg-accent border border-border flex items-center justify-center">
            <Layers className="size-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Build an Agent Tool</h1>
            <p className="text-muted-foreground text-sm">Configure an input source, processing logic, and output destination</p>
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
                <div className={`size-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${
                  isCompleted ? 'bg-primary text-foreground'
                    : isActive ? 'bg-primary/20 text-primary border border-primary'
                    : 'bg-accent text-muted-foreground border border-border'
                }`}>
                  {isCompleted ? <Check className="size-4" /> : idx + 1}
                </div>
                <span className={`text-xs hidden sm:inline ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {STEP_LABELS[step]}
                </span>
                {idx < STEPS.length - 1 && (
                  <div className={`flex-1 h-px ${isCompleted ? 'bg-primary' : 'bg-accent'}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step Content */}
      <div className="max-w-3xl">
        {/* Step 1: Select Input Source */}
        {currentStep === 'select-input' && (
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Select Input Source</CardTitle>
              <CardDescription className="text-muted-foreground">
                Choose a data store or integration to read data from
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Tab selector */}
              <div className="flex gap-2 mb-4">
                <Button
                  variant={inputTab === 'dataStore' ? 'default' : 'outline'}
                  size="sm"
                  className={inputTab === 'dataStore' ? 'bg-primary text-foreground' : 'border-border text-muted-foreground'}
                  onClick={() => { setInputTab('dataStore'); setSelectedInputInt(null); setInputOperations([]); }}
                >
                  <Database className="size-4 mr-1" /> Data Store
                </Button>
                <Button
                  variant={inputTab === 'integration' ? 'default' : 'outline'}
                  size="sm"
                  className={inputTab === 'integration' ? 'bg-primary text-foreground' : 'border-border text-muted-foreground'}
                  onClick={() => { setInputTab('integration'); setSelectedInputDS(null); setInputOperations([]); }}
                >
                  <Cloud className="size-4 mr-1" /> Integration
                </Button>
              </div>

              {inputTab === 'dataStore' ? (
                <>
                  {dataStores.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-8">No connected data stores available.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {dataStores.map((ds) =>
                        renderDataStoreCard(ds, selectedInputDS?.dataStoreId === ds.dataStoreId, () => {
                          setSelectedInputDS(ds);
                          setInputOperations([]);
                        }),
                      )}
                    </div>
                  )}
                  {selectedInputDS && renderOperationCheckboxes(
                    getOpsForDS(selectedInputDS),
                    inputOperations,
                    toggleInputOp,
                  )}
                </>
              ) : (
                <>
                  {integrations.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-8">No connected integrations available.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {integrations.map((int) =>
                        renderIntegrationCard(int, selectedInputInt?.id === int.id, () => {
                          setSelectedInputInt(int);
                          setInputOperations([]);
                        }),
                      )}
                    </div>
                  )}
                  {selectedInputInt && renderOperationCheckboxes(
                    ['read', 'query', 'list', 'search', 'fetch'],
                    inputOperations,
                    toggleInputOp,
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 2: Processing Logic */}
        {currentStep === 'processing' && (
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Describe Processing Logic</CardTitle>
              <CardDescription className="text-muted-foreground">
                Describe how data should be transformed between input and output
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="bg-card border border-border rounded-lg p-3">
                  <p className="text-muted-foreground text-xs">
                    Input: <span className="text-foreground font-medium">{getInputLabel()}</span>
                    {' → '}
                    Processing
                    {' → '}
                    Output
                  </p>
                </div>
                <Textarea
                  placeholder="e.g., Filter records where status is active, transform to CSV format, and aggregate by region"
                  value={processingLogic}
                  onChange={(e) => setProcessingLogic(e.target.value)}
                  className="bg-card border-border text-foreground placeholder:text-muted-foreground min-h-[160px]"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Select Output Destination */}
        {currentStep === 'select-output' && (
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Select Output Destination</CardTitle>
              <CardDescription className="text-muted-foreground">
                Choose a data store or integration to write data to
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Tab selector */}
              <div className="flex gap-2 mb-4">
                <Button
                  variant={outputTab === 'dataStore' ? 'default' : 'outline'}
                  size="sm"
                  className={outputTab === 'dataStore' ? 'bg-primary text-foreground' : 'border-border text-muted-foreground'}
                  onClick={() => { setOutputTab('dataStore'); setSelectedOutputInt(null); setOutputOperations([]); }}
                >
                  <Database className="size-4 mr-1" /> Data Store
                </Button>
                <Button
                  variant={outputTab === 'integration' ? 'default' : 'outline'}
                  size="sm"
                  className={outputTab === 'integration' ? 'bg-primary text-foreground' : 'border-border text-muted-foreground'}
                  onClick={() => { setOutputTab('integration'); setSelectedOutputDS(null); setOutputOperations([]); }}
                >
                  <Cloud className="size-4 mr-1" /> Integration
                </Button>
              </div>

              {outputTab === 'dataStore' ? (
                <>
                  {dataStores.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-8">No connected data stores available.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {dataStores.map((ds) =>
                        renderDataStoreCard(ds, selectedOutputDS?.dataStoreId === ds.dataStoreId, () => {
                          setSelectedOutputDS(ds);
                          setOutputOperations([]);
                          setSameResourceConfirmed(false);
                        }),
                      )}
                    </div>
                  )}
                  {selectedOutputDS && renderOperationCheckboxes(
                    getOpsForDS(selectedOutputDS),
                    outputOperations,
                    toggleOutputOp,
                  )}
                </>
              ) : (
                <>
                  {integrations.length === 0 ? (
                    <p className="text-muted-foreground text-sm text-center py-8">No connected integrations available.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {integrations.map((int) =>
                        renderIntegrationCard(int, selectedOutputInt?.id === int.id, () => {
                          setSelectedOutputInt(int);
                          setOutputOperations([]);
                          setSameResourceConfirmed(false);
                        }),
                      )}
                    </div>
                  )}
                  {selectedOutputInt && renderOperationCheckboxes(
                    ['write', 'create', 'update', 'send', 'publish'],
                    outputOperations,
                    toggleOutputOp,
                  )}
                </>
              )}

              {/* Same resource warning */}
              {isSameResource() && (
                <div className="mt-4 bg-chart-4/10 border border-chart-4/30 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="size-5 text-chart-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-chart-4 text-sm">
                        Input and output are the same resource. This creates a circular binding.
                      </p>
                      <label className="flex items-center gap-2 mt-2 cursor-pointer">
                        <Checkbox
                          checked={sameResourceConfirmed}
                          onCheckedChange={(checked: boolean) => setSameResourceConfirmed(!!checked)}
                        />
                        <span className="text-chart-4 text-xs">I understand and want to proceed</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 4: Configure */}
        {currentStep === 'configure' && (
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Configure Tool</CardTitle>
              <CardDescription className="text-muted-foreground">Set a name and description for this Agent Tool</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <Label htmlFor="pipeline-tool-name" className="text-foreground">
                  Tool Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="pipeline-tool-name"
                  placeholder="e.g., s3_to_dynamodb_pipeline"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  className="bg-card border-border text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">Use snake_case for the tool function name</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="pipeline-tool-desc" className="text-foreground">
                  Tool Description <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="pipeline-tool-desc"
                  placeholder="Describe what this pipeline tool does"
                  value={toolDescription}
                  onChange={(e) => setToolDescription(e.target.value)}
                  className="bg-card border-border text-foreground placeholder:text-muted-foreground min-h-[120px]"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 5: Review & Submit */}
        {currentStep === 'review' && (
          <Card className="bg-accent border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Review & Submit</CardTitle>
              <CardDescription className="text-muted-foreground">Confirm the configuration</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {/* Visual flow summary */}
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-center gap-3 text-sm">
                  <div className="bg-primary/10 border border-primary/30 rounded-lg px-3 py-2 text-primary">
                    ← {getInputLabel()}
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <div className="bg-chart-5/10 border border-chart-5/30 rounded-lg px-3 py-2 text-chart-5 flex-1 text-center truncate">
                    {processingLogic.slice(0, 60)}{processingLogic.length > 60 ? '...' : ''}
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <div className="bg-chart-2/10 border border-chart-2/30 rounded-lg px-3 py-2 text-chart-2">
                    → {getOutputLabel()}
                  </div>
                </div>
              </div>

              {/* Tool details */}
              <div>
                <Label className="text-muted-foreground text-xs uppercase tracking-wider">Tool Name</Label>
                <p className="mt-1 text-foreground font-mono">{toolName}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs uppercase tracking-wider">Description</Label>
                <p className="mt-1 text-muted-foreground text-sm whitespace-pre-wrap">{toolDescription}</p>
              </div>

              {/* Input binding */}
              <div className="bg-card border border-border rounded-lg p-4">
                <h4 className="text-foreground text-sm font-medium mb-2">Input Binding (← Input)</h4>
                <div className="flex flex-col text-xs text-muted-foreground gap-1">
                  <p><span className="text-muted-foreground">Source:</span> {getInputLabel()}</p>
                  <p><span className="text-muted-foreground">Type:</span> {getInputSelection()?.type}</p>
                  <p><span className="text-muted-foreground">Operations:</span> {inputOperations.join(', ')}</p>
                  <p><span className="text-muted-foreground">Direction:</span> ← Input</p>
                </div>
              </div>

              {/* Output binding */}
              <div className="bg-card border border-border rounded-lg p-4">
                <h4 className="text-foreground text-sm font-medium mb-2">Output Binding (→ Output)</h4>
                <div className="flex flex-col text-xs text-muted-foreground gap-1">
                  <p><span className="text-muted-foreground">Destination:</span> {getOutputLabel()}</p>
                  <p><span className="text-muted-foreground">Type:</span> {getOutputSelection()?.type}</p>
                  <p><span className="text-muted-foreground">Operations:</span> {outputOperations.join(', ')}</p>
                  <p><span className="text-muted-foreground">Direction:</span> → Output</p>
                </div>
              </div>

              {/* Processing logic */}
              <div>
                <Label className="text-muted-foreground text-xs uppercase tracking-wider">Processing Logic</Label>
                <p className="mt-1 text-muted-foreground text-sm whitespace-pre-wrap">{processingLogic}</p>
              </div>

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
          >
            <ArrowLeft className="size-4 mr-2" />
            {currentStepIndex === 0 ? 'Cancel' : 'Back'}
          </Button>

          {currentStep === 'review' ? (
            <Button
              className="bg-primary text-foreground hover:bg-primary/90"
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <><Loader2 className="size-4 mr-2 animate-spin" /> Creating...</>
              ) : (
                <><Check className="size-4 mr-2" /> Create Agent Tool</>
              )}
            </Button>
          ) : (
            <Button
              className="bg-primary text-foreground hover:bg-primary/90"
              onClick={goNext}
              disabled={!canGoNext()}
            >
              Next <ArrowRight className="size-4 ml-2" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
