import { useState, useEffect } from 'react';
import { ArrowLeft, Check, Wrench, Cloud, Database, HelpCircle, BookOpen, Layers, FileText, Brain, BarChart3, Search, Share2, Clock, Zap, Key, Shield, Globe, LucideIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Card, CardDescription, CardHeader, CardTitle } from './ui/card';
import { toolConfigService, ToolConfig } from '../services/toolConfigService';
import { fabricatorService } from '../services/fabricatorService';
import { datastoreService, DataStore, DataStoreStatus, DataStoreCategory, DataStoreUsage } from '../services/datastoreService';
import { toast } from 'sonner';
import { integrationServiceBackend } from '../services/integrationServiceBackend';
import { getConnectorDefinition } from '../config/connectorRegistry';
import { useOrganization } from '../contexts/OrganizationContext';
import { computeAutoSelectedResources } from './agent-wizard-utils';
import './CreateAgentWizard.css';

// --- Data store icon mapping (mirrors DataStores.tsx) ---
const dsIconMap: Record<string, LucideIcon> = {
  BookOpen, Database, Layers, FileText, Cloud, Brain, BarChart3, Search, Share2, Clock, Zap, Key, Shield, Globe,
};
const getDsIcon = (iconName: string): LucideIcon => dsIconMap[iconName] || Database;

const categoryBadgeColors: Record<string, string> = {
  [DataStoreCategory.KNOWLEDGE_BASE]: "bg-transparent text-primary border border-primary/50",
  [DataStoreCategory.NOSQL_DATABASE]: "bg-transparent text-chart-2 border border-chart-2/50",
  [DataStoreCategory.RELATIONAL_DATABASE]: "bg-transparent text-chart-2 border border-chart-2/50",
  [DataStoreCategory.S3_STORAGE]: "bg-transparent text-chart-4 border border-chart-4/50",
  [DataStoreCategory.DATA_WAREHOUSE]: "bg-transparent text-chart-5 border border-chart-5/50",
  [DataStoreCategory.DATA_LAKE]: "bg-transparent text-chart-5 border border-chart-5/50",
  [DataStoreCategory.SEARCH_ENGINE]: "bg-transparent text-chart-3 border border-chart-3/50",
  [DataStoreCategory.GRAPH_DATABASE]: "bg-transparent text-indigo-400 border border-indigo-500/50",
  [DataStoreCategory.TIME_SERIES]: "bg-transparent text-chart-4 border border-chart-4/50",
  [DataStoreCategory.DOCUMENT_DATABASE]: "bg-transparent text-teal-400 border border-teal-500/50",
  [DataStoreCategory.CACHE]: "bg-transparent text-pink-400 border border-pink-500/50",
  [DataStoreCategory.EXTERNAL]: "bg-transparent text-muted-foreground border border-border",
};

const usageBadgeColors: Record<string, string> = {
  [DataStoreUsage.KNOWLEDGE]: "bg-transparent text-primary border border-primary/50",
  [DataStoreUsage.OPERATIONAL]: "bg-transparent text-amber-300 border border-amber-400/50",
};

const usageLabels: Record<string, string> = {
  [DataStoreUsage.KNOWLEDGE]: "Knowledge",
  [DataStoreUsage.OPERATIONAL]: "Operational",
};

interface CreateAgentWizardProps {
  onBack: () => void;
  onComplete: () => void;
  onRequestSubmitted?: (requestId: string, agentName: string, taskDescription: string) => void;
}

type Step = 'details' | 'tools' | 'integrations' | 'datastores' | 'review';

export function CreateAgentWizard({ onBack, onComplete, onRequestSubmitted }: CreateAgentWizardProps) {
  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || 'default';
  const [currentStep, setCurrentStep] = useState<Step>('details');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showToolsInfoModal, setShowToolsInfoModal] = useState(false);

  // Form data
  const [agentName, setAgentName] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [selectedIntegrations, setSelectedIntegrations] = useState<string[]>([]);
  const [selectedDataStores, setSelectedDataStores] = useState<string[]>([]);

  // Available options
  const [availableTools, setAvailableTools] = useState<ToolConfig[]>([]);
  const [availableIntegrations, setAvailableIntegrations] = useState<any[]>([]);
  const [availableDataStores, setAvailableDataStores] = useState<DataStore[]>([]);

  useEffect(() => {
    loadOptions(orgId);
  }, [orgId]);

  const loadOptions = async (currentOrgId: string) => {
    try {
      setLoading(true);
      // Load tools from the tools config table
      const [tools, integrations, dataStores] = await Promise.all([
        toolConfigService.listToolConfigs(),
        integrationServiceBackend.listIntegrations(currentOrgId, 'CONNECTED'),
        datastoreService.listDataStores(currentOrgId),
      ]);
      setAvailableTools(tools.filter(t => t.state === 'active'));

      setAvailableIntegrations(integrations.map(b => {
        const def = getConnectorDefinition(b.integrationType as any);
        return {
          id: b.integrationId,
          name: def?.name ?? b.name ?? b.integrationType,
          description: def?.description ?? `${b.integrationType} integration`,
          integrationType: b.integrationType,
          icon: def?.icon,
        };
      }));

      setAvailableDataStores(dataStores.filter(ds => ds.status === DataStoreStatus.CONNECTED));
    } catch (err: any) {
      console.error('Failed to load options:', err);
      setError(err.message || 'Failed to load options');
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { id: 'details', label: 'Agent Details', icon: Check },
    { id: 'tools', label: 'Select Tools', icon: Wrench },
    { id: 'datastores', label: 'Data Stores & Integrations', icon: Database },
    { id: 'review', label: 'Review & Create', icon: Check },
  ];

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  const handleNext = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < steps.length) {
      const nextStep = steps[nextIndex].id as Step;
      // Auto-select data stores and integrations from tool bindings when entering the datastores step
      if (nextStep === 'datastores') {
        const autoSelected = computeAutoSelectedResources(selectedTools, availableTools);
        setSelectedDataStores((prev) => {
          const merged = new Set([...prev, ...autoSelected.dataStoreIds]);
          return Array.from(merged);
        });
        setSelectedIntegrations((prev) => {
          const merged = new Set([...prev, ...autoSelected.integrationIds]);
          return Array.from(merged);
        });
      }
      setCurrentStep(nextStep);
    }
  };

  const handlePrevious = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(steps[prevIndex].id as Step);
    }
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);
      setError(null);

      // Send request to Fabricator agent via AppSync
      const response = await fabricatorService.requestAgentCreation({
        agentName,
        taskDescription,
        tools: selectedTools,
        integrations: selectedIntegrations,
        dataStores: selectedDataStores,
      });

      console.log('Fabricator response:', response);

      if (response.success) {
        // Notify parent component about the new request
        if (onRequestSubmitted) {
          onRequestSubmitted(response.requestId, agentName, taskDescription);
        }
        
        toast.info('Agent creation in progress', {
          description: `"${agentName}" has been sent to the Fabricator. Check the Fabrication queue for status.`,
          duration: 8000,
        });
        onComplete();
      } else {
        setError(response.message || 'Failed to send request to Fabricator');
      }
    } catch (err: any) {
      console.error('Failed to create agent:', err);
      setError(err.message || 'Failed to send request to Fabricator');
    } finally {
      setLoading(false);
    }
  };

  const toggleSelection = (id: string, list: string[], setList: (list: string[]) => void) => {
    if (list.includes(id)) {
      setList(list.filter(item => item !== id));
    } else {
      setList([...list, id]);
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 'details':
        return agentName.trim() !== '' && taskDescription.trim() !== '';
      case 'tools':
      case 'integrations':
      case 'datastores':
        return true; // Optional selections
      case 'review':
        return true;
      default:
        return false;
    }
  };

  return (
    <div className="create-agent-wizard">
      {/* Tools Info Modal */}
      <Dialog open={showToolsInfoModal} onOpenChange={setShowToolsInfoModal}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Community Tools</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 text-muted-foreground">
            <p>
              All agents automatically have access to the <strong className="text-foreground">Strand Community Tools Package</strong>, which includes a comprehensive set of built-in tools for common tasks.
            </p>
            <p>
              The tools you select here are <strong className="text-foreground">additional custom tools</strong> that extend your agent's capabilities beyond the community package.
            </p>
            <div className="bg-card border border-border rounded p-4 mt-4">
              <p className="text-sm mb-2">
                <strong className="text-foreground">Community tools include:</strong>
              </p>
              <ul className="flex flex-col text-sm gap-1 list-disc list-inside">
                <li>File operations</li>
                <li>Web search and browsing</li>
                <li>Code execution</li>
                <li>Data processing</li>
                <li>And many more...</li>
              </ul>
            </div>
            <a
              href="https://strandsagents.com/latest/documentation/docs/user-guide/concepts/tools/community-tools-package/#available-tools"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center text-primary hover:text-primary transition-colors text-sm mt-2"
            >
              View full list of community tools →
            </a>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowToolsInfoModal(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <div className="wizard-header">
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-foreground hover:bg-accent"
        >
          <ArrowLeft className="size-4 mr-2" />
          Back to Catalog
        </Button>
        <h1 className="wizard-title">Create New Agent</h1>
      </div>

      {/* Progress Steps */}
      <div className="wizard-steps">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const isActive = step.id === currentStep;
          const isCompleted = index < currentStepIndex;

          return (
            <div
              key={step.id}
              className={`wizard-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
            >
              <div className="step-icon">
                <Icon className="size-4" />
              </div>
              <span className="step-label">{step.label}</span>
            </div>
          );
        })}
      </div>

      {/* Error Message */}
      {error && (
        <div className="wizard-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Step Content */}
      <div className="wizard-content">
        {currentStep === 'details' && (
          <div className="step-content">
            <h2 className="step-title">Agent Details</h2>
            <p className="step-description">
              Provide a name and describe what you want your agent to accomplish
            </p>

            <div className="form-group">
              <label className="form-label">Agent Name *</label>
              <Input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="e.g., Customer Support Agent"
                className="bg-accent border-border text-foreground"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Task Description *</label>
              <Textarea
                value={taskDescription}
                onChange={(e) => setTaskDescription(e.target.value)}
                placeholder="Describe what this agent should do, what problems it should solve, and how it should behave..."
                className="form-textarea bg-accent border-border text-foreground"
                rows={8}
              />
              <p className="form-hint">
                Be specific about the agent's purpose, expected inputs, outputs, and any special requirements.
              </p>
            </div>
          </div>
        )}

        {currentStep === 'tools' && (
          <div className="step-content">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="step-title">Select Tools</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowToolsInfoModal(true)}
                className="size-7 text-muted-foreground hover:text-foreground transition-colors"
                title="Learn about community tools"
              >
                <HelpCircle className="size-5" />
              </Button>
            </div>
            <p className="step-description">
              Choose the tools your agent will have access to (optional)
            </p>

            <div className="selection-grid">
              {availableTools.map((tool) => {
                const config = typeof tool.config === 'string' ? (() => { try { return tool.config.trim() ? JSON.parse(tool.config) : {}; } catch { return {}; } })() : tool.config;
                const isSelected = selectedTools.includes(tool.toolId);

                return (
                  <Card
                    key={tool.toolId}
                    className={`selection-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleSelection(tool.toolId, selectedTools, setSelectedTools)}
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-foreground text-base">
                          {config?.name || tool.toolId}
                        </CardTitle>
                        {isSelected && (
                          <Badge className="bg-chart-2 text-foreground">
                            <Check className="size-3 mr-1" />
                            Selected
                          </Badge>
                        )}
                      </div>
                      <CardDescription className="text-muted-foreground text-sm">
                        {config?.description || 'No description'}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                );
              })}
            </div>

            {availableTools.length === 0 && (
              <div className="empty-state">
                <p className="text-muted-foreground">No tools available</p>
              </div>
            )}
          </div>
        )}

        {currentStep === 'datastores' && (
          <div className="step-content">
            <h2 className="step-title">Data Stores & Integrations</h2>
            <p className="step-description">
              Choose data stores and integrations for your agent (optional). Resources used by selected tools are auto-selected.
            </p>

            {/* Data Stores */}
            <h3 className="text-foreground text-sm font-medium mt-4 mb-2">Data Stores</h3>
            <div className="selection-grid">
              {availableDataStores.map((dataStore) => {
                const isSelected = selectedDataStores.includes(dataStore.dataStoreId);
                const DsIcon = getDsIcon(dataStore.icon);

                return (
                  <Card
                    key={dataStore.dataStoreId}
                    className={`selection-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleSelection(dataStore.dataStoreId, selectedDataStores, setSelectedDataStores)}
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/5">
                            <DsIcon className="size-5 text-muted-foreground" />
                          </div>
                          <div>
                            <CardTitle className="text-foreground text-base">
                              {dataStore.name}
                            </CardTitle>
                            <p className="text-xs text-muted-foreground">{dataStore.category}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge className="bg-chart-2/30 text-chart-2 border-chart-2 text-[10px] px-1.5 py-0">
                            CONNECTED
                          </Badge>
                          {isSelected && (
                            <Badge className="bg-chart-2 text-foreground">
                              <Check className="size-3 mr-1" />
                              Selected
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <Badge
                          className={categoryBadgeColors[dataStore.category] || categoryBadgeColors[DataStoreCategory.EXTERNAL]}
                          variant="secondary"
                        >
                          {dataStore.category.replace(/_/g, ' ')}
                        </Badge>
                        {dataStore.usage && dataStore.usage === DataStoreUsage.BOTH ? (
                          <>
                            <Badge
                              className={usageBadgeColors[DataStoreUsage.KNOWLEDGE]}
                              variant="secondary"
                            >
                              {usageLabels[DataStoreUsage.KNOWLEDGE]}
                            </Badge>
                            <Badge
                              className={usageBadgeColors[DataStoreUsage.OPERATIONAL]}
                              variant="secondary"
                            >
                              {usageLabels[DataStoreUsage.OPERATIONAL]}
                            </Badge>
                          </>
                        ) : dataStore.usage ? (
                          <Badge
                            className={usageBadgeColors[dataStore.usage] || usageBadgeColors[DataStoreUsage.KNOWLEDGE]}
                            variant="secondary"
                          >
                            {usageLabels[dataStore.usage] || dataStore.usage}
                          </Badge>
                        ) : null}
                      </div>
                    </CardHeader>
                  </Card>
                );
              })}
            </div>

            {availableDataStores.length === 0 && (
              <div className="empty-state">
                <p className="text-muted-foreground">No connected data stores available</p>
              </div>
            )}

            {/* Integrations */}
            <h3 className="text-foreground text-sm font-medium mt-6 mb-2">Integrations</h3>
            <div className="selection-grid">
              {availableIntegrations.map((integration) => {
                const isSelected = selectedIntegrations.includes(integration.id);
                const IntIcon = integration.icon || Cloud;

                return (
                  <Card
                    key={integration.id}
                    className={`selection-card ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleSelection(integration.id, selectedIntegrations, setSelectedIntegrations)}
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-white/5">
                            <IntIcon className="size-5 text-muted-foreground" />
                          </div>
                          <div>
                            <CardTitle className="text-foreground text-base">
                              {integration.name}
                            </CardTitle>
                            <p className="text-xs text-muted-foreground">{integration.integrationType}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge className="bg-chart-2/30 text-chart-2 border-chart-2 text-[10px] px-1.5 py-0">
                            CONNECTED
                          </Badge>
                          {isSelected && (
                            <Badge className="bg-chart-2 text-foreground">
                              <Check className="size-3 mr-1" />
                              Selected
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <Badge className="bg-transparent text-primary border border-primary/50" variant="secondary">
                          {integration.integrationType.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    </CardHeader>
                  </Card>
                );
              })}
            </div>

            {availableIntegrations.length === 0 && (
              <div className="empty-state">
                <p className="text-muted-foreground">No connected integrations available</p>
              </div>
            )}
          </div>
        )}

        {currentStep === 'review' && (
          <div className="step-content">
            <h2 className="step-title">Review & Create</h2>
            <p className="step-description">
              Review your selections before sending to the Fabricator
            </p>

            <div className="review-section">
              <h3 className="review-heading">Agent Details</h3>
              <div className="review-item">
                <span className="review-label">Name:</span>
                <span className="review-value">{agentName}</span>
              </div>
              <div className="review-item">
                <span className="review-label">Task Description:</span>
                <p className="review-value">{taskDescription}</p>
              </div>
            </div>

            <div className="review-section">
              <h3 className="review-heading">Selected Tools ({selectedTools.length})</h3>
              {selectedTools.length > 0 ? (
                <div className="review-badges">
                  {selectedTools.map(toolId => (
                    <Badge key={toolId} variant="secondary" className="bg-accent text-foreground">
                      {toolId}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="review-empty">No tools selected</p>
              )}
            </div>

            <div className="review-section">
              <h3 className="review-heading">Selected Data Stores & Integrations ({selectedDataStores.length + selectedIntegrations.length})</h3>
              {(selectedDataStores.length > 0 || selectedIntegrations.length > 0) ? (
                <div className="review-badges">
                  {selectedDataStores.map(id => {
                    const ds = availableDataStores.find(d => d.dataStoreId === id);
                    return (
                      <Badge key={id} variant="secondary" className="bg-chart-2/30 text-chart-2 border-chart-2">
                        {ds?.name || id} — {ds?.type || 'Data Store'}
                      </Badge>
                    );
                  })}
                  {selectedIntegrations.map(id => {
                    const integration = availableIntegrations.find(i => i.id === id);
                    return (
                      <Badge key={id} variant="secondary" className="bg-primary/30 text-primary border-primary">
                        {integration?.name || id} — Integration
                      </Badge>
                    );
                  })}
                </div>
              ) : (
                <p className="review-empty">No data stores or integrations selected</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Navigation Buttons */}
      <div className="wizard-footer">
        <Button
          variant="outline"
          onClick={handlePrevious}
          disabled={currentStepIndex === 0}
          className="border-border text-foreground hover:bg-accent"
        >
          Previous
        </Button>

        <div className="flex gap-2">
          {currentStep !== 'review' ? (
            <Button
              onClick={handleNext}
              disabled={!canProceed() || loading}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Next
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!canProceed() || loading}
              className="bg-chart-2 text-foreground hover:bg-chart-2"
            >
              {loading ? 'Creating...' : 'Create Agent'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
