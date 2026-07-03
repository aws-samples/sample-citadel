import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft,
  Bot,
  GitBranch,
  Shield,
  Settings,
  Play,
  Loader2,
  Trash2,
  Pencil,
  ExternalLink,
  MessageSquare,
  Wrench,
  Cpu,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Archive,
  RotateCcw,
  Clock,
  Plus,
  Globe,
  Copy,
  Check,
  Activity,
  BarChart3,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  AreaChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { ModelOverrideSelect } from '../components/ModelOverrideSelect';
import { appApiService } from '../services/appApiService';
import { workflowApiService } from '../services/workflowApiService';
import { agentConfigService } from '../services/agentConfigService';
import serverService from '../services/server';
import { useOrganization } from '../contexts/OrganizationContext';
import { cn } from '../components/ui/utils';
import {
  getHealthStatus,
  shouldEnablePublish,
  type HealthStatus,
} from '../utils/publishUtils';
import { PageContainer } from '../components/PageContainer';

// ---- Types ----

interface AppDetailViewProps {
  appId: string;
  onBack: () => void;
  onNavigate?: (view: string) => void;
  onPublishSuccess?: (data: { appId: string; appName: string; endpointUrl: string; apiKey: string }) => void;
}

interface RegistryAgentBinding {
  agentId: string;
  status: 'DESIGN' | 'READY';
  systemPromptAddition?: string;
  toolRestrictions?: string[];
  modelOverride?: string;
  addedAt: string;
}

interface RegistryAgentRecordPermission {
  permissionId: string;
  actions: string[];
  resources: string[];
  description?: string;
}

interface WorkflowInfo {
  workflowId: string;
  name: string;
  status: string;
  nodeCount: number;
}

interface Execution {
  executionId: string;
  workflowId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

interface RegistryAgentRecordDetail {
  appId: string;
  orgId: string;
  name: string;
  description: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DEPRECATED' | 'CREATING' | 'UPDATING' | 'CREATE_FAILED' | 'UPDATE_FAILED' | 'PUBLISHED';
  workflowIds: string[];
  agentBindings: RegistryAgentBinding[];
  permissions: RegistryAgentRecordPermission[];
  configSchema: string | null;
  configValues: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  endpointUrl?: string;
  apiId?: string;
  authMode?: string;
}

interface AppApiKey {
  keyId: string;
  name: string;
  prefix: string;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

interface AppMetrics {
  totalRequests: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  timeSeries: Array<{
    timestamp: string;
    requestCount: number;
    errorCount: number;
    avgLatency: number;
  }>;
}

interface StatusTransition {
  label: string;
  targetStatus: string;
  icon: typeof Play;
  className: string;
  disabled?: boolean;
}

interface Precondition {
  label: string;
  passed: boolean;
  detail?: string;
}

// ---- Constants ----

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  DRAFT: { bg: 'bg-primary/20', text: 'text-primary' },
  APPROVED: { bg: 'bg-chart-2/20', text: 'text-chart-2' },
  PUBLISHED: { bg: 'bg-chart-5/20', text: 'text-chart-5' },
  DEPRECATED: { bg: 'bg-muted/20', text: 'text-muted-foreground' },
};

const COMPONENT_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  DESIGN: { bg: 'bg-chart-4/20', text: 'text-chart-4' },
  READY: { bg: 'bg-chart-2/20', text: 'text-chart-2' },
};

const EXECUTION_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  RUNNING: { bg: 'bg-primary/20', text: 'text-primary' },
  SUCCEEDED: { bg: 'bg-chart-2/20', text: 'text-chart-2' },
  FAILED: { bg: 'bg-destructive/20', text: 'text-destructive' },
  PENDING: { bg: 'bg-chart-4/20', text: 'text-chart-4' },
};

// ---- Helpers ----

function getStatusTransition(status: string): StatusTransition | null {
  switch (status) {
    case 'DRAFT':
      return { label: 'Activate', targetStatus: 'APPROVED', icon: Play, className: 'bg-chart-1 hover:bg-chart-1/90' };
    case 'PENDING_APPROVAL':
      return { label: 'Awaiting Approval', targetStatus: 'PENDING_APPROVAL', icon: Play, className: 'bg-chart-4 opacity-50 cursor-not-allowed', disabled: true };
    case 'APPROVED':
      return { label: 'Archive', targetStatus: 'DEPRECATED', icon: Archive, className: 'bg-chart-3 hover:bg-chart-3/90' };
    case 'DEPRECATED':
      return { label: 'Reactivate', targetStatus: 'DRAFT', icon: RotateCcw, className: 'bg-chart-2 hover:bg-chart-2/90' };
    case 'REJECTED':
      return { label: 'Resubmit', targetStatus: 'DRAFT', icon: RotateCcw, className: 'bg-chart-2 hover:bg-chart-2/90' };
    case 'CREATING':
    case 'UPDATING':
      return { label: 'In Progress...', targetStatus: status, icon: Play, className: 'bg-muted opacity-50 cursor-not-allowed', disabled: true };
    case 'CREATE_FAILED':
    case 'UPDATE_FAILED':
      return { label: 'Retry', targetStatus: 'DRAFT', icon: RotateCcw, className: 'bg-destructive hover:bg-destructive/90' };
    default:
      return null;
  }
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function computeDuration(startedAt: string, completedAt?: string): string {
  try {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const diffMs = end - start;
    if (diffMs < 1000) return `${diffMs}ms`;
    if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s`;
    return `${Math.round(diffMs / 60000)}m`;
  } catch {
    return '—';
  }
}

function buildPreconditions(app: RegistryAgentRecordDetail): Precondition[] {
  const preconditions: Precondition[] = [];

  // Check agent bindings — all should be READY
  const designAgents = (app.agentBindings || []).filter((b) => b.status === 'DESIGN');
  preconditions.push({
    label: 'All agents are READY',
    passed: designAgents.length === 0 && (app.agentBindings || []).length > 0,
    detail: designAgents.length > 0
      ? `${designAgents.length} agent(s) still in DESIGN status`
      : (app.agentBindings || []).length === 0
        ? 'No agents bound to this app'
        : undefined,
  });

  // Check at least one workflow bound (optional — single-agent apps don't need workflows)
  const hasWorkflows = (app.workflowIds || []).length > 0;
  if (!hasWorkflows && (app.agentBindings || []).length > 1) {
    preconditions.push({
      label: 'Workflow bound (required for multi-agent apps)',
      passed: false,
      detail: 'Multi-agent apps require at least one workflow to define orchestration',
    });
  }

  // Check config: if schema exists, values must exist and be valid
  if (app.configSchema) {
    preconditions.push({
      label: 'Configuration values provided',
      passed: !!app.configValues,
      detail: !app.configValues ? 'Config schema defined but no values provided' : undefined,
    });
  }

  // Admin email is optional — informational hint
  const configValues = typeof app.configValues === 'string'
    ? (() => { try { return JSON.parse(app.configValues as string); } catch { return null; } })()
    : app.configValues;
  const adminEmail = configValues?.adminEmail;
  preconditions.push({
    label: adminEmail ? 'Admin email provided' : 'Admin email (optional)',
    passed: true,
    detail: !adminEmail ? 'Add an admin email in the Configuration tab for notifications' : undefined,
  });

  return preconditions;
}

// ---- Pure helpers for publish flow (moved to publishUtils.ts, re-exported for backward compatibility) ----

export { getHealthStatus, shouldEnablePublish, type HealthStatus };

const HEALTH_COLORS: Record<HealthStatus, { bg: string; text: string; label: string }> = {
  green: { bg: 'bg-chart-2/20', text: 'text-chart-2', label: 'Healthy' },
  yellow: { bg: 'bg-chart-4/20', text: 'text-chart-4', label: 'Degraded' },
  red: { bg: 'bg-destructive/20', text: 'text-destructive', label: 'Unhealthy' },
};

const TIME_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

// ---- Component ----

export function AppDetailView({ appId, onBack, onNavigate, onPublishSuccess }: AppDetailViewProps) {
  const [app, setApp] = useState<RegistryAgentRecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [executions] = useState<Execution[]>([]);
  const [activeTab, setActiveTab] = useState('agents');

  // Status transition dialog
  const [transitionDialogOpen, setTransitionDialogOpen] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<StatusTransition | null>(null);
  const [transitionLoading, setTransitionLoading] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [failedPreconditions, setFailedPreconditions] = useState<Precondition[]>([]);

  // Config editing
  const [editingConfigValues, setEditingConfigValues] = useState(false);
  const [configValuesInput, setConfigValuesInput] = useState('');
  const [configSaveError, setConfigSaveError] = useState<string | null>(null);
  const [configSaving, setConfigSaving] = useState(false);

  // Add agent dialog
  const [addAgentDialogOpen, setAddAgentDialogOpen] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<Array<{ agentId: string; name: string; description: string }>>([]);
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [addingAgent, setAddingAgent] = useState<string | null>(null);

  // Edit binding dialog
  const [editingBinding, setEditingBinding] = useState<RegistryAgentBinding | null>(null);
  const [editBindingForm, setEditBindingForm] = useState({ systemPromptAddition: '', toolRestrictions: '', modelOverride: '', status: 'DESIGN' as string });
  const [editBindingSaving, setEditBindingSaving] = useState(false);

  // Bind workflow dialog
  const { selectedOrganization } = useOrganization();
  const [bindWorkflowDialogOpen, setBindWorkflowDialogOpen] = useState(false);
  const [unboundWorkflows, setUnboundWorkflows] = useState<Array<{ workflowId: string; name: string; status: string }>>([]);
  const [loadingUnboundWorkflows, setLoadingUnboundWorkflows] = useState(false);
  const [bindingWorkflow, setBindingWorkflow] = useState<string | null>(null);

  // Add permission dialog
  const [addPermDialogOpen, setAddPermDialogOpen] = useState(false);
  const [permForm, setPermForm] = useState({ description: '', actions: '', resources: '' });
  const [addingPerm, setAddingPerm] = useState(false);

  // Publish flow state
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ endpointUrl: string; apiKey: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // API tab state
  const [apiKeys, setApiKeys] = useState<AppApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [timeRange, setTimeRange] = useState('24h');
  const [createKeyDialogOpen, setCreateKeyDialogOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);

  // Unpublish flow state
  const [unpublishDialogOpen, setUnpublishDialogOpen] = useState(false);
  const [unpublishLoading, setUnpublishLoading] = useState(false);
  const [unpublishWarnings, setUnpublishWarnings] = useState<string[]>([]);

  // Subscribe to onAppStatusChange for real-time status updates (Req 11 AC 12)
  useEffect(() => {
    const ON_APP_STATUS_CHANGE = `
      subscription OnAppStatusChange($appId: ID!) {
        onAppStatusChange(appId: $appId) {
          appId
          previousStatus
          newStatus
          timestamp
        }
      }
    `;

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = serverService.subscribe(
        ON_APP_STATUS_CHANGE,
        { appId },
        (data: any) => {
          const event = data?.onAppStatusChange;
          if (event?.newStatus) {
            setApp((prev) =>
              prev ? { ...prev, status: event.newStatus, updatedAt: event.timestamp } : prev,
            );
          }
        },
      );
    } catch (err) {
      console.warn('Failed to subscribe to app status changes:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [appId]);

  const loadApp = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await appApiService.getApp(appId);
      setApp(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load app';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  const loadWorkflows = useCallback(async (workflowIds: string[]) => {
    if (!workflowIds || workflowIds.length === 0) {
      setWorkflows([]);
      return;
    }
    try {
      const results = await Promise.allSettled(
        workflowIds.map((id) => workflowApiService.getWorkflow(id)),
      );
      const loaded: WorkflowInfo[] = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value)
        .map((r) => ({
          workflowId: r.value.workflowId,
          name: r.value.name || r.value.workflowId,
          status: r.value.status || 'UNKNOWN',
          nodeCount: r.value.nodes?.length ?? 0,
        }));
      setWorkflows(loaded);
    } catch {
      setWorkflows([]);
    }
  }, []);

  useEffect(() => {
    loadApp();
  }, [loadApp]);

  useEffect(() => {
    if (app?.agentBindings?.length) {
      agentConfigService.listAgentConfigs().then((configs: any[]) => {
        const map: Record<string, string> = {};
        for (const c of configs) {
          const cfg = typeof c.config === 'object' && c.config !== null ? c.config : {};
          map[c.agentId] = c.name || cfg.name || c.agentId;
        }
        setAgentNameMap(map);
      }).catch(() => {});
    }
  }, [app?.agentBindings]);

  useEffect(() => {
    if (app?.workflowIds) {
      loadWorkflows(app.workflowIds);
    }
  }, [app?.workflowIds, loadWorkflows]);

  // Load API tab data when app is PUBLISHED
  const loadApiData = useCallback(async (selectedRange: string) => {
    if (!app || app.status !== 'PUBLISHED') return;
    const rangeConfig = TIME_RANGES.find((r) => r.label === selectedRange) || TIME_RANGES[2];
    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - rangeConfig.hours * 3600000).toISOString();

    setApiKeysLoading(true);
    setMetricsLoading(true);

    try {
      const keys = await appApiService.listAppApiKeys(app.appId);
      setApiKeys(keys || []);
    } catch {
      setApiKeys([]);
    } finally {
      setApiKeysLoading(false);
    }

    try {
      const m = await appApiService.getAppMetrics(app.appId, startTime, endTime);
      setMetrics(m);
    } catch {
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, [app]);

  useEffect(() => {
    if (app?.status === 'PUBLISHED') {
      loadApiData(timeRange);
    }
  }, [app?.status, app?.appId, loadApiData, timeRange]);

  // ---- Actions ----

  const loadAvailableAgents = async () => {
    try {
      setLoadingAgents(true);
      const configs = await agentConfigService.listAgentConfigs();
      const boundIds = new Set((app?.agentBindings || []).map((b: RegistryAgentBinding) => b.agentId));
      setAvailableAgents(
        configs
          .filter((c: any) => c.state === 'active' && !boundIds.has(c.agentId))
          .map((c: any) => {
            const config = typeof c.config === 'object' && c.config !== null ? c.config : {};
            return {
              agentId: c.agentId,
              // Prefer Registry top-level name, then legacy config.name, then agentId.
              name: c.name || config.name || c.agentId,
              description: typeof config.description === 'string' ? config.description : '',
            };
          }),
      );
    } catch {
      setAvailableAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  };

  const handleAddAgent = async (agentId: string) => {
    if (!app) return;
    try {
      setAddingAgent(agentId);
      await appApiService.addAppComponent(app.appId, {
        type: 'agent',
        data: JSON.stringify({ agentId }),
      });
      setAddAgentDialogOpen(false);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to add agent';
      setError(message);
    } finally {
      setAddingAgent(null);
    }
  };

  const handleRemoveAgent = async (agentId: string) => {
    if (!app) return;
    try {
      await appApiService.removeAppComponent(app.appId, 'agent', agentId);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to remove agent';
      setError(message);
    }
  };

  const handleUpdateBinding = async () => {
    if (!app || !editingBinding) return;
    try {
      setEditBindingSaving(true);
      const toolRestrictionsArray = editBindingForm.toolRestrictions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await appApiService.updateAgentBinding({
        appId: app.appId,
        agentId: editingBinding.agentId,
        systemPromptAddition: editBindingForm.systemPromptAddition || undefined,
        toolRestrictions: toolRestrictionsArray.length > 0 ? toolRestrictionsArray : undefined,
        modelOverride: editBindingForm.modelOverride || undefined,
        status: editBindingForm.status || undefined,
      });
      setEditingBinding(null);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update binding';
      setError(message);
    } finally {
      setEditBindingSaving(false);
    }
  };

  const loadUnboundWorkflows = async () => {
    if (!app) return;
    try {
      setLoadingUnboundWorkflows(true);
      const orgId = app.orgId || selectedOrganization || 'default';
      const result = await workflowApiService.listWorkflows(orgId);
      const boundIds = new Set(app.workflowIds || []);
      setUnboundWorkflows(
        (result.items || [])
          .filter((w: any) => !boundIds.has(w.workflowId))
          .map((w: any) => ({ workflowId: w.workflowId, name: w.name || w.workflowId, status: w.status || 'UNKNOWN' })),
      );
    } catch {
      setUnboundWorkflows([]);
    } finally {
      setLoadingUnboundWorkflows(false);
    }
  };

  const handleBindWorkflow = async (workflowId: string) => {
    if (!app) return;
    try {
      setBindingWorkflow(workflowId);
      await appApiService.bindWorkflowToApp(app.appId, workflowId);
      setBindWorkflowDialogOpen(false);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to bind workflow';
      setError(message);
    } finally {
      setBindingWorkflow(null);
    }
  };

  const handleUnbindWorkflow = async (workflowId: string) => {
    if (!app) return;
    try {
      await appApiService.unbindWorkflowFromApp(app.appId, workflowId);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to unbind workflow';
      setError(message);
    }
  };

  const handleRemovePermission = async (permissionId: string) => {
    if (!app) return;
    try {
      await appApiService.removeAppComponent(app.appId, 'permission', permissionId);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to remove permission';
      setError(message);
    }
  };

  const handleAddPermission = async () => {
    if (!app) return;
    const actions = permForm.actions.split(',').map((s) => s.trim()).filter(Boolean);
    const resources = permForm.resources.split(',').map((s) => s.trim()).filter(Boolean);
    if (actions.length === 0) {
      setError('At least one IAM action is required (e.g. s3:GetObject)');
      return;
    }
    if (resources.length === 0) {
      setError('At least one resource ARN is required');
      return;
    }
    try {
      setAddingPerm(true);
      const permissionId = crypto.randomUUID();
      await appApiService.addAppComponent(app.appId, {
        type: 'permission',
        data: JSON.stringify({
          permissionId,
          actions,
          resources,
          description: permForm.description || undefined,
        }),
      });
      setAddPermDialogOpen(false);
      setPermForm({ description: '', actions: '', resources: '' });
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to add permission';
      setError(message);
    } finally {
      setAddingPerm(false);
    }
  };

  const handleSaveConfigValues = async () => {
    if (!app) return;
    try {
      setConfigSaving(true);
      setConfigSaveError(null);
      await appApiService.setAppConfigValues(app.appId, configValuesInput, app.version);
      setEditingConfigValues(false);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save config values';
      setConfigSaveError(message);
    } finally {
      setConfigSaving(false);
    }
  };

  const openTransitionDialog = (transition: StatusTransition) => {
    setPendingTransition(transition);
    setTransitionError(null);
    setFailedPreconditions([]);
    setTransitionDialogOpen(true);
  };

  // ---- Publish Flow Handlers ----

  const handlePublish = async () => {
    if (!app) return;
    try {
      setPublishLoading(true);
      setPublishError(null);
      const result = await appApiService.publishApp(app.appId);
      if (onPublishSuccess) {
        setPublishDialogOpen(false);
        onPublishSuccess({
          appId: app.appId,
          appName: app.name,
          endpointUrl: result.endpointUrl,
          apiKey: result.apiKey,
        });
      } else {
        setPublishResult({
          endpointUrl: result.endpointUrl,
          apiKey: result.apiKey,
        });
      }
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Publishing failed';
      setPublishError(message);
    } finally {
      setPublishLoading(false);
    }
  };

  const handleCopyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Silently fail
    }
  };

  const handleCreateApiKey = async () => {
    if (!app || !newKeyName.trim()) return;
    try {
      setCreatingKey(true);
      await appApiService.createAppApiKey(app.appId, newKeyName.trim());
      setCreateKeyDialogOpen(false);
      setNewKeyName('');
      await loadApiData(timeRange);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create API key';
      setError(message);
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeApiKey = async (keyId: string) => {
    if (!app) return;
    try {
      await appApiService.revokeAppApiKey(app.appId, keyId);
      await loadApiData(timeRange);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to revoke API key';
      setError(message);
    }
  };

  const handleUnpublish = async () => {
    if (!app) return;
    try {
      setUnpublishLoading(true);
      setUnpublishWarnings([]);
      const result = await appApiService.unpublishApp(app.appId);
      if (result?.warnings && result.warnings.length > 0) {
        setUnpublishWarnings(result.warnings);
      } else {
        setUnpublishDialogOpen(false);
      }
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unpublish failed';
      setError(message);
    } finally {
      setUnpublishLoading(false);
    }
  };

  const executeTransition = async () => {
    if (!app || !pendingTransition) return;

    // For publish, check preconditions first
    if (pendingTransition.targetStatus === 'APPROVED') {
      const preconditions = buildPreconditions(app);
      const failing = preconditions.filter((p) => !p.passed);
      if (failing.length > 0) {
        setFailedPreconditions(preconditions);
        return;
      }
    }

    try {
      setTransitionLoading(true);
      setTransitionError(null);
      await appApiService.updateApp({
        appId: app.appId,
        version: app.version,
        status: pendingTransition.targetStatus,
      });
      setTransitionDialogOpen(false);
      await loadApp();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Status transition failed';
      setTransitionError(message);
    } finally {
      setTransitionLoading(false);
    }
  };

  // ---- Tab Renderers ----

  const renderAgentsTab = () => {
    const bindings = app?.agentBindings || [];
    return (
      <div className="flex flex-col gap-4">
        {/* Add Agent button */}
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            onClick={() => {
              loadAvailableAgents();
              setAddAgentDialogOpen(true);
            }}
          >
            <Plus className="size-3" /> Add Agent
          </Button>
        </div>

        {bindings.length === 0 ? (
          <div className="text-center py-12">
            <Bot className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm mb-3">No agents bound to this app.</p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => {
                loadAvailableAgents();
                setAddAgentDialogOpen(true);
              }}
            >
              <Plus className="size-3" /> Add Agent
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bindings.map((binding) => {
          const statusColors = COMPONENT_STATUS_COLORS[binding.status] || COMPONENT_STATUS_COLORS.DESIGN;
          const hasOverrides = !!(binding.systemPromptAddition || binding.toolRestrictions?.length || binding.modelOverride);
          return (
            <Card key={binding.agentId} className="rounded-lg border-border/50 p-4 gap-0">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="size-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm font-medium text-foreground truncate">{agentNameMap[binding.agentId] || binding.agentId}</span>
                </div>
                <Badge className={cn(statusColors.bg, statusColors.text, 'text-xs border-0 flex-shrink-0')}>
                  {binding.status}
                </Badge>
              </div>
              {/* Override indicators */}
              {hasOverrides && (
                <div className="flex gap-2 mb-2">
                  {binding.systemPromptAddition && (
                    <span title="System prompt addition" className="text-muted-foreground"><MessageSquare className="w-3.5 h-3.5" /></span>
                  )}
                  {binding.toolRestrictions && binding.toolRestrictions.length > 0 && (
                    <span title={`${binding.toolRestrictions.length} tool restriction(s)`} className="text-muted-foreground"><Wrench className="w-3.5 h-3.5" /></span>
                  )}
                  {binding.modelOverride && (
                    <span title={`Model: ${binding.modelOverride}`} className="text-muted-foreground"><Cpu className="w-3.5 h-3.5" /></span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 mt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-foreground h-7 px-2"
                  onClick={() => {
                    setEditingBinding(binding);
                    setEditBindingForm({
                      systemPromptAddition: binding.systemPromptAddition || '',
                      toolRestrictions: (binding.toolRestrictions || []).join(', '),
                      modelOverride: binding.modelOverride || '',
                      status: binding.status,
                    });
                  }}
                >
                  <Pencil className="size-3 mr-1" /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-destructive hover:text-destructive h-7 px-2"
                  onClick={() => handleRemoveAgent(binding.agentId)}
                >
                  <Trash2 className="size-3 mr-1" /> Remove
                </Button>
              </div>
            </Card>
          );
        })}
          </div>
        )}
      </div>
    );
  };

  const renderWorkflowsTab = () => {
    return (
      <div className="flex flex-col gap-4">
        {/* Bind Workflow button */}
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            onClick={() => {
              loadUnboundWorkflows();
              setBindWorkflowDialogOpen(true);
            }}
          >
            <Plus className="size-3" /> Bind Workflow
          </Button>
        </div>

        {workflows.length === 0 ? (
          <div className="text-center py-12">
            <GitBranch className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm mb-3">No workflows bound to this app.</p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => {
                loadUnboundWorkflows();
                setBindWorkflowDialogOpen(true);
              }}
            >
              <Plus className="size-3" /> Bind Workflow
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {workflows.map((wf) => (
              <Card key={wf.workflowId} className="rounded-lg border-border/50 p-4 gap-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-foreground truncate mr-2">{wf.name}</span>
                  <Badge className="text-xs border-0 bg-muted/20 text-muted-foreground">{wf.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-3">{wf.nodeCount} node{wf.nodeCount !== 1 ? 's' : ''}</p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground hover:text-foreground h-7 px-2"
                    onClick={() => onNavigate?.(`workflow-editor:${wf.workflowId}`)}
                  >
                    <ExternalLink className="size-3 mr-1" /> Open
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-destructive hover:text-destructive h-7 px-2"
                    onClick={() => handleUnbindWorkflow(wf.workflowId)}
                  >
                    <Trash2 className="size-3 mr-1" /> Unbind
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderPermissionsTab = () => {
    const perms = app?.permissions || [];
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            onClick={() => setAddPermDialogOpen(true)}
          >
            <Plus className="size-3" /> Add Permission
          </Button>
        </div>

        {perms.length === 0 ? (
          <div className="text-center py-12">
            <Shield className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm mb-1">No permissions declared for this app.</p>
            <p className="text-muted-foreground text-xs mb-3">Permissions are optional — agent tool bindings handle most credential scoping automatically.</p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => setAddPermDialogOpen(true)}
            >
              <Plus className="size-3" /> Add Permission
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Description</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Actions</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Resources</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium text-xs">Actions</th>
                </tr>
              </thead>
              <tbody>
                {perms.map((perm) => (
                  <tr key={perm.permissionId} className="border-b border-border/50 hover:bg-card">
                    <td className="py-2 px-3 text-foreground text-xs">{perm.description || '—'}</td>
                    <td className="py-2 px-3">
                      <div className="flex flex-wrap gap-1">
                        {perm.actions.map((action) => (
                          <Badge key={action} className="text-xs border-0 bg-primary/10 text-primary">{action}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground font-mono max-w-xs truncate">{perm.resources.join(', ')}</td>
                    <td className="py-2 px-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive h-7 px-2"
                        onClick={() => handleRemovePermission(perm.permissionId)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderConfigurationTab = () => {
    const hasSchema = !!app?.configSchema;
    const hasValues = !!app?.configValues;
    const parsedValues = (() => {
      try {
        return typeof app?.configValues === 'string' ? JSON.parse(app.configValues) : (app?.configValues || {});
      } catch { return {}; }
    })();

    return (
      <div className="flex flex-col gap-6">
        {/* Admin Email quick-set */}
        <Card className="rounded-lg border-border/50 bg-background p-4 gap-0">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-foreground">Admin Email</h3>
              <p className="text-xs text-muted-foreground mt-1">Contact email for notifications about this app</p>
            </div>
            {parsedValues.adminEmail ? (
              <span className="text-xs text-chart-2">{parsedValues.adminEmail}</span>
            ) : null}
          </div>
          <div className="flex gap-2 mt-2">
            <Input
              type="email"
              placeholder="admin@example.com"
              defaultValue={parsedValues.adminEmail || ''}
              className="text-xs h-8 bg-transparent border-border text-foreground"
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && app) {
                  const email = (e.target as HTMLInputElement).value.trim();
                  if (!email) return;
                  try {
                    const newValues = { ...parsedValues, adminEmail: email };
                    await appApiService.setAppConfigValues(app.appId, JSON.stringify(newValues), app.version);
                    await loadApp();
                  } catch (err: any) {
                    console.error('Failed to save admin email:', err);
                  }
                }
              }}
              id="admin-email-input"
            />
            <Button
              size="sm"
              className="text-xs h-8 bg-primary hover:bg-primary text-foreground"
              onClick={async () => {
                const input = document.getElementById('admin-email-input') as HTMLInputElement;
                const email = input?.value?.trim();
                if (!email || !app) return;
                try {
                  const newValues = { ...parsedValues, adminEmail: email };
                  await appApiService.setAppConfigValues(app.appId, JSON.stringify(newValues), app.version);
                  await loadApp();
                } catch (err: any) {
                  console.error('Failed to save admin email:', err);
                }
              }}
            >
              Save
            </Button>
          </div>
        </Card>
        {/* Schema (read-only) */}
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2">Configuration Schema</h3>
          {hasSchema ? (
            <Card className="rounded-lg border-border/50 bg-background p-4 text-xs text-muted-foreground font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre gap-0">
              {typeof app?.configSchema === 'string'
                ? JSON.stringify(JSON.parse(app.configSchema), null, 2)
                : JSON.stringify(app?.configSchema, null, 2)}
            </Card>
          ) : (
            <p className="text-xs text-muted-foreground">No configuration schema defined.</p>
          )}
        </div>

        {/* Values (editable) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-foreground">Configuration Values</h3>
            {hasValues && !editingConfigValues && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground h-7 px-2"
                onClick={() => {
                  const raw = app?.configValues;
                  try {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    setConfigValuesInput(JSON.stringify(parsed, null, 2));
                  } catch {
                    setConfigValuesInput(raw || '');
                  }
                  setEditingConfigValues(true);
                  setConfigSaveError(null);
                }}
              >
                <Pencil className="size-3 mr-1" /> Edit
              </Button>
            )}
          </div>
          {editingConfigValues ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={configValuesInput}
                onChange={(e) => setConfigValuesInput(e.target.value)}
                className="bg-transparent border border-input text-foreground font-mono text-xs"
                rows={8}
              />
              {configSaveError && <p className="text-xs text-destructive">{configSaveError}</p>}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="text-xs bg-primary hover:bg-primary text-foreground h-7"
                  onClick={handleSaveConfigValues}
                  disabled={configSaving}
                >
                  {configSaving ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => setEditingConfigValues(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : hasValues ? (
            <Card className="rounded-lg border-border/50 bg-background p-4 text-xs text-muted-foreground font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre gap-0">
              {typeof app?.configValues === 'string'
                ? JSON.stringify(JSON.parse(app.configValues), null, 2)
                : JSON.stringify(app?.configValues, null, 2)}
            </Card>
          ) : (
            <p className="text-xs text-muted-foreground">No configuration values set.</p>
          )}
        </div>
      </div>
    );
  };

  const renderExecutionsTab = () => {
    if (executions.length === 0) {
      return (
        <div className="text-center py-12">
          <Clock className="size-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">No executions recorded yet.</p>
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50">
              <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Execution ID</th>
              <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Workflow</th>
              <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Status</th>
              <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Started</th>
              <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Completed</th>
              <th className="text-right py-2 px-3 text-muted-foreground font-medium text-xs">Duration</th>
            </tr>
          </thead>
          <tbody>
            {executions.map((exec) => {
              const colors = EXECUTION_STATUS_COLORS[exec.status] || EXECUTION_STATUS_COLORS.PENDING;
              return (
                <tr key={exec.executionId} className="border-b border-border/50 hover:bg-card">
                  <td className="py-2 px-3 text-foreground text-xs font-mono">{exec.executionId.slice(0, 12)}...</td>
                  <td className="py-2 px-3 text-muted-foreground text-xs">{exec.workflowId}</td>
                  <td className="py-2 px-3">
                    <Badge className={cn(colors.bg, colors.text, 'text-xs border-0')}>{exec.status}</Badge>
                  </td>
                  <td className="py-2 px-3 text-muted-foreground text-xs">{formatDate(exec.startedAt)}</td>
                  <td className="py-2 px-3 text-muted-foreground text-xs">{exec.completedAt ? formatDate(exec.completedAt) : '—'}</td>
                  <td className="py-2 px-3 text-right text-muted-foreground text-xs">{computeDuration(exec.startedAt, exec.completedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderApiTab = () => {
    if (!app || app.status !== 'PUBLISHED') return null;

    const errorRate = metrics && metrics.totalRequests > 0
      ? (metrics.clientErrorCount + metrics.serverErrorCount) / metrics.totalRequests
      : 0;
    const health = getHealthStatus(errorRate);
    const healthStyle = HEALTH_COLORS[health];

    return (
      <div className="flex flex-col gap-6">
        {/* Endpoint URL */}
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2">Endpoint URL</h3>
          <Card className="flex-row items-center gap-2 rounded-lg border-border/50 bg-background p-3">
            <Globe className="size-4 text-muted-foreground flex-shrink-0" />
            <code className="text-sm text-muted-foreground font-mono flex-1 truncate">{app.endpointUrl}</code>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-foreground h-7 px-2 flex-shrink-0"
              onClick={() => handleCopyToClipboard(app.endpointUrl || '', 'endpoint')}
            >
              {copiedField === 'endpoint' ? <Check className="size-3 text-chart-2" /> : <Copy className="size-3" />}
              {copiedField === 'endpoint' ? ' Copied' : ' Copy'}
            </Button>
          </Card>
        </div>

        {/* Health Indicator */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Health:</span>
          <Badge className={cn(healthStyle.bg, healthStyle.text, 'text-xs border-0')}>
            {healthStyle.label}
          </Badge>
          {metrics && metrics.totalRequests > 0 && (
            <span className="text-xs text-muted-foreground">{(errorRate * 100).toFixed(1)}% error rate</span>
          )}
        </div>

        {/* Time Range Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Time range:</span>
          {TIME_RANGES.map((r) => (
            <Button
              key={r.label}
              variant="ghost"
              size="sm"
              className={cn(
                'text-xs h-7 px-2',
                timeRange === r.label ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTimeRange(r.label)}
            >
              {r.label}
            </Button>
          ))}
        </div>

        {/* Metrics Charts */}
        {metricsLoading ? (
          <div className="flex flex-col gap-4">
            <div className="h-40 bg-accent rounded animate-pulse" />
            <div className="h-40 bg-accent rounded animate-pulse" />
          </div>
        ) : metrics && metrics.timeSeries.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="rounded-lg border-border/50 bg-background p-4 gap-0">
              <h4 className="text-xs font-medium text-muted-foreground mb-3">Request Count</h4>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={metrics.timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" />
                  <XAxis dataKey="timestamp" tick={false} stroke="#333" />
                  {/* Recharts requires inline style objects for tick/tooltip configuration */}
                  <YAxis stroke="#333" tick={{ fontSize: 10, fill: '#666' }} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Line type="monotone" dataKey="requestCount" stroke="#3b82f6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
            <Card className="rounded-lg border-border/50 bg-background p-4 gap-0">
              <h4 className="text-xs font-medium text-muted-foreground mb-3">Error Rate</h4>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={metrics.timeSeries.map((b) => ({
                  ...b,
                  errorRate: b.requestCount > 0 ? (b.errorCount / b.requestCount) * 100 : 0,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" />
                  <XAxis dataKey="timestamp" tick={false} stroke="#333" />
                  {/* Recharts requires inline style objects for tick/tooltip configuration */}
                  <YAxis stroke="#333" tick={{ fontSize: 10, fill: '#666' }} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Line type="monotone" dataKey="errorRate" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
            <Card className="rounded-lg border-border/50 bg-background p-4 gap-0">
              <h4 className="text-xs font-medium text-muted-foreground mb-3">Latency</h4>
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={metrics.timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" />
                  <XAxis dataKey="timestamp" tick={false} stroke="#333" />
                  {/* Recharts requires inline style objects for tick/tooltip configuration */}
                  <YAxis stroke="#333" tick={{ fontSize: 10, fill: '#666' }} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Area type="monotone" dataKey="avgLatency" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.2} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No metrics data available for the selected time range.</p>
        )}

        {/* API Keys */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-foreground">API Keys</h3>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => setCreateKeyDialogOpen(true)}
            >
              <Plus className="size-3" /> Create API Key
            </Button>
          </div>

          {apiKeysLoading ? (
            <p className="text-xs text-muted-foreground">Loading API keys...</p>
          ) : apiKeys.length === 0 ? (
            <p className="text-xs text-muted-foreground">No API keys found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Name</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Prefix</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Status</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Created</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Expires</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium text-xs">Last Used</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium text-xs">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((key) => {
                    const keyStatusColors = key.status === 'ACTIVE'
                      ? { bg: 'bg-chart-2/20', text: 'text-chart-2' }
                      : { bg: 'bg-destructive/20', text: 'text-destructive' };
                    return (
                      <tr key={key.keyId} className="border-b border-border/50 hover:bg-card">
                        <td className="py-2 px-3 text-foreground text-xs">{key.name}</td>
                        <td className="py-2 px-3 text-muted-foreground text-xs font-mono">{key.prefix}</td>
                        <td className="py-2 px-3">
                          <Badge className={cn(keyStatusColors.bg, keyStatusColors.text, 'text-xs border-0')}>{key.status}</Badge>
                        </td>
                        <td className="py-2 px-3 text-muted-foreground text-xs">{formatDate(key.createdAt)}</td>
                        <td className="py-2 px-3 text-muted-foreground text-xs">{key.expiresAt ? formatDate(key.expiresAt) : '—'}</td>
                        <td className="py-2 px-3 text-muted-foreground text-xs">{key.lastUsedAt ? formatDate(key.lastUsedAt) : '—'}</td>
                        <td className="py-2 px-3 text-right">
                          {key.status === 'ACTIVE' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive h-7 px-2 text-xs"
                              onClick={() => handleRevokeApiKey(key.keyId)}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderPublishDialog = () => {
    if (!app || app.status !== 'APPROVED') return null;

    const preconditions = buildPreconditions(app);
    const allPassed = shouldEnablePublish(preconditions);

    return (
      <Dialog open={publishDialogOpen} onOpenChange={(open) => {
        setPublishDialogOpen(open);
        if (!open) {
          setPublishError(null);
          setPublishResult(null);
        }
      }}>
        <DialogContent className="bg-card border-border/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {publishResult ? 'Published Successfully' : 'Publish App'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {publishResult
                ? 'Your app has been published. Save the API key — it will not be shown again.'
                : `Review configuration for "${app.name}" before publishing.`}
            </DialogDescription>
          </DialogHeader>

          {publishResult ? (
            <div className="flex flex-col gap-4 my-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Endpoint URL</label>
                <Card className="flex-row items-center gap-2 rounded-md border-border/50 bg-background p-2">
                  <code className="text-xs text-muted-foreground font-mono flex-1 truncate">{publishResult.endpointUrl}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6 px-2 text-muted-foreground hover:text-foreground flex-shrink-0"
                    onClick={() => handleCopyToClipboard(publishResult.endpointUrl, 'pub-endpoint')}
                  >
                    {copiedField === 'pub-endpoint' ? <Check className="size-3 text-chart-2" /> : <Copy className="size-3" />}
                    {copiedField === 'pub-endpoint' ? ' Copied' : ' Copy'}
                  </Button>
                </Card>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">API Key (shown once)</label>
                <Card className="flex-row items-center gap-2 rounded-md border-border/50 bg-background p-2">
                  <code className="text-xs text-muted-foreground font-mono flex-1 truncate">{publishResult.apiKey}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6 px-2 text-muted-foreground hover:text-foreground flex-shrink-0"
                    onClick={() => handleCopyToClipboard(publishResult.apiKey, 'pub-apikey')}
                  >
                    {copiedField === 'pub-apikey' ? <Check className="size-3 text-chart-2" /> : <Copy className="size-3" />}
                    {copiedField === 'pub-apikey' ? ' Copied' : ' Copy'}
                  </Button>
                </Card>
              </div>
              <DialogFooter>
                <Button size="sm" className="text-xs" onClick={() => setPublishDialogOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              {/* App summary */}
              <div className="flex flex-col gap-2 my-2 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">App Name</span><span className="text-foreground">{app.name}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Agents</span><span className="text-foreground">{app.agentBindings.length} bound</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Workflows</span><span className="text-foreground">{app.workflowIds.length} bound</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Permissions</span><span className="text-foreground">{app.permissions.length} declared</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Config</span><span className="text-foreground">{app.configValues ? 'Provided' : 'None'}</span></div>
              </div>

              {/* Precondition checklist */}
              <div className="flex flex-col gap-2 my-2">
                <p className="text-xs font-medium text-muted-foreground">Preconditions:</p>
                {preconditions.map((pc, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      'flex items-start gap-2 rounded-md p-2 text-xs',
                      pc.passed ? 'bg-chart-2/10 text-chart-2' : 'bg-destructive/10 text-destructive',
                    )}
                  >
                    {pc.passed ? <CheckCircle2 className="size-4 flex-shrink-0 mt-0.5" /> : <XCircle className="size-4 flex-shrink-0 mt-0.5" />}
                    <div>
                      <p>{pc.label}</p>
                      {pc.detail && <p className="text-xs opacity-75 mt-0.5">{pc.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Error */}
              {publishError && (
                <div className="flex items-start gap-2 rounded-md p-2 bg-destructive/10 text-destructive text-xs my-2">
                  <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
                  <p>{publishError}</p>
                </div>
              )}

              <DialogFooter>
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => setPublishDialogOpen(false)}>
                  Cancel
                </Button>
                {publishError && (
                  <Button
                    size="sm"
                    className="text-xs bg-chart-4 hover:bg-chart-4 text-foreground"
                    onClick={handlePublish}
                  >
                    Retry
                  </Button>
                )}
                <Button
                  size="sm"
                  className="text-xs bg-chart-5 hover:bg-chart-5 text-foreground"
                  onClick={handlePublish}
                  disabled={!allPassed || publishLoading}
                >
                  {publishLoading ? <><Loader2 className="size-3 animate-spin mr-1" /> Publishing...</> : 'Confirm Publish'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    );
  };

  const renderTransitionDialog = () => {
    if (!pendingTransition || !app) return null;

    const preconditions = pendingTransition.targetStatus === 'APPROVED'
      ? (failedPreconditions.length > 0 ? failedPreconditions : buildPreconditions(app))
      : [];

    return (
      <Dialog open={transitionDialogOpen} onOpenChange={setTransitionDialogOpen}>
        <DialogContent className="bg-card border-border/50">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {pendingTransition.label} App
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {pendingTransition.targetStatus === 'APPROVED' && 'Transition this app from DRAFT to APPROVED. All preconditions must pass.'}
              {pendingTransition.targetStatus === 'DEPRECATED' && 'Archive this app. The scoped IAM role will be deleted and all agent bindings reset to DESIGN.'}
              {pendingTransition.targetStatus === 'DRAFT' && 'Reactivate this app to DRAFT status for further editing.'}
            </DialogDescription>
          </DialogHeader>

          {/* Preconditions for publish */}
          {preconditions.length > 0 && (
            <div className="flex flex-col gap-2 my-2">
              <p className="text-xs font-medium text-muted-foreground">Preconditions:</p>
              {preconditions.map((pc, idx) => (
                <div
                  key={idx}
                  className={cn(
                    'flex items-start gap-2 rounded-md p-2 text-xs',
                    pc.passed ? 'bg-chart-2/10 text-chart-2' : 'bg-destructive/10 text-destructive',
                  )}
                >
                  {pc.passed ? <CheckCircle2 className="size-4 flex-shrink-0 mt-0.5" /> : <XCircle className="size-4 flex-shrink-0 mt-0.5" />}
                  <div>
                    <p>{pc.label}</p>
                    {pc.detail && <p className="text-xs opacity-75 mt-0.5">{pc.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Transition error */}
          {transitionError && (
            <div className="flex items-start gap-2 rounded-md p-2 bg-destructive/10 text-destructive text-xs">
              <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
              <p>{transitionError}</p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => setTransitionDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className={cn('text-xs', pendingTransition.className)}
              onClick={executeTransition}
              disabled={transitionLoading || (pendingTransition.targetStatus === 'APPROVED' && failedPreconditions.some((p) => !p.passed))}
            >
              {transitionLoading ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              {pendingTransition.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  };

  // ---- Main Render ----

  if (loading) {
    return (
      <PageContainer>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col animate-pulse gap-4">
              <div className="h-6 bg-accent rounded w-1/3" />
              <div className="h-4 bg-accent rounded w-2/3" />
              <div className="h-4 bg-accent rounded w-1/2" />
              <div className="h-10 bg-accent rounded w-full mt-6" />
              <div className="h-40 bg-accent rounded w-full" />
            </div>
          </div>
      </PageContainer>
    );
  }

  if (error || !app) {
    return (
      <PageContainer>
          <div className="flex flex-col gap-6">
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" /> Back to Apps
            </Button>
            <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-4">
              <p className="text-destructive mb-2">{error || 'App not found'}</p>
              <Button variant="outline" size="sm" onClick={loadApp} className="gap-2 text-xs">
                Retry
              </Button>
            </div>
          </div>
      </PageContainer>
    );
  }

  const statusColors = STATUS_COLORS[app.status] || STATUS_COLORS.DRAFT;
  const transition = getStatusTransition(app.status);

  return (
    <PageContainer>
        <div className="flex flex-col gap-6">
          {/* Back button */}
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back to Apps
          </Button>

          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-semibold text-foreground truncate">{app.name}</h1>
                <Badge className={cn(statusColors.bg, statusColors.text, 'text-xs border-0')}>
                  {app.status}
                </Badge>
              </div>
              {app.description && (
                <p className="text-sm text-muted-foreground mb-2">{app.description}</p>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>Created by {app.createdBy || 'unknown'}</span>
                <span>Created {formatDate(app.createdAt)}</span>
                <span>Updated {formatDate(app.updatedAt)}</span>
              </div>
            </div>
            {transition && (
              <Button
                size="sm"
                className={cn('gap-1 text-xs flex-shrink-0 ml-4', transition.className)}
                onClick={() => openTransitionDialog(transition)}
              >
                <transition.icon className="size-4" />
                {transition.label}
              </Button>
            )}
            {app.status === 'APPROVED' && (
              <Button
                size="sm"
                className="gap-1 text-xs flex-shrink-0 ml-2 bg-chart-5 hover:bg-chart-5 text-foreground"
                onClick={() => {
                  setPublishError(null);
                  setPublishResult(null);
                  setPublishDialogOpen(true);
                }}
              >
                <Globe className="size-4" />
                Publish
              </Button>
            )}
            {app.status === 'PUBLISHED' && (
              <>
                <Button
                  size="sm"
                  className="gap-1 text-xs flex-shrink-0 ml-2 bg-primary hover:bg-primary text-foreground"
                  onClick={() => onNavigate?.(`app-api-dashboard:${app.appId}`)}
                >
                  <BarChart3 className="size-4" />
                  API Dashboard
                </Button>
                <Button
                  size="sm"
                  className="gap-1 text-xs flex-shrink-0 ml-2 bg-destructive hover:bg-destructive text-foreground"
                  onClick={() => {
                    setUnpublishWarnings([]);
                    setUnpublishDialogOpen(true);
                  }}
                >
                  <Archive className="size-4" />
                  Unpublish
                </Button>
              </>
            )}
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-card border border-border/50">
              <TabsTrigger value="agents" className="text-xs gap-1 data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground">
                <Bot className="w-3.5 h-3.5" /> Agents
              </TabsTrigger>
              <TabsTrigger value="workflows" className="text-xs gap-1 data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground">
                <GitBranch className="w-3.5 h-3.5" /> Workflows
              </TabsTrigger>
              <TabsTrigger value="permissions" className="text-xs gap-1 data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground">
                <Shield className="w-3.5 h-3.5" /> Permissions
              </TabsTrigger>
              <TabsTrigger value="configuration" className="text-xs gap-1 data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground">
                <Settings className="w-3.5 h-3.5" /> Configuration
              </TabsTrigger>
              <TabsTrigger value="executions" className="text-xs gap-1 data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground">
                <Play className="w-3.5 h-3.5" /> Executions
              </TabsTrigger>
              {app.status === 'PUBLISHED' && (
                <TabsTrigger value="api" className="text-xs gap-1 data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground">
                  <Activity className="w-3.5 h-3.5" /> API
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="agents" className="mt-4">{renderAgentsTab()}</TabsContent>
            <TabsContent value="workflows" className="mt-4">{renderWorkflowsTab()}</TabsContent>
            <TabsContent value="permissions" className="mt-4">{renderPermissionsTab()}</TabsContent>
            <TabsContent value="configuration" className="mt-4">{renderConfigurationTab()}</TabsContent>
            <TabsContent value="executions" className="mt-4">{renderExecutionsTab()}</TabsContent>
            {app.status === 'PUBLISHED' && (
              <TabsContent value="api" className="mt-4">{renderApiTab()}</TabsContent>
            )}
          </Tabs>
        </div>

      {/* Transition dialog */}
      {renderTransitionDialog()}

      {/* Publish dialog */}
      {renderPublishDialog()}

      {/* Unpublish dialog */}
      <Dialog open={unpublishDialogOpen} onOpenChange={(open) => {
        setUnpublishDialogOpen(open);
        if (!open) setUnpublishWarnings([]);
      }}>
        <DialogContent className="bg-card border-border/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Unpublish App</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will tear down the published resources for "{app?.name}".
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 my-2">
            <div className="rounded-md p-3 bg-destructive/10 border border-destructive/30 text-xs text-destructive">
              <p className="font-medium mb-1">Warning: The following actions will be performed:</p>
              <ul className="flex flex-col list-disc list-inside gap-1">
                <li>API Gateway endpoint will be deleted</li>
                <li>All active API keys will be revoked</li>
                <li>Scoped IAM role will be removed</li>
                <li>App status will return to DRAFT</li>
              </ul>
            </div>

            {unpublishWarnings.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-chart-4">Partial teardown warnings:</p>
                {unpublishWarnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md p-2 bg-chart-4/10 text-chart-4 text-xs">
                    <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
                    <p>{w}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setUnpublishDialogOpen(false)}>
              Cancel
            </Button>
            {unpublishWarnings.length > 0 ? (
              <Button size="sm" className="text-xs" onClick={() => setUnpublishDialogOpen(false)}>
                Done
              </Button>
            ) : (
              <Button
                size="sm"
                className="text-xs bg-destructive hover:bg-destructive text-foreground"
                onClick={handleUnpublish}
                disabled={unpublishLoading}
              >
                {unpublishLoading ? <><Loader2 className="size-3 animate-spin mr-1" /> Unpublishing...</> : 'Confirm Unpublish'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create API Key dialog */}
      <Dialog open={createKeyDialogOpen} onOpenChange={setCreateKeyDialogOpen}>
        <DialogContent className="bg-card border-border/50 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-foreground">Create New API Key</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Enter a name for the new API key.
            </DialogDescription>
          </DialogHeader>
          <div className="my-2">
            <label className="text-xs text-muted-foreground mb-1 block">Key Name</label>
            <Input
              placeholder="e.g. Production, Staging"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="bg-transparent border border-input text-foreground text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setCreateKeyDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-xs bg-primary hover:bg-primary text-foreground"
              onClick={handleCreateApiKey}
              disabled={creatingKey || !newKeyName.trim()}
            >
              {creatingKey ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Agent dialog */}
      <Dialog open={addAgentDialogOpen} onOpenChange={setAddAgentDialogOpen}>
        <DialogContent className="bg-card border-border/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Add Agent to App</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Select an active agent to bind to this app.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col max-h-80 overflow-y-auto gap-2 my-2">
            {loadingAgents ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <Loader2 className="size-4 animate-spin" /> Loading agents...
              </div>
            ) : availableAgents.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">No available agents to add.</p>
            ) : (
              availableAgents.map((agent) => (
                <Card
                  key={agent.agentId}
                  className="flex-row items-center justify-between rounded-lg border-border/50 bg-background p-3 hover:border-border transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-sm font-medium text-foreground truncate">{agent.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{agent.description || 'No description'}</p>
                  </div>
                  <Button
                    size="sm"
                    className="text-xs bg-primary hover:bg-primary text-foreground h-7 px-3 flex-shrink-0"
                    onClick={() => handleAddAgent(agent.agentId)}
                    disabled={addingAgent === agent.agentId}
                  >
                    {addingAgent === agent.agentId ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <>
                        <Plus className="size-3 mr-1" /> Add
                      </>
                    )}
                  </Button>
                </Card>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setAddAgentDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Binding dialog */}
      <Dialog open={!!editingBinding} onOpenChange={(open: boolean) => { if (!open) setEditingBinding(null); }}>
        <DialogContent className="bg-card border-border/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Edit Binding — {editingBinding?.agentId}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Update the override settings for this agent binding.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 my-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">System Prompt Addition</label>
              <Textarea
                value={editBindingForm.systemPromptAddition}
                onChange={(e) => setEditBindingForm((f) => ({ ...f, systemPromptAddition: e.target.value }))}
                className="bg-transparent border border-input text-foreground text-xs"
                rows={3}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tool Restrictions (comma-separated)</label>
              <Input
                value={editBindingForm.toolRestrictions}
                onChange={(e) => setEditBindingForm((f) => ({ ...f, toolRestrictions: e.target.value }))}
                className="bg-transparent border border-input text-foreground text-xs"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Model Override</label>
              <ModelOverrideSelect
                id="model-override"
                aria-label="Model override"
                value={editBindingForm.modelOverride}
                onChange={(v) => setEditBindingForm((f) => ({ ...f, modelOverride: v }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Status</label>
              <Select
                value={editBindingForm.status}
                onValueChange={(val) => setEditBindingForm((f) => ({ ...f, status: val }))}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DESIGN">DESIGN</SelectItem>
                  <SelectItem value="READY">READY</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setEditingBinding(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-xs bg-primary hover:bg-primary text-foreground"
              onClick={handleUpdateBinding}
              disabled={editBindingSaving}
            >
              {editBindingSaving ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bind Workflow dialog */}
      <Dialog open={bindWorkflowDialogOpen} onOpenChange={setBindWorkflowDialogOpen}>
        <DialogContent className="bg-card border-border/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Bind Workflow to App</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Select a workflow to bind to this app.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col max-h-80 overflow-y-auto gap-2 my-2">
            {loadingUnboundWorkflows ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <Loader2 className="size-4 animate-spin" /> Loading workflows...
              </div>
            ) : unboundWorkflows.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">No available workflows to bind.</p>
            ) : (
              unboundWorkflows.map((wf) => (
                <Card
                  key={wf.workflowId}
                  className="flex-row items-center justify-between rounded-lg border-border/50 bg-background p-3 hover:border-border transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-sm font-medium text-foreground truncate">{wf.name}</p>
                    <p className="text-xs text-muted-foreground">{wf.status}</p>
                  </div>
                  <Button
                    size="sm"
                    className="text-xs bg-primary hover:bg-primary text-foreground h-7 px-3 flex-shrink-0"
                    onClick={() => handleBindWorkflow(wf.workflowId)}
                    disabled={bindingWorkflow === wf.workflowId}
                  >
                    {bindingWorkflow === wf.workflowId ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <>
                        <Plus className="size-3 mr-1" /> Bind
                      </>
                    )}
                  </Button>
                </Card>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setBindWorkflowDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Permission dialog */}
      <Dialog open={addPermDialogOpen} onOpenChange={setAddPermDialogOpen}>
        <DialogContent className="bg-card border-border/50 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Add Permission</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Declare IAM actions and resource ARNs for this app's scoped role.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 my-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Description</label>
              <Input
                placeholder="e.g. S3 read access for reports bucket"
                value={permForm.description}
                onChange={(e) => setPermForm((f) => ({ ...f, description: e.target.value }))}
                className="bg-transparent border border-input text-foreground text-xs"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Actions (comma-separated)</label>
              <Input
                placeholder="e.g. s3:GetObject, s3:PutObject, dynamodb:Query"
                value={permForm.actions}
                onChange={(e) => setPermForm((f) => ({ ...f, actions: e.target.value }))}
                className="bg-transparent border border-input text-foreground text-xs"
              />
              <p className="text-xs text-muted-foreground mt-1">Format: service:Action (e.g. s3:GetObject). Bare * is not allowed.</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Resources (comma-separated ARN patterns)</label>
              <Input
                placeholder="e.g. arn:aws:s3:::my-bucket/*, arn:aws:dynamodb:*:*:table/my-table"
                value={permForm.resources}
                onChange={(e) => setPermForm((f) => ({ ...f, resources: e.target.value }))}
                className="bg-transparent border border-input text-foreground text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setAddPermDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="text-xs bg-primary hover:bg-primary text-foreground"
              onClick={handleAddPermission}
              disabled={addingPerm}
            >
              {addingPerm ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              Add Permission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
