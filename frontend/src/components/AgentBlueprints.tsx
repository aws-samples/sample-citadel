import { useState, useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, type NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AgentTray } from './AgentTray';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowToolbar } from './WorkflowToolbar';
import { NodeConfigurationPanel } from './NodeConfigurationPanel';
import { EdgeConditionSheet } from './EdgeConditionSheet';
import { ExecutionOverlay } from './ExecutionOverlay';
import { ExecutionHistoryPanel } from './ExecutionHistoryPanel';
import { RunWorkflowDialog } from './RunWorkflowDialog';
import { Button } from './ui/button';
import type { WorkflowNode, WorkflowEdge, EdgeCondition, ValidationResult } from '../types/workflow';
import { validateWorkflow, serializeWorkflow, deserializeWorkflow, applyConditionStyle, clearConditionStyle } from '../services/workflowService';
import { workflowApiService } from '../services/workflowApiService';
import { executionApiService } from '../services/executionApiService';
import { agentConfigService, type AgentConfig } from '../services/agentConfigService';
import { useWorkflowPersistence } from '../hooks/useWorkflowPersistence';
import { useExecutionSubscription } from '../hooks/useExecutionSubscription';
import { useOrganization } from '../contexts/OrganizationContext';
import { mapExecutionToNodeStatus } from '../services/mapExecutionToNodeStatus';
import { workflowAutosaveStorageKey } from '../utils/userScopedStorage';

const AUTOSAVE_DELAY = 2000; // 2 seconds debounce before first server create
const VALIDATION_DELAY = 500; // 500ms debounce

type WorkflowStatus = 'DRAFT' | 'PUBLISHED';

export interface AgentBlueprintsProps {
  /**
   * When provided, the canvas opens this existing server workflow instead of
   * starting blank: the definition is hydrated into nodes/edges and autosave
   * updates this workflow rather than creating a new one.
   */
  workflowId?: string;
}

export function AgentBlueprints({ workflowId: initialWorkflowId }: AgentBlueprintsProps = {}) {
  const navigate = useNavigate();
  const { workflowId: routeWorkflowId } = useParams<{ workflowId?: string }>();
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [configNode, setConfigNode] = useState<WorkflowNode | null>(null);
  const [isConfigPanelOpen, setIsConfigPanelOpen] = useState(false);
  const [conditionEdge, setConditionEdge] = useState<WorkflowEdge | null>(null);
  const [isEdgeSheetOpen, setIsEdgeSheetOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  // Server persistence + live execution state
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('DRAFT');
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);

  const { currentUser, canApproveExecutions } = useOrganization();
  const orgId = currentUser?.organization || null;
  const orgMissingMessage = 'Your account has no organisation; ask an admin to assign one';
  // Namespaced by the signed-in user so a different user on the same browser
  // never restores this user's unsaved canvas draft. Falls back to a fixed
  // sentinel when no user is known yet (e.g. profile still loading) so the
  // draft is still usable within that session, never cross-user.
  const autosaveKey = workflowAutosaveStorageKey(currentUser?.userId ?? 'anonymous');

  // Server-side autosave (debounced update + conflict handling + offline fallback).
  const { save, isSaving, lastSaved, conflict, workflow } = useWorkflowPersistence(workflowId);

  // Live per-node execution updates over the onWorkflowProgress subscription.
  const { nodeResults, executionStatus } = useExecutionSubscription(executionId);

  const workflowIdRef = useRef<string | null>(null);
  const versionRef = useRef<number>(1);
  const creatingRef = useRef(false);
  const nameRef = useRef<string>('Untitled Workflow');
  // Hydrating an existing workflow sets nodes/edges without user input; skip
  // the autosave those state changes would otherwise schedule.
  const skipNextSaveRef = useRef(false);

  // Merge per-node execution status into node data so AgentNode can render
  // badges. Runs whenever nodeResults changes. Clears when executionId resets.
  const prevExecIdRef = useRef<string | null>(null);
  useEffect(() => {
    // When a new execution starts, clear old badges
    if (executionId !== prevExecIdRef.current) {
      prevExecIdRef.current = executionId;
      if (!executionId) {
        // No active execution — clear all execution statuses
        setNodes((nds) =>
          nds.map((n) => (n.data.executionStatus ? { ...n, data: { ...n.data, executionStatus: undefined } } : n))
        );
        return;
      }
    }

    if (!executionId) return;
    const statusMap = mapExecutionToNodeStatus(nodeResults as Record<string, import('./ExecutionOverlay').NodeResultEntry>, nodes);
    const needsUpdate = nodes.some((n) => n.data.executionStatus !== statusMap[n.id]);
    if (!needsUpdate) return;

    skipNextSaveRef.current = true;
    setNodes((nds) =>
      nds.map((n) => {
        const newStatus = statusMap[n.id];
        if (n.data.executionStatus === newStatus) return n;
        return { ...n, data: { ...n.data, executionStatus: newStatus } };
      })
    );
  }, [nodeResults, executionId, nodes, setNodes]);

  // Build nodeLabels map for the ExecutionOverlay summary
  const nodeLabels = Object.fromEntries(nodes.map((n) => [n.id, n.data.label]));

  // Keep a synchronous mirror of workflowId so the debounced create effect never
  // races into a second createWorkflow call.
  useEffect(() => {
    workflowIdRef.current = workflowId;
  }, [workflowId]);

  // URL sync: when the canvas has an active workflowId that differs from the
  // current route, update the URL so a page reload re-opens this workflow.
  useEffect(() => {
    if (!workflowId) return;
    if (routeWorkflowId === workflowId) return;
    navigate(`/agentic-studio/workflows/${workflowId}`, { replace: true });
  }, [workflowId, routeWorkflowId, navigate]);

  // Track the server's version for optimistic-locking on subsequent saves.
  // Version is monotonic; we never let it downgrade the locally-tracked publish status.
  useEffect(() => {
    if (workflow && typeof workflow.version === 'number') {
      versionRef.current = workflow.version;
    }
  }, [workflow]);

  /**
   * Restore an unsaved/offline canvas from local storage on mount. This is a
   * best-effort fallback layer beneath server persistence — the server workflow
   * is the source of truth once a workflowId exists. Skipped entirely when the
   * canvas is opening an existing server workflow.
   *
   * Lenient restore: if any saved nodes reference agents that no longer exist
   * in the catalog, the nodes are still rendered but marked as placeholders
   * (data.isPlaceholder = true) and a single informational toast names the
   * missing agents (deduped). This avoids surfacing a confusing error for a
   * stale draft the user did not explicitly open.
   */
  useEffect(() => {
    if (initialWorkflowId) return;
    let cancelled = false;

    (async () => {
      try {
        const saved = localStorage.getItem(autosaveKey);
        if (!saved) return;

        const { nodes: savedNodes, edges: savedEdges } = JSON.parse(saved);
        if (!Array.isArray(savedNodes) || savedNodes.length === 0 || !Array.isArray(savedEdges)) return;

        // Fetch current agent catalog to detect stale agent references.
        let catalogIds: Set<string>;
        try {
          const configs = await agentConfigService.listAgentConfigs();
          catalogIds = new Set(configs.map((c: { agentId: string }) => c.agentId));
        } catch {
          // Catalog unavailable — restore nodes as-is (no placeholder check).
          if (!cancelled) {
            setNodes(savedNodes);
            setEdges(savedEdges);
          }
          return;
        }

        if (cancelled) return;

        // Identify missing agents (deduped).
        const missingSet = new Set<string>();
        for (const node of savedNodes) {
          const agentId = node?.data?.agentId;
          if (agentId && !catalogIds.has(agentId)) {
            missingSet.add(agentId);
          }
        }

        if (missingSet.size > 0) {
          // Mark stale nodes as placeholders so the canvas renders them with
          // a visual cue rather than treating them as fully healthy.
          const patchedNodes = savedNodes.map((node: WorkflowNode) => {
            if (node?.data?.agentId && missingSet.has(node.data.agentId)) {
              return { ...node, data: { ...node.data, isPlaceholder: true } };
            }
            return node;
          });

          setNodes(patchedNodes);
          setEdges(savedEdges);

          const names = [...missingSet].join(', ');
          toast.info(`Draft restored; ${missingSet.size} agent${missingSet.size > 1 ? 's' : ''} no longer exist: ${names}`);
        } else {
          setNodes(savedNodes);
          setEdges(savedEdges);
        }
      } catch (error) {
        console.error('Failed to restore local workflow cache:', error);
        localStorage.removeItem(autosaveKey);
      }
    })();

    return () => { cancelled = true; };
  }, [initialWorkflowId, autosaveKey]);

  /**
   * Load-by-id hydration: when opened with an existing workflowId (e.g. an
   * imported or app-bound workflow), fetch it, deserialize its definition into
   * canvas nodes/edges, and adopt its id/version/status so autosave UPDATES
   * this workflow and Publish/Run gate on its real status. On failure, surface
   * the error and fall back to a blank canvas.
   */
  useEffect(() => {
    if (!initialWorkflowId) return;
    let cancelled = false;

    (async () => {
      try {
        const wf = await workflowApiService.getWorkflow(initialWorkflowId);
        if (!wf) {
          throw new Error(`Workflow ${initialWorkflowId} not found`);
        }
        const definition =
          typeof wf.definition === 'string' ? JSON.parse(wf.definition) : wf.definition;

        // Build a lenient agent-config map: agents referenced by the definition
        // but absent from the catalog (e.g. app-bound ids created by blueprint
        // import) get a placeholder so the workflow still opens. The lenient
        // flag on deserializeWorkflow handles this automatically and reports
        // which agents were substituted.
        let configs: AgentConfig[] = [];
        try {
          configs = await agentConfigService.listAgentConfigs();
        } catch (configError) {
          console.error('Failed to list agent configs; using placeholders:', configError);
        }
        const configMap = new Map<string, AgentConfig>(configs.map((c) => [c.agentId, c]));

        const { nodes: loadedNodes, edges: loadedEdges, missingAgents } = await deserializeWorkflow(
          definition,
          configMap,
          undefined,
          { lenient: true }
        );
        if (cancelled) return;

        workflowIdRef.current = wf.workflowId;
        versionRef.current = typeof wf.version === 'number' ? wf.version : 1;
        nameRef.current = wf.name || nameRef.current;
        skipNextSaveRef.current = true;
        setWorkflowId(wf.workflowId);
        setWorkflowStatus(wf.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT');
        setNodes(loadedNodes);
        setEdges(loadedEdges);
        setLoadError(null);

        if (missingAgents && missingAgents.length > 0) {
          const names = missingAgents.join(', ');
          toast.info(
            `Draft restored; ${missingAgents.length} agent${missingAgents.length > 1 ? 's' : ''} no longer exist: ${names}`
          );
        }
      } catch (error: any) {
        if (cancelled) return;
        console.error('Failed to load workflow', initialWorkflowId, error);
        setLoadError(error?.message || 'Failed to load workflow');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialWorkflowId]);

  /**
   * First server persistence: once the canvas has content and no server
   * workflow exists yet, create one so the canvas gets a durable workflowId.
   * Debounced and guarded against duplicate creates.
   */
  useEffect(() => {
    if (workflowId) return;
    if (nodes.length === 0 && edges.length === 0) return;
    if (!orgId) return;
    const timer = setTimeout(async () => {
      if (creatingRef.current || workflowIdRef.current) return;
      creatingRef.current = true;
      try {
        const definition = JSON.stringify(serializeWorkflow(nodes, edges, { name: nameRef.current }));
        const created = await workflowApiService.createWorkflow({
          name: nameRef.current,
          orgId,
          definition,
        });
        workflowIdRef.current = created.workflowId;
        versionRef.current = typeof created.version === 'number' ? created.version : 1;
        setWorkflowId(created.workflowId);
        setWorkflowStatus(created.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT');
      } catch (error) {
        console.error('Failed to create workflow on server; keeping local fallback:', error);
        try {
          localStorage.setItem(
            autosaveKey,
            JSON.stringify({ nodes, edges, timestamp: new Date().toISOString() })
          );
        } catch (storageError) {
          console.error('Failed to write offline fallback:', storageError);
        }
      } finally {
        creatingRef.current = false;
      }
    }, AUTOSAVE_DELAY);

    return () => clearTimeout(timer);
  }, [nodes, edges, workflowId, orgId, autosaveKey]);

  /**
   * Subsequent autosave: once a workflowId exists, delegate to the persistence
   * hook, which debounces the updateWorkflow mutation, handles version conflicts,
   * and falls back to local storage when offline.
   */
  useEffect(() => {
    if (!workflowId) return;
    if (nodes.length === 0 && edges.length === 0) return;
    // Hydration sets nodes/edges from the server copy — nothing changed, so
    // don't schedule a redundant (or PUBLISHED-mutating) save for it.
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const definition = JSON.stringify(serializeWorkflow(nodes, edges, { name: nameRef.current }));
    save({ workflowId, version: versionRef.current, definition });
  }, [nodes, edges, workflowId, save]);

  /**
   * Auto-validate workflow when nodes or edges change with debouncing.
   */
  useEffect(() => {
    if (nodes.length === 0 && edges.length === 0) {
      setValidationResult(null);
      return;
    }

    const validationTimer = setTimeout(() => {
      const result = validateWorkflow(nodes, edges);
      setValidationResult(result);
    }, VALIDATION_DELAY);

    return () => clearTimeout(validationTimer);
  }, [nodes, edges]);

  /**
   * Handle loading a workflow from file
   */
  const handleLoad = useCallback((loadedNodes: WorkflowNode[], loadedEdges: WorkflowEdge[]) => {
    setNodes(loadedNodes);
    setEdges(loadedEdges);
  }, []);

  /**
   * Handle clearing the canvas
   */
  const handleClear = useCallback(() => {
    setNodes([]);
    setEdges([]);
    localStorage.removeItem(autosaveKey);
  }, [autosaveKey]);

  /**
   * Handle double-clicking a node to open configuration panel
   */
  const handleNodeDoubleClick: NodeMouseHandler = useCallback((_event, node) => {
    setConfigNode(node as WorkflowNode);
    setIsConfigPanelOpen(true);
  }, []);

  /**
   * Handle saving node configuration
   */
  const handleSaveConfiguration = useCallback((nodeId: string, configuration: Record<string, any>) => {
    setNodes((nds) =>
      nds.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                configuration,
              },
            }
          : node
      )
    );
  }, []);

  /**
   * Handle renaming a node from the configuration panel
   */
  const handleRenameNode = useCallback((nodeId: string, label: string) => {
    setNodes((nds) =>
      nds.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                label,
              },
            }
          : node
      )
    );
  }, []);

  /**
   * Handle closing configuration panel
   */
  const handleCloseConfiguration = useCallback(() => {
    setIsConfigPanelOpen(false);
    setConfigNode(null);
  }, []);

  /**
   * Handle double-clicking an edge to open the condition editor
   */
  const handleEdgeDoubleClick = useCallback((_event: React.MouseEvent, edge: WorkflowEdge) => {
    setConditionEdge(edge);
    setIsEdgeSheetOpen(true);
  }, []);

  /**
   * Apply a condition to the currently selected edge
   */
  const handleApplyCondition = useCallback((condition: EdgeCondition) => {
    if (!conditionEdge) return;
    setEdges((eds) =>
      eds.map((e) =>
        e.id === conditionEdge.id ? applyConditionStyle(e, condition) : e,
      ),
    );
    setIsEdgeSheetOpen(false);
    setConditionEdge(null);
  }, [conditionEdge, setEdges]);

  /**
   * Remove condition from the currently selected edge
   */
  const handleRemoveCondition = useCallback(() => {
    if (!conditionEdge) return;
    setEdges((eds) =>
      eds.map((e) => {
        if (e.id !== conditionEdge.id) return e;
        return clearConditionStyle(e);
      }),
    );
    setIsEdgeSheetOpen(false);
    setConditionEdge(null);
  }, [conditionEdge, setEdges]);

  /**
   * Close the edge condition sheet
   */
  const handleCloseEdgeSheet = useCallback(() => {
    setIsEdgeSheetOpen(false);
    setConditionEdge(null);
  }, []);

  /**
   * Publish the current workflow. Surfaces server-side validation errors and,
   * on success, unlocks the Run control by moving the workflow to PUBLISHED.
   */
  const handlePublish = useCallback(async () => {
    if (!workflowId) return;
    setPublishError(null);
    setIsPublishing(true);
    try {
      const published = await workflowApiService.publishWorkflow(workflowId);
      if (published && typeof published.version === 'number') {
        versionRef.current = published.version;
      }
      setWorkflowStatus(published?.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED');
      toast.success('Workflow published');
    } catch (error: any) {
      const message = error?.message || 'Failed to publish workflow';
      setPublishError(message);
      toast.error('Failed to publish workflow', { description: message });
    } finally {
      setIsPublishing(false);
    }
  }, [workflowId]);

  /**
   * Start an execution for the published workflow and hand the returned
   * executionId to the progress subscription so node badges go live.
   */
  const handleRun = useCallback(async (_wfId?: string, input?: string) => {
    if (!workflowId) return;
    setRunDialogOpen(false);
    try {
      const execution = await executionApiService.startExecution(workflowId, input);
      if (execution?.executionId) {
        setExecutionId(execution.executionId);
      }
      if (input) {
        toast.success('Workflow started', { description: `Input: ${input.length > 80 ? input.slice(0, 80) + '…' : input}` });
      }
    } catch (error: any) {
      toast.error('Failed to start execution', {
        description: error?.message || 'Unknown error',
      });
    }
  }, [workflowId]);

  /**
   * Cancel the in-flight execution.
   */
  const handleCancel = useCallback(async () => {
    if (!executionId) return;
    try {
      await executionApiService.cancelExecution(executionId);
    } catch (error) {
      console.error('Failed to cancel execution:', error);
    }
  }, [executionId]);

  /**
   * Pause the running execution so it enters an approval gate.
   */
  const handlePause = useCallback(async (execId: string) => {
    try {
      await executionApiService.pauseExecution(execId, 'Paused by user');
    } catch (error: any) {
      toast.error('Failed to pause execution', {
        description: error?.message || 'Unknown error',
      });
    }
  }, []);

  /**
   * Approve the execution that is awaiting approval, using the current node.
   */
  const handleApprove = useCallback(async (execId: string) => {
    try {
      const execution = await executionApiService.getExecution(execId);
      const nodeId = execution?.currentNode || '';
      await executionApiService.approveExecution(execId, nodeId);
    } catch (error: any) {
      toast.error('Failed to approve execution', {
        description: error?.message || 'Unknown error',
      });
    }
  }, []);

  /**
   * Deny the execution that is awaiting approval, using the current node.
   */
  const handleDeny = useCallback(async (execId: string) => {
    try {
      const execution = await executionApiService.getExecution(execId);
      const nodeId = execution?.currentNode || '';
      await executionApiService.denyExecution(execId, nodeId, 'Denied by user');
    } catch (error: any) {
      toast.error('Failed to deny execution', {
        description: error?.message || 'Unknown error',
      });
    }
  }, []);

  const saveStatusLabel = conflict
    ? 'Conflict — reloaded latest from server'
    : isSaving
      ? 'Saving…'
      : lastSaved
        ? 'Saved'
        : null;

  return (
    <ReactFlowProvider>
      <div className="flex flex-col h-full bg-background">
        {/* Skip to main content link for keyboard navigation */}
        <a
          href="#workflow-canvas"
          className="skip-to-content"
          aria-label="Skip to workflow canvas"
        >
          Skip to workflow canvas
        </a>

        {/* Workflow Toolbar */}
        <WorkflowToolbar
          nodes={nodes}
          edges={edges}
          onLoad={handleLoad}
          onClear={handleClear}
          orgId={orgId ?? ''}
          workflowName={nameRef.current}
          validationResult={validationResult}
        />

        {/* Publish + run controls */}
        <div
          data-testid="run-controls"
          className="flex items-center gap-3 px-4 py-2 bg-card border-b border-border"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePublish}
            disabled={!workflowId || workflowStatus === 'PUBLISHED' || isPublishing}
            title={
              !workflowId
                ? 'Add to the canvas to create a workflow before publishing'
                : 'Publish this workflow to enable execution'
            }
          >
            {workflowStatus === 'PUBLISHED' ? 'Published' : 'Publish'}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsHistoryOpen((open) => !open)}
            disabled={!workflowId}
            aria-pressed={isHistoryOpen}
            title={
              workflowId
                ? 'Show past executions for this workflow'
                : 'Create a workflow to view its execution history'
            }
          >
            History
          </Button>

          {saveStatusLabel && (
            <span
              data-testid="save-status"
              className={`text-xs ${conflict ? 'text-destructive' : 'text-muted-foreground'}`}
              role="status"
              aria-live="polite"
            >
              {saveStatusLabel}
            </span>
          )}

          {/* Execution controls + live per-node status badges */}
          <ExecutionOverlay
            nodeResults={nodeResults as any}
            executionStatus={executionStatus}
            workflowStatus={workflowStatus}
            onRun={() => setRunDialogOpen(true)}
            onCancel={handleCancel}
            executionId={executionId}
            canApproveExecutions={canApproveExecutions}
            onPause={handlePause}
            onApprove={handleApprove}
            onDeny={handleDeny}
            nodeLabels={nodeLabels}
          />
        </div>

        {/* Load-by-id failure surfaced to the user (canvas stays blank) */}
        {loadError && (
          <div
            role="alert"
            className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/20"
          >
            Failed to load workflow: {loadError}
          </div>
        )}

        {/* No caller organization: block server persistence, tell the user why */}
        {!orgId && (
          <div
            role="alert"
            className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/20"
          >
            {orgMissingMessage}
          </div>
        )}

        {/* Publish validation errors surfaced to the user */}
        {publishError && (
          <div
            role="alert"
            className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/20"
          >
            {publishError}
          </div>
        )}

        <div className="flex flex-1 min-h-0 overflow-hidden relative">
          {/* Agent Tray Sidebar */}
          <AgentTray />

          {/* Workflow Canvas */}
          <main id="workflow-canvas" aria-label="Workflow builder main area" className="flex-1 min-h-0 min-w-0">
            <WorkflowCanvas
              nodes={nodes}
              edges={edges}
              setNodes={setNodes}
              setEdges={setEdges}
              onNodeDoubleClick={handleNodeDoubleClick}
              onEdgeDoubleClick={handleEdgeDoubleClick}
              validationResult={validationResult}
            />
          </main>

          {/* Past executions for the active workflow, keyed by workflowId */}
          {workflowId && (
            <ExecutionHistoryPanel
              key={workflowId}
              workflowId={workflowId}
              isOpen={isHistoryOpen}
              onClose={() => setIsHistoryOpen(false)}
            />
          )}
        </div>

        {/* Node Configuration Panel */}
        <NodeConfigurationPanel
          node={configNode}
          isOpen={isConfigPanelOpen}
          onClose={handleCloseConfiguration}
          onSave={handleSaveConfiguration}
          onRename={handleRenameNode}
        />

        {/* Edge Condition Sheet */}
        <EdgeConditionSheet
          edge={conditionEdge}
          nodes={nodes}
          isOpen={isEdgeSheetOpen}
          onClose={handleCloseEdgeSheet}
          onApply={handleApplyCondition}
          onRemove={handleRemoveCondition}
        />

        {/* Run workflow dialog */}
        {workflowId && (
          <RunWorkflowDialog
            open={runDialogOpen}
            onOpenChange={setRunDialogOpen}
            workflowId={workflowId}
            onRun={handleRun}
          />
        )}
      </div>
    </ReactFlowProvider>
  );
}
