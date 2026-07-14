import { useState, useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, type NodeMouseHandler } from 'reactflow';
import 'reactflow/dist/style.css';
import { toast } from 'sonner';
import { AgentTray } from './AgentTray';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowToolbar } from './WorkflowToolbar';
import { NodeConfigurationPanel } from './NodeConfigurationPanel';
import { ExecutionOverlay } from './ExecutionOverlay';
import { Button } from './ui/button';
import type { WorkflowNode, WorkflowEdge, ValidationResult } from '../types/workflow';
import { validateWorkflow, serializeWorkflow } from '../services/workflowService';
import { workflowApiService } from '../services/workflowApiService';
import { executionApiService } from '../services/executionApiService';
import { useWorkflowPersistence } from '../hooks/useWorkflowPersistence';
import { useExecutionSubscription } from '../hooks/useExecutionSubscription';
import { useOrganization } from '../contexts/OrganizationContext';

const AUTOSAVE_KEY = 'workflow-autosave';
const AUTOSAVE_DELAY = 2000; // 2 seconds debounce before first server create
const VALIDATION_DELAY = 500; // 500ms debounce

type WorkflowStatus = 'DRAFT' | 'PUBLISHED';

export function AgentBlueprints() {
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [configNode, setConfigNode] = useState<WorkflowNode | null>(null);
  const [isConfigPanelOpen, setIsConfigPanelOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  // Server persistence + live execution state
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('DRAFT');
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);

  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || 'default';

  // Server-side autosave (debounced update + conflict handling + offline fallback).
  const { save, isSaving, lastSaved, conflict, workflow } = useWorkflowPersistence(workflowId);

  // Live per-node execution updates over the onWorkflowProgress subscription.
  const { nodeResults, executionStatus } = useExecutionSubscription(executionId);

  const workflowIdRef = useRef<string | null>(null);
  const versionRef = useRef<number>(1);
  const creatingRef = useRef(false);
  const nameRef = useRef<string>('Untitled Workflow');

  // Keep a synchronous mirror of workflowId so the debounced create effect never
  // races into a second createWorkflow call.
  useEffect(() => {
    workflowIdRef.current = workflowId;
  }, [workflowId]);

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
   * is the source of truth once a workflowId exists.
   */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const { nodes: savedNodes, edges: savedEdges } = JSON.parse(saved);
        if (Array.isArray(savedNodes) && savedNodes.length > 0 && Array.isArray(savedEdges)) {
          setNodes(savedNodes);
          setEdges(savedEdges);
        }
      }
    } catch (error) {
      console.error('Failed to restore local workflow cache:', error);
      localStorage.removeItem(AUTOSAVE_KEY);
    }
  }, []);

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
            AUTOSAVE_KEY,
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
  }, [nodes, edges, workflowId, orgId]);

  /**
   * Subsequent autosave: once a workflowId exists, delegate to the persistence
   * hook, which debounces the updateWorkflow mutation, handles version conflicts,
   * and falls back to local storage when offline.
   */
  useEffect(() => {
    if (!workflowId) return;
    if (nodes.length === 0 && edges.length === 0) return;

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
    localStorage.removeItem(AUTOSAVE_KEY);
  }, []);

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
   * Handle closing configuration panel
   */
  const handleCloseConfiguration = useCallback(() => {
    setIsConfigPanelOpen(false);
    setConfigNode(null);
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
  const handleRun = useCallback(async () => {
    if (!workflowId) return;
    try {
      const execution = await executionApiService.startExecution(workflowId);
      if (execution?.executionId) {
        setExecutionId(execution.executionId);
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
            onRun={handleRun}
            onCancel={handleCancel}
            executionId={executionId}
          />
        </div>

        {/* Publish validation errors surfaced to the user */}
        {publishError && (
          <div
            role="alert"
            className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/20"
          >
            {publishError}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden relative">
          {/* Agent Tray Sidebar */}
          <AgentTray />

          {/* Workflow Canvas */}
          <main id="workflow-canvas" aria-label="Workflow builder main area" className="flex-1">
            <WorkflowCanvas
              nodes={nodes}
              edges={edges}
              setNodes={setNodes}
              setEdges={setEdges}
              onNodeDoubleClick={handleNodeDoubleClick}
              validationResult={validationResult}
            />
          </main>
        </div>

        {/* Node Configuration Panel */}
        <NodeConfigurationPanel
          node={configNode}
          isOpen={isConfigPanelOpen}
          onClose={handleCloseConfiguration}
          onSave={handleSaveConfiguration}
        />
      </div>
    </ReactFlowProvider>
  );
}
