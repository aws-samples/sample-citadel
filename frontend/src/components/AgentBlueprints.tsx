import { useState, useCallback, useEffect } from 'react';
import { ReactFlowProvider, type NodeMouseHandler } from 'reactflow';
import 'reactflow/dist/style.css';
import { AgentTray } from './AgentTray';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowToolbar } from './WorkflowToolbar';
import { NodeConfigurationPanel } from './NodeConfigurationPanel';
import type { WorkflowNode, WorkflowEdge, ValidationResult } from '../types/workflow';
import { validateWorkflow } from '../services/workflowService';

const AUTOSAVE_KEY = 'workflow-autosave';
const AUTOSAVE_DELAY = 2000; // 2 seconds debounce
const VALIDATION_DELAY = 500; // 500ms debounce

export function AgentBlueprints() {
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [configNode, setConfigNode] = useState<WorkflowNode | null>(null);
  const [isConfigPanelOpen, setIsConfigPanelOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  /**
   * Load auto-saved workflow on mount
   * Requirement: Auto-save to local storage
   */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const { nodes: savedNodes, edges: savedEdges, timestamp } = JSON.parse(saved);
        if (savedNodes && savedEdges) {
          setNodes(savedNodes);
          setEdges(savedEdges);
          console.log('Loaded auto-saved workflow from', new Date(timestamp).toLocaleString());
        }
      }
    } catch (error) {
      console.error('Failed to load auto-saved workflow:', error);
      // Clear corrupted data
      localStorage.removeItem(AUTOSAVE_KEY);
    }
  }, []);

  /**
   * Auto-save workflow to local storage with debouncing
   * Requirement: Auto-save to local storage
   * Performance: Debounced to prevent excessive writes
   */
  useEffect(() => {
    // Don't auto-save empty workflows
    if (nodes.length === 0 && edges.length === 0) {
      return;
    }

    // Debounce auto-save to prevent excessive writes during rapid changes
    const autoSaveTimer = setTimeout(() => {
      try {
        const data = {
          nodes,
          edges,
          timestamp: new Date().toISOString(),
        };
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
        console.log('Auto-saved workflow at', new Date().toLocaleString());
      } catch (error) {
        console.error('Failed to auto-save workflow:', error);
      }
    }, AUTOSAVE_DELAY);

    return () => clearTimeout(autoSaveTimer);
  }, [nodes, edges]);

  /**
   * Auto-validate workflow when nodes or edges change with debouncing
   * Requirement: Real-time validation feedback
   * Performance: Debounced to prevent excessive validation during rapid changes
   */
  useEffect(() => {
    if (nodes.length === 0 && edges.length === 0) {
      setValidationResult(null);
      return;
    }

    // Debounce validation to prevent excessive computation during rapid changes
    const validationTimer = setTimeout(() => {
      const result = validateWorkflow(nodes, edges);
      setValidationResult(result);
    }, VALIDATION_DELAY);

    return () => clearTimeout(validationTimer);
  }, [nodes, edges]);

  /**
   * Handle loading a workflow from file
   * Requirement: Clear existing workflow and load new one
   */
  const handleLoad = useCallback((loadedNodes: WorkflowNode[], loadedEdges: WorkflowEdge[]) => {
    setNodes(loadedNodes);
    setEdges(loadedEdges);
  }, []);

  /**
   * Handle clearing the canvas
   * Removes all nodes and edges and clears auto-save
   */
  const handleClear = useCallback(() => {
    setNodes([]);
    setEdges([]);
    // Clear auto-save when clearing canvas
    localStorage.removeItem(AUTOSAVE_KEY);
  }, []);

  /**
   * Handle double-clicking a node to open configuration panel
   * Requirement: Open configuration panel on double-click
   */
  const handleNodeDoubleClick: NodeMouseHandler = useCallback((_event, node) => {
    setConfigNode(node as WorkflowNode);
    setIsConfigPanelOpen(true);
  }, []);

  /**
   * Handle saving node configuration
   * Requirement: Update node configuration in workflow
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
   * Requirement: Close panel and discard changes
   */
  const handleCloseConfiguration = useCallback(() => {
    setIsConfigPanelOpen(false);
    setConfigNode(null);
  }, []);

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
