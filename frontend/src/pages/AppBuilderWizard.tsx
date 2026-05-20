import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Bot,
  GitBranch,
  Shield,
  Settings,
  ClipboardList,
  FileText,
  Loader2,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Badge } from '../components/ui/badge';
import { useOrganization } from '../contexts/OrganizationContext';
import { appApiService } from '../services/appApiService';
import { agentConfigService } from '../services/agentConfigService';
import { workflowApiService } from '../services/workflowApiService';
import { validateAppName, validateWizardStep } from '../utils/wizardValidation';
import { cn } from '../components/ui/utils';

// ---- Types ----

interface AppBuilderWizardProps {
  onComplete: () => void;
  prefill?: {
    name: string;
    description: string;
    agentIds: string[];
    integrationIds: string[];
  };
}

interface AgentOption {
  agentId: string;
  name: string;
  description: string;
}

interface WorkflowOption {
  workflowId: string;
  name: string;
  description: string;
  status: string;
}

interface AgentOverrides {
  systemPromptAddition: string;
  toolRestrictions: string;
  modelOverride: string;
}

interface PermissionEntry {
  id: string;
  actions: string[];
  resources: string[];
  description: string;
}

// ---- Constants ----

const WIZARD_STEPS = [
  { label: 'Name', icon: FileText },
  { label: 'Agents', icon: Bot },
  { label: 'Workflows', icon: GitBranch },
  { label: 'Permissions', icon: Shield },
  { label: 'Configuration', icon: Settings },
  { label: 'Review', icon: ClipboardList },
] as const;

// ---- Component ----

export function AppBuilderWizard({ onComplete, prefill }: AppBuilderWizardProps) {
  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || 'default';

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 0: Name
  const [appName, setAppName] = useState(prefill?.name || '');
  const [appDescription, setAppDescription] = useState(prefill?.description || '');
  const [nameErrors, setNameErrors] = useState<string[]>([]);

  // Step 1: Agents
  const [availableAgents, setAvailableAgents] = useState<AgentOption[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(prefill?.agentIds || []);
  const [agentOverrides, setAgentOverrides] = useState<Record<string, AgentOverrides>>({});
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);

  // Step 2: Workflows
  const [availableWorkflows, setAvailableWorkflows] = useState<WorkflowOption[]>([]);
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<string[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);

  // Step 3: Permissions
  const [permissions, setPermissions] = useState<PermissionEntry[]>([]);

  // Step 4: Configuration
  const [configSchema, setConfigSchema] = useState('');
  const [configValues, setConfigValues] = useState('');

  // Load agents when entering step 1
  useEffect(() => {
    if (currentStep === 1 && availableAgents.length === 0) {
      loadAgents();
    }
  }, [currentStep]);

  // Load workflows when entering step 2
  useEffect(() => {
    if (currentStep === 2 && availableWorkflows.length === 0) {
      loadWorkflows();
    }
  }, [currentStep]);

  const loadAgents = async () => {
    try {
      setLoadingAgents(true);
      const configs = await agentConfigService.listAgentConfigs();
      setAvailableAgents(
        configs
          .filter((c: { state: string }) => c.state === 'active')
          .map((c: { agentId: string; config: { name?: string; description?: string } }) => ({
            agentId: c.agentId,
            name: c.config?.name || c.agentId,
            description: c.config?.description || '',
          })),
      );
    } catch {
      // Agents will show empty state
    } finally {
      setLoadingAgents(false);
    }
  };

  const loadWorkflows = async () => {
    try {
      setLoadingWorkflows(true);
      const result = await workflowApiService.listWorkflows(orgId);
      setAvailableWorkflows(
        (result.items || []).map((w: { workflowId: string; name: string; description?: string; status: string }) => ({
          workflowId: w.workflowId,
          name: w.name || w.workflowId,
          description: w.description || '',
          status: w.status,
        })),
      );
    } catch {
      // Workflows will show empty state
    } finally {
      setLoadingWorkflows(false);
    }
  };

  // Validation
  const stepValidation = validateWizardStep(currentStep, {
    name: appName,
    description: appDescription,
    agents: selectedAgentIds,
    workflows: selectedWorkflowIds,
  });

  const canGoNext = stepValidation.valid;

  const handleNext = useCallback(() => {
    if (currentStep === 0) {
      const nameResult = validateAppName(appName);
      if (!nameResult.valid) {
        setNameErrors(nameResult.errors);
        return;
      }
      setNameErrors([]);
    }
    if (canGoNext && currentStep < WIZARD_STEPS.length - 1) {
      setCurrentStep((s) => s + 1);
    }
  }, [currentStep, canGoNext, appName]);

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }, [currentStep]);

  const goToStep = useCallback((step: number) => {
    if (step < currentStep) {
      setCurrentStep(step);
    }
  }, [currentStep]);

  // Agent selection
  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  };

  const updateAgentOverride = (agentId: string, field: keyof AgentOverrides, value: string) => {
    setAgentOverrides((prev) => ({
      ...prev,
      [agentId]: { ...prev[agentId], [field]: value },
    }));
  };

  // Workflow selection
  const toggleWorkflow = (workflowId: string) => {
    setSelectedWorkflowIds((prev) =>
      prev.includes(workflowId) ? prev.filter((id) => id !== workflowId) : [...prev, workflowId],
    );
  };

  // Permissions
  const addPermission = () => {
    setPermissions((prev) => [
      ...prev,
      { id: crypto.randomUUID(), actions: [], resources: [], description: '' },
    ]);
  };

  const removePermission = (id: string) => {
    setPermissions((prev) => prev.filter((p) => p.id !== id));
  };

  const updatePermission = (id: string, field: keyof PermissionEntry, value: string | string[]) => {
    setPermissions((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
    );
  };

  // Submit
  const handleSubmit = async () => {
    try {
      setSubmitting(true);
      setSubmitError(null);

      // 1. Create app
      const app = await appApiService.createApp({
        name: appName,
        orgId,
        description: appDescription || undefined,
      });

      // 2. Add agent components
      for (const agentId of selectedAgentIds) {
        const overrides = agentOverrides[agentId];
        const data: Record<string, unknown> = { agentId };
        if (overrides?.systemPromptAddition) data.systemPromptAddition = overrides.systemPromptAddition;
        if (overrides?.toolRestrictions) data.toolRestrictions = overrides.toolRestrictions.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (overrides?.modelOverride) data.modelOverride = overrides.modelOverride;

        await appApiService.addAppComponent(app.appId, { type: 'agent', data: JSON.stringify(data) });
      }

      // 3. Bind workflows
      for (const workflowId of selectedWorkflowIds) {
        await appApiService.bindWorkflowToApp(app.appId, workflowId);
      }

      // 4. Add permissions
      for (const perm of permissions) {
        if (perm.actions.length > 0 || perm.resources.length > 0) {
          await appApiService.addAppComponent(app.appId, {
            type: 'permission',
            data: JSON.stringify({
              permissionId: perm.id,
              actions: perm.actions,
              resources: perm.resources,
              description: perm.description,
            }),
          });
        }
      }

      // 5. Set config schema/values if provided
      if (configSchema.trim()) {
        await appApiService.setAppConfigSchema(app.appId, configSchema, app.version);
      }
      if (configValues.trim()) {
        await appApiService.setAppConfigValues(app.appId, configValues, app.version + (configSchema.trim() ? 1 : 0));
      }

      onComplete();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create app';
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Render helpers ----

  const renderStepIndicator = () => (
    <div className="flex items-center gap-1 mb-8">
      {WIZARD_STEPS.map((step, idx) => {
        const Icon = step.icon;
        const isCompleted = idx < currentStep;
        const isCurrent = idx === currentStep;
        return (
          <div key={step.label} className="flex items-center">
            <button
              type="button"
              onClick={() => goToStep(idx)}
              disabled={idx > currentStep}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                isCurrent && 'bg-primary/20 text-primary border border-primary/40',
                isCompleted && 'text-chart-2 cursor-pointer hover:bg-accent',
                !isCurrent && !isCompleted && 'text-muted-foreground cursor-default',
              )}
            >
              {isCompleted ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Icon className="w-3.5 h-3.5" />
              )}
              {step.label}
            </button>
            {idx < WIZARD_STEPS.length - 1 && (
              <div className={cn('w-6 h-px mx-1', isCompleted ? 'bg-chart-2/40' : 'bg-accent')} />
            )}
          </div>
        );
      })}
    </div>
  );

  const renderNameStep = () => (
    <div className="flex flex-col gap-4 max-w-lg">
      <div>
        <Label htmlFor="app-name" className="text-foreground mb-1.5">
          App Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="app-name"
          placeholder="My Agent App"
          value={appName}
          onChange={(e) => {
            setAppName(e.target.value);
            if (nameErrors.length > 0) setNameErrors([]);
          }}
          className="bg-transparent border border-input text-foreground"
          maxLength={100}
        />
        <p className="text-xs text-muted-foreground mt-1">3-100 characters</p>
        {nameErrors.map((err) => (
          <p key={err} className="text-xs text-destructive mt-1">{err}</p>
        ))}
      </div>
      <div>
        <Label htmlFor="app-desc" className="text-foreground mb-1.5">Description</Label>
        <Textarea
          id="app-desc"
          placeholder="Describe what this app does..."
          value={appDescription}
          onChange={(e) => setAppDescription(e.target.value)}
          className="bg-transparent border border-input text-foreground"
          maxLength={500}
          rows={3}
        />
        <p className="text-xs text-muted-foreground mt-1">{appDescription.length}/500</p>
      </div>
    </div>
  );

  const renderAgentsStep = () => (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground mb-2">Select agents to bind to this app.</p>
      {loadingAgents ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8">
          <Loader2 className="size-4 animate-spin" /> Loading agents...
        </div>
      ) : availableAgents.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">No active agents available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {availableAgents.map((agent) => {
            const selected = selectedAgentIds.includes(agent.agentId);
            const expanded = expandedAgent === agent.agentId;
            const overrides = agentOverrides[agent.agentId] || { systemPromptAddition: '', toolRestrictions: '', modelOverride: '' };
            return (
              <div
                key={agent.agentId}
                className={cn(
                  'rounded-lg border p-3 transition-colors cursor-pointer',
                  selected ? 'border-primary/60 bg-primary/10' : 'border-border/50 bg-card hover:border-border',
                )}
              >
                <div className="flex items-start justify-between" onClick={() => toggleAgent(agent.agentId)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') toggleAgent(agent.agentId); }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{agent.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{agent.description || 'No description'}</p>
                  </div>
                  {selected && <Check className="size-4 text-primary ml-2 flex-shrink-0" />}
                </div>
                {selected && (
                  <div className="mt-2 pt-2 border-t border-border/50">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setExpandedAgent(expanded ? null : agent.agentId)}
                    >
                      {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      Overrides
                    </button>
                    {expanded && (
                      <div className="flex flex-col mt-2 gap-2">
                        <Input
                          placeholder="System prompt addition"
                          value={overrides.systemPromptAddition}
                          onChange={(e) => updateAgentOverride(agent.agentId, 'systemPromptAddition', e.target.value)}
                          className="bg-transparent border border-border text-foreground text-xs"
                        />
                        <Input
                          placeholder="Tool restrictions (comma-separated)"
                          value={overrides.toolRestrictions}
                          onChange={(e) => updateAgentOverride(agent.agentId, 'toolRestrictions', e.target.value)}
                          className="bg-transparent border border-border text-foreground text-xs"
                        />
                        <Input
                          placeholder="Model override (e.g. us.anthropic.claude-sonnet-4-6)"
                          value={overrides.modelOverride}
                          onChange={(e) => updateAgentOverride(agent.agentId, 'modelOverride', e.target.value)}
                          className="bg-transparent border border-border text-foreground text-xs"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderWorkflowsStep = () => (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground mb-2">Select workflows to bind to this app.</p>
      {loadingWorkflows ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8">
          <Loader2 className="size-4 animate-spin" /> Loading workflows...
        </div>
      ) : availableWorkflows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">No workflows available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {availableWorkflows.map((wf) => {
            const selected = selectedWorkflowIds.includes(wf.workflowId);
            return (
              <div
                key={wf.workflowId}
                onClick={() => toggleWorkflow(wf.workflowId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') toggleWorkflow(wf.workflowId); }}
                className={cn(
                  'rounded-lg border p-3 transition-colors cursor-pointer',
                  selected ? 'border-primary/60 bg-primary/10' : 'border-border/50 bg-card hover:border-border',
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{wf.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{wf.description || 'No description'}</p>
                  </div>
                  <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                    <Badge className="text-xs border-0 bg-muted/20 text-muted-foreground">{wf.status}</Badge>
                    {selected && <Check className="size-4 text-primary" />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderPermissionsStep = () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Declare required IAM permissions (optional).</p>
        <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={addPermission}>
          <Plus className="size-3" /> Add Permission
        </Button>
      </div>
      {permissions.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">No permissions declared. Click "Add Permission" to add one.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {permissions.map((perm) => (
            <div key={perm.id} className="flex flex-col rounded-lg border border-border/50 bg-card p-3 gap-2">
              <div className="flex items-center justify-between">
                <Input
                  placeholder="Description (e.g. S3 read access)"
                  value={perm.description}
                  onChange={(e) => updatePermission(perm.id, 'description', e.target.value)}
                  className="bg-transparent border border-border text-foreground text-xs"
                  className="flex-1 mr-2"
                />
                <Button variant="ghost" size="sm" onClick={() => removePermission(perm.id)} className="text-destructive hover:text-destructive">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              <Input
                placeholder="Actions (comma-separated, e.g. s3:GetObject, s3:PutObject)"
                value={perm.actions.join(', ')}
                onChange={(e) => updatePermission(perm.id, 'actions', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                className="bg-transparent border border-border text-foreground text-xs"
              />
              <Input
                placeholder="Resources (comma-separated ARN patterns)"
                value={perm.resources.join(', ')}
                onChange={(e) => updatePermission(perm.id, 'resources', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                className="bg-transparent border border-border text-foreground text-xs"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderConfigurationStep = () => (
    <div className="flex flex-col gap-4 max-w-2xl">
      <p className="text-sm text-muted-foreground">Define app configuration schema and values (optional).</p>
      <div>
        <Label className="text-foreground mb-1.5">Configuration Schema (JSON Schema)</Label>
        <Textarea
          placeholder='{"type": "object", "properties": { "apiKey": { "type": "string" } }}'
          value={configSchema}
          onChange={(e) => setConfigSchema(e.target.value)}
          className="bg-transparent border border-input text-foreground font-mono text-xs"
          rows={6}
        />
      </div>
      <div>
        <Label className="text-foreground mb-1.5">Configuration Values (JSON)</Label>
        <Textarea
          placeholder='{"apiKey": "your-api-key"}'
          value={configValues}
          onChange={(e) => setConfigValues(e.target.value)}
          className="bg-transparent border border-input text-foreground font-mono text-xs"
          rows={6}
        />
      </div>
    </div>
  );

  const renderReviewStep = () => {
    const selectedAgents = availableAgents.filter((a) => selectedAgentIds.includes(a.agentId));
    const selectedWorkflows = availableWorkflows.filter((w) => selectedWorkflowIds.includes(w.workflowId));
    const activePermissions = permissions.filter((p) => p.actions.length > 0 || p.resources.length > 0);

    return (
      <div className="flex flex-col gap-4 max-w-2xl">
        {/* Name */}
        <div className="rounded-lg border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-foreground">Name</h3>
            <button type="button" onClick={() => goToStep(0)} className="text-xs text-primary hover:text-primary">Edit</button>
          </div>
          <p className="text-sm text-foreground">{appName}</p>
          {appDescription && <p className="text-xs text-muted-foreground mt-1">{appDescription}</p>}
        </div>

        {/* Agents */}
        <div className="rounded-lg border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-foreground">Agents ({selectedAgents.length})</h3>
            <button type="button" onClick={() => goToStep(1)} className="text-xs text-primary hover:text-primary">Edit</button>
          </div>
          {selectedAgents.map((a) => (
            <p key={a.agentId} className="text-xs text-muted-foreground">{a.name}</p>
          ))}
        </div>

        {/* Workflows */}
        <div className="rounded-lg border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-foreground">Workflows ({selectedWorkflows.length})</h3>
            <button type="button" onClick={() => goToStep(2)} className="text-xs text-primary hover:text-primary">Edit</button>
          </div>
          {selectedWorkflows.map((w) => (
            <p key={w.workflowId} className="text-xs text-muted-foreground">{w.name}</p>
          ))}
        </div>

        {/* Permissions */}
        {activePermissions.length > 0 && (
          <div className="rounded-lg border border-border/50 bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-foreground">Permissions ({activePermissions.length})</h3>
              <button type="button" onClick={() => goToStep(3)} className="text-xs text-primary hover:text-primary">Edit</button>
            </div>
            {activePermissions.map((p) => (
              <p key={p.id} className="text-xs text-muted-foreground">{p.description || p.actions.join(', ')}</p>
            ))}
          </div>
        )}

        {/* Configuration */}
        {(configSchema.trim() || configValues.trim()) && (
          <div className="rounded-lg border border-border/50 bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-foreground">Configuration</h3>
              <button type="button" onClick={() => goToStep(4)} className="text-xs text-primary hover:text-primary">Edit</button>
            </div>
            {configSchema.trim() && <p className="text-xs text-muted-foreground">Schema defined</p>}
            {configValues.trim() && <p className="text-xs text-muted-foreground">Values provided</p>}
          </div>
        )}

        {submitError && (
          <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-3">
            <p className="text-sm text-destructive">{submitError}</p>
          </div>
        )}
      </div>
    );
  };

  // ---- Main render ----

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 0: return renderNameStep();
      case 1: return renderAgentsStep();
      case 2: return renderWorkflowsStep();
      case 3: return renderPermissionsStep();
      case 4: return renderConfigurationStep();
      case 5: return renderReviewStep();
      default: return null;
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 m-[15px]">
          {/* Header */}
          <div className="px-2">
            <h1 className="text-2xl font-semibold text-foreground">Create App</h1>
            <p className="text-sm mt-1" style={{ color: '#8b8b8b' }}>
              Build a new agent application step by step
            </p>
          </div>

          {/* Step indicator */}
          {renderStepIndicator()}

          {/* Step content */}
          <div className="px-2">{renderCurrentStep()}</div>

          {/* Navigation */}
          <div className="flex items-center justify-between px-2 pt-4 border-t border-border/50">
            <Button
              variant="outline"
              onClick={currentStep === 0 ? onComplete : handleBack}
              className="gap-1 text-xs"
            >
              <ArrowLeft className="size-4" />
              {currentStep === 0 ? 'Cancel' : 'Back'}
            </Button>

            {currentStep < WIZARD_STEPS.length - 1 ? (
              <Button
                onClick={handleNext}
                disabled={!canGoNext}
                className="gap-1 text-xs bg-primary hover:bg-primary text-foreground disabled:opacity-40"
              >
                Next
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={submitting}
                className="gap-1 text-xs bg-chart-2 hover:bg-chart-2 text-foreground"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Creating...
                  </>
                ) : (
                  'Create App'
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
