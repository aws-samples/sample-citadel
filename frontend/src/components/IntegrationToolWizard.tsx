import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Check,
  AlertCircle,
  Wrench,
  LucideIcon,
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
import {
  integrationService,
  Integration,
} from '../services/integrationService';
import { BindingDirection } from '../services/toolConfigService';
import serverService from '../services/server';

// --- Direction options ---
const DIRECTION_LABELS: Record<BindingDirection, string> = {
  INPUT: '← Input',
  OUTPUT: '→ Output',
  BIDIRECTIONAL: '↔ Bidirectional',
};

// --- AgentCore types that skip operation selection ---
const AGENTCORE_TYPES = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'];

// --- Operation descriptor from the Operations Registry ---
interface IntegrationOperation {
  operationId: string;
  name: string;
  description: string;
  method: string;
  parameters: OperationParameter[];
}

interface OperationParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

// --- GraphQL query for fetching operations ---
const listIntegrationOperationsQuery = `
  query ListIntegrationOperations($integrationType: String!) {
    listIntegrationOperations(integrationType: $integrationType) {
      operationId
      name
      description
      method
      parameters {
        name
        type
        required
        description
      }
    }
  }
`;

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
  MessageSquare,
  Mail,
  Users,
  CreditCard,
  Settings,
  GitBranch,
  Lock,
};

const getIconComponent = (iconName: string): LucideIcon => {
  return iconMap[iconName] || Zap;
};

// --- Wizard Steps ---
type WizardStep = 'select-integration' | 'select-operations' | 'configure' | 'review';

const STEPS: WizardStep[] = ['select-integration', 'select-operations', 'configure', 'review'];

const STEP_LABELS: Record<WizardStep, string> = {
  'select-integration': 'Select Integration',
  'select-operations': 'Select Operations',
  configure: 'Configure Tool',
  review: 'Review & Submit',
};

// --- Component Props ---
interface IntegrationToolWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function IntegrationToolWizard({ onComplete, onCancel }: IntegrationToolWizardProps) {
  // Wizard state
  const [currentStep, setCurrentStep] = useState<WizardStep>('select-integration');
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selection state
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  const [availableOperations, setAvailableOperations] = useState<IntegrationOperation[]>([]);
  const [selectedOperationIds, setSelectedOperationIds] = useState<string[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [toolName, setToolName] = useState('');
  const [toolDescription, setToolDescription] = useState('');
  const [bindingDirection, setBindingDirection] = useState<BindingDirection>('BIDIRECTIONAL');

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Determine if selected integration is an AgentCore type
  const isAgentCoreType = selectedIntegration
    ? AGENTCORE_TYPES.some((t) => selectedIntegration.name.toUpperCase().includes(t.replace('_', ' ')) || selectedIntegration.category === 'agentcore')
    : false;

  // Compute effective steps — skip operations for AgentCore types
  const effectiveSteps = isAgentCoreType
    ? STEPS.filter((s) => s !== 'select-operations')
    : STEPS;

  // Load connected integrations on mount
  useEffect(() => {
    const loadIntegrations = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const connected = await integrationService.getConnectedIntegrations();
        setIntegrations(connected);
      } catch (err: any) {
        console.error('Failed to load integrations:', err);
        setLoadError(err.message || 'Failed to load integrations');
      } finally {
        setLoading(false);
      }
    };
    loadIntegrations();
  }, []);

  // Fetch operations when an integration is selected (non-AgentCore)
  useEffect(() => {
    if (!selectedIntegration || isAgentCoreType) {
      setAvailableOperations([]);
      return;
    }

    const fetchOperations = async () => {
      try {
        setOperationsLoading(true);
        setOperationsError(null);
        const response = await serverService.query<{
          listIntegrationOperations: IntegrationOperation[];
        }>(listIntegrationOperationsQuery, {
          integrationType: selectedIntegration.name.toUpperCase().replace(/\s+/g, '_'),
        });
        setAvailableOperations(response.listIntegrationOperations || []);
      } catch (err: any) {
        console.error('Failed to load operations:', err);
        // Req 10.9: Operations Registry failure isolation — show message, don't block
        setOperationsError('Could not load operations for this integration type. You can still create a generic tool.');
        setAvailableOperations([]);
      } finally {
        setOperationsLoading(false);
      }
    };
    fetchOperations();
  }, [selectedIntegration, isAgentCoreType]);

  // Navigation helpers
  const currentStepIndex = effectiveSteps.indexOf(currentStep);

  const goNext = () => {
    if (currentStepIndex < effectiveSteps.length - 1) {
      setCurrentStep(effectiveSteps[currentStepIndex + 1]);
    }
  };

  const goBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(effectiveSteps[currentStepIndex - 1]);
    }
  };

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 'select-integration':
        return selectedIntegration !== null;
      case 'select-operations':
        // Allow proceeding with no operations if registry returned empty (Req 10.9)
        return selectedOperationIds.length > 0 || availableOperations.length === 0;
      case 'configure':
        return toolName.trim().length > 0 && toolDescription.trim().length > 0;
      case 'review':
        return true;
      default:
        return false;
    }
  };

  // Operation toggle
  const toggleOperation = (opId: string) => {
    setSelectedOperationIds((prev) =>
      prev.includes(opId) ? prev.filter((o) => o !== opId) : [...prev, opId]
    );
  };

  // Integration selection
  const handleSelectIntegration = (integration: Integration) => {
    setSelectedIntegration(integration);
    setSelectedOperationIds([]);
    setAvailableOperations([]);
    setOperationsError(null);
  };

  // Submit handler
  const handleSubmit = async () => {
    if (!selectedIntegration) return;

    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const integrationType = selectedIntegration.name.toUpperCase().replace(/\s+/g, '_');

      const enhancedDescription = [
        toolDescription.trim(),
        `\nIntegration Type: ${integrationType}`,
        selectedOperationIds.length > 0
          ? `Operations: ${selectedOperationIds.join(', ')}`
          : 'Operations: dynamic discovery',
        `Provider: ${selectedIntegration.provider}`,
      ].join('\n');

      await fabricatorService.requestToolCreation({
        toolName: toolName.trim(),
        toolDescription: enhancedDescription,
        integrationBindings: [
          {
            integrationId: selectedIntegration.id,
            integrationType,
            operations: selectedOperationIds,
            direction: bindingDirection,
          },
        ],
      });

      onComplete();
    } catch (err: any) {
      console.error('Failed to create integration tool:', err);
      setSubmitError(err.message || 'Failed to create tool. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- No connected integrations ---
  if (!loading && !loadError && integrations.length === 0) {
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
          <h2 className="text-xl font-semibold text-foreground mb-3">No Connected Integrations</h2>
          <p className="text-muted-foreground mb-6">
            You need at least one connected integration to create an integration tool.
            Visit the Integrations page to connect an integration first.
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
            <Zap className="size-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Wrap an Integration</h1>
            <p className="text-muted-foreground text-sm">
              Create a tool that wraps access to a connected integration
            </p>
          </div>
        </div>
      </div>

      {/* Step Indicator */}
      <div className="max-w-3xl mb-8">
        <div className="flex items-center gap-2">
          {effectiveSteps.map((step, idx) => {
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
                {idx < effectiveSteps.length - 1 && (
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
            {/* Step 1: Select Integration */}
            {currentStep === 'select-integration' && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Select an Integration</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Choose a connected integration to wrap with a tool
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {integrations.map((integration) => {
                      const Icon = getIconComponent(integration.icon);
                      const isSelected = selectedIntegration?.id === integration.id;

                      return (
                        <button
                          key={integration.id}
                          type="button"
                          onClick={() => handleSelectIntegration(integration)}
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
                              <h4 className="text-foreground text-sm font-medium truncate">{integration.name}</h4>
                              {isSelected && <Check className="size-4 text-primary shrink-0" />}
                            </div>
                            <p className="text-muted-foreground text-xs mt-0.5 line-clamp-2">
                              {integration.description}
                            </p>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                                {integration.category}
                              </Badge>
                              <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                                {integration.provider}
                              </Badge>
                              {integration.protocol && (
                                <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                                  {integration.protocol}
                                </Badge>
                              )}
                              <Badge variant="secondary" className="text-xs bg-chart-2/10 text-chart-2 border-chart-2/30">
                                {integration.status}
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

            {/* Step 2: Select Operations (skipped for AgentCore types) */}
            {currentStep === 'select-operations' && selectedIntegration && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Select Operations</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Choose which operations the tool should support for{' '}
                    <span className="text-foreground font-medium">{selectedIntegration.name}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {operationsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-6 text-primary animate-spin" />
                    </div>
                  ) : operationsError ? (
                    <div className="bg-chart-4/10 border border-chart-4/30 rounded-lg p-4 mb-4">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="size-5 text-chart-4 shrink-0 mt-0.5" />
                        <p className="text-chart-4 text-sm">{operationsError}</p>
                      </div>
                    </div>
                  ) : availableOperations.length === 0 ? (
                    <div className="bg-card border border-border rounded-lg p-4 text-center">
                      <p className="text-muted-foreground text-sm">
                        No operations available for this integration type. A generic tool will be created.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col gap-3">
                        {availableOperations.map((op) => {
                          const isChecked = selectedOperationIds.includes(op.operationId);
                          return (
                            <label
                              key={op.operationId}
                              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                isChecked
                                  ? 'bg-primary/10 border-primary'
                                  : 'bg-card border-border hover:border-input'
                              }`}
                            >
                              <Checkbox
                                checked={isChecked}
                                onCheckedChange={() => toggleOperation(op.operationId)}
                                className="mt-0.5"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-foreground text-sm font-medium">{op.name}</span>
                                  <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border font-mono">
                                    {op.method}
                                  </Badge>
                                </div>
                                <p className="text-muted-foreground text-xs mt-1">{op.description}</p>
                                {op.parameters.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {op.parameters.map((param) => (
                                      <Badge
                                        key={param.name}
                                        variant="secondary"
                                        className={`text-xs font-mono ${
                                          param.required
                                            ? 'bg-primary/10 text-primary border-primary/30'
                                            : 'bg-card text-muted-foreground border-border'
                                        }`}
                                      >
                                        {param.name}{param.required ? '*' : ''}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-foreground text-xs"
                          onClick={() => setSelectedOperationIds(availableOperations.map((o) => o.operationId))}
                        >
                          Select All
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-foreground text-xs"
                          onClick={() => setSelectedOperationIds([])}
                        >
                          Clear All
                        </Button>
                      </div>

                      {/* Direction selector */}
                      <div className="mt-6 pt-4 border-t border-border">
                        <Label className="text-foreground text-sm mb-2 block">Binding Direction</Label>
                        <p className="text-muted-foreground text-xs mb-3">
                          Specify how this tool uses the integration
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
                    </>
                  )}
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
                    <Label htmlFor="int-tool-name" className="text-foreground">
                      Tool Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="int-tool-name"
                      placeholder="e.g., search_confluence, send_slack_message"
                      value={toolName}
                      onChange={(e) => setToolName(e.target.value)}
                      className="bg-card border-border text-foreground placeholder:text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">Use snake_case for the tool function name</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="int-tool-desc" className="text-foreground">
                      Tool Description <span className="text-destructive">*</span>
                    </Label>
                    <Textarea
                      id="int-tool-desc"
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
            {currentStep === 'review' && selectedIntegration && (
              <Card className="bg-accent border-border">
                <CardHeader>
                  <CardTitle className="text-foreground">Review & Submit</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Confirm the details before creating the tool
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  {/* Integration */}
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wider">Integration</Label>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-foreground font-medium">{selectedIntegration.name}</span>
                      <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                        {selectedIntegration.provider}
                      </Badge>
                      {selectedIntegration.protocol && (
                        <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                          {selectedIntegration.protocol}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Operations */}
                  <div>
                    <Label className="text-muted-foreground text-xs uppercase tracking-wider">Operations</Label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {selectedOperationIds.length > 0 ? (
                        selectedOperationIds.map((opId) => (
                          <Badge key={opId} variant="secondary" className="text-xs bg-card text-foreground border-border font-mono">
                            {opId}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-sm italic">
                          {isAgentCoreType ? 'Dynamic discovery (AgentCore)' : 'No operations selected'}
                        </span>
                      )}
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
                    <h4 className="text-foreground text-sm font-medium mb-2">Integration Binding</h4>
                    <div className="flex flex-col text-xs text-muted-foreground gap-1">
                      <p>
                        <span className="text-muted-foreground">ID:</span> {selectedIntegration.id}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Type:</span>{' '}
                        {selectedIntegration.name.toUpperCase().replace(/\s+/g, '_')}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Operations:</span>{' '}
                        {selectedOperationIds.length > 0 ? selectedOperationIds.join(', ') : 'dynamic'}
                      </p>
                      <p>
                        <span className="text-muted-foreground">Direction:</span> {DIRECTION_LABELS[bindingDirection]}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-3">
                      This binding ensures the agent receives scoped credentials for this integration at runtime.
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
