/**
 * WorkflowCanvas Component
 * 
 * ReactFlow-based canvas wrapper for visual workflow composition.
 * Handles drag-and-drop, node manipulation, connection management, and validation display.
 * 
 */

import React, { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeMouseHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';
import { AgentNode } from './AgentNode';
import type { WorkflowNode, WorkflowEdge, ValidationResult } from '../types/workflow';
import type { AgentConfig } from '../services/agentConfigService';
import { wouldCreateCycle } from '../services/workflowService';
import { useScreenReader } from '../hooks/useScreenReader';
import { resolveToolBindings } from '../utils/resolveToolBindings';

// Define custom node types for ReactFlow - memoized to prevent recreation
const nodeTypes = {
  agentNode: AgentNode as any,
};

export interface WorkflowCanvasProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  setNodes: React.Dispatch<React.SetStateAction<WorkflowNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<WorkflowEdge[]>>;
  onNodeDoubleClick: NodeMouseHandler;
  validationResult: ValidationResult | null;
}

/**
 * WorkflowCanvas component provides the main canvas for workflow composition
 * 
 * Features:
 * - ReactFlow canvas with custom node types
 * - Drag-and-drop support for adding agents
 * - Node manipulation (move, select, delete)
 * - Connection management with validation
 * - Zoom and pan controls
 * - Mini map for navigation
 * - Empty state message
 * - Validation error display
 */
export const WorkflowCanvas = memo(function WorkflowCanvas({ 
  nodes, 
  edges, 
  setNodes, 
  setEdges, 
  onNodeDoubleClick, 
  validationResult 
}: WorkflowCanvasProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useReactFlow();
  const { announce } = useScreenReader();

  /**
   * Enrich nodes with validation errors
   * Display error indicators on affected nodes
   * Memoized to prevent unnecessary recalculations
   */
  const nodesWithValidation = useMemo(() => {
    if (!validationResult || validationResult.errors.length === 0) {
      return nodes;
    }

    return nodes.map(node => {
      const nodeErrors = validationResult.errors.filter(error => error.nodeId === node.id);
      if (nodeErrors.length > 0) {
        return {
          ...node,
          data: {
            ...node.data,
            validationErrors: nodeErrors,
          },
        };
      }
      return node;
    });
  }, [nodes, validationResult]);

  /**
   * Validates if a connection is allowed
   * Prevents self-connections and circular dependencies
   * Prevent invalid connections
   */
  const isValidConnection = useCallback(
    (connection: Connection): boolean => {
      // Prevent self-connections
      if (connection.source === connection.target) {
        console.warn('Self-connections are not allowed');
        toast.error('Invalid connection', {
          description: 'Cannot connect a node to itself',
        });
        return false;
      }

      // Check if connection would create a cycle
      if (connection.source && connection.target) {
        if (wouldCreateCycle(connection.source, connection.target, nodes, edges)) {
          console.warn('Connection would create a circular dependency');
          toast.error('Invalid connection', {
            description: 'This connection would create a circular dependency',
          });
          return false;
        }
      }

      return true;
    },
    [nodes, edges]
  );

  /**
   * Handle connection creation between nodes
   * Allows multiple connections to/from the same handles
   * Create connection edges
   * Allow multiple connections
   */
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      // Validate the connection
      if (!isValidConnection(connection)) {
        return;
      }

      // Create a new edge with a unique ID
      const newEdge: WorkflowEdge = {
        ...connection,
        id: uuidv4(),
        type: 'smoothstep',
        animated: false,
      } as WorkflowEdge;

      // Add the edge to the workflow
      setEdges((eds) => addEdge(newEdge, eds));
      
      // Announce to screen readers
      const sourceNode = nodes.find(n => n.id === connection.source);
      const targetNode = nodes.find(n => n.id === connection.target);
      if (sourceNode && targetNode) {
        announce(`Connected ${sourceNode.data.label} to ${targetNode.data.label}`);
      }
    },
    [isValidConnection, setEdges, nodes, announce]
  );

  /**
   * Handle edge changes (deletion, updates, etc.)
   */
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [setEdges]
  );

  /**
   * Handle node changes (movement, selection, deletion, etc.)
   * Node movement
   * Update connected edges during movement
   * Node selection
   */
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes((nds) => applyNodeChanges(changes, nds) as WorkflowNode[]);
      
      // Track selection changes
      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) {
            setSelectedNodeId(change.id);
          } else if (selectedNodeId === change.id) {
            setSelectedNodeId(null);
          }
        } else if (change.type === 'remove') {
          // Clear selection if the removed node was selected
          if (selectedNodeId === change.id) {
            setSelectedNodeId(null);
          }
        }
      }
    },
    [selectedNodeId, setNodes]
  );

  /**
   * Handle node deletion
   * Delete node and all its connections
   */
  const handleNodeDelete = useCallback(
    (nodeId: string) => {
      // Find the node to get its label for the toast
      const node = nodes.find(n => n.id === nodeId);
      const nodeLabel = node?.data.label || 'Node';
      
      // Count connected edges
      const connectedEdges = edges.filter(
        edge => edge.source === nodeId || edge.target === nodeId
      );
      
      // Remove the node
      setNodes((nds) => nds.filter((node) => node.id !== nodeId));
      
      // Remove all edges connected to this node
      setEdges((eds) => 
        eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
      );
      
      // Clear selection
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(null);
      }
      
      // Announce to screen readers
      announce(`Deleted ${nodeLabel} and ${connectedEdges.length} connection${connectedEdges.length !== 1 ? 's' : ''}`);
      
      // Show toast notification
      toast.success('Node deleted', {
        description: `${nodeLabel} and ${connectedEdges.length} connection${connectedEdges.length !== 1 ? 's' : ''} removed`,
      });
    },
    [selectedNodeId, nodes, edges, setNodes, setEdges, announce]
  );

  /**
   * Handle clicking on the canvas background
   * Deselect nodes when clicking background
   */
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  /**
   * Handle keyboard shortcuts
   * Delete key removes selected node
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if Delete or Backspace key is pressed
      if (event.key === 'Delete' || event.key === 'Backspace') {
        // Only delete if a node is selected and we're not in an input field
        if (selectedNodeId && 
            event.target instanceof HTMLElement && 
            event.target.tagName !== 'INPUT' && 
            event.target.tagName !== 'TEXTAREA') {
          event.preventDefault();
          handleNodeDelete(selectedNodeId);
        }
      }
    };

    // Add event listener
    window.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedNodeId, handleNodeDelete]);

  /**
   * Handle drag over event to allow dropping
   * Requirement 2.1: Visual indicator for drag operation
   */
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * Handle drop event to create a new node from dropped agent
   * Create node at drop location
   * Assign unique identifier
   * Display agent information
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      // Get the dropped agent data
      const dataString = event.dataTransfer.getData('application/reactflow');
      if (!dataString) {
        console.log('No drag data found');
        return;
      }

      let data: {
        type: string;
        agentId: string;
        agentConfig: AgentConfig;
      };

      try {
        data = JSON.parse(dataString);
        console.log('Dropped agent data:', data);
      } catch (error) {
        console.error('Failed to parse dropped data:', error);
        return;
      }

      // Ensure we have the wrapper element
      if (!reactFlowWrapper.current) {
        console.error('ReactFlow wrapper not found');
        return;
      }

      // Get the position relative to the ReactFlow canvas
      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      
      // Use reactFlowInstance to project screen coordinates to flow coordinates
      let position;
      try {
        position = reactFlowInstance.project({
          x: event.clientX - reactFlowBounds.left,
          y: event.clientY - reactFlowBounds.top,
        });
        console.log('Drop position:', position);
      } catch (error) {
        console.error('Failed to project position:', error);
        // Fallback to simple calculation if project fails
        position = {
          x: event.clientX - reactFlowBounds.left,
          y: event.clientY - reactFlowBounds.top,
        };
      }

      // Generate a unique ID for the new node
      const nodeId = uuidv4();

      // Create the new node
      const newNode: WorkflowNode = {
        id: nodeId,
        type: 'agentNode',
        position,
        data: {
          agentId: data.agentConfig.agentId,
          agentConfig: data.agentConfig,
          label: (data.agentConfig as any).name || data.agentConfig.config?.name || data.agentConfig.agentId,
          icon: data.agentConfig.config?.icon,
          configuration: {},
          inputCount: 1,
          outputCount: 1,
        },
      };

      console.log('Creating new node:', newNode);

      // Add the new node to the canvas
      setNodes((nds) => {
        console.log('Adding node to canvas, current nodes:', nds.length);
        return [...nds, newNode];
      });
      
      // Announce to screen readers
      announce(`Added ${newNode.data.label} to workflow`);
      
      // Show success toast
      toast.success('Agent added', {
        description: `${newNode.data.label} added to workflow`,
      });

      // Async tool binding resolution — fire-and-forget with error handling
      resolveToolBindings(data.agentConfig)
        .then((toolBindings) => {
          if (toolBindings.length > 0) {
            setNodes((nds) =>
              nds.map((n) =>
                n.id === nodeId
                  ? { ...n, data: { ...n.data, toolBindings } }
                  : n
              ) as WorkflowNode[]
            );
          }
        })
        .catch((error) => {
          console.warn('Failed to resolve tool bindings for dropped agent:', error);
        });
    },
    [reactFlowInstance, setNodes, announce]
  );

  return (
    <div 
      className="flex-1 flex flex-col w-full h-full" 
      ref={reactFlowWrapper}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={nodesWithValidation}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        isValidConnection={isValidConnection}
        onPaneClick={onPaneClick}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        className="bg-background w-full h-full"
        minZoom={0.1}
        maxZoom={2}
        panOnScroll
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        aria-label="Workflow canvas"
        role="application"
        aria-roledescription="Interactive workflow builder canvas"
        // Performance optimizations:
        // - ReactFlow uses virtualization internally for large workflows (100+ nodes)
        // - Only visible nodes are rendered in the DOM
        // - Edge rendering is optimized with SVG path reuse
        // - Node updates use React's reconciliation for minimal DOM changes
      >
        {/* Background grid */}
        <Background 
          color="#2a2a2a" 
          gap={16}
        />
        
        {/* Zoom and pan controls */}
        <Controls 
          className="bg-accent border border-border"
          showZoom={true}
          showFitView={true}
          showInteractive={true}
          aria-label="Canvas controls"
        />
        
        {/* Mini map for navigation */}
        <MiniMap
          className="bg-accent border border-border"
          nodeColor="#3a3a3a"
          maskColor="rgba(0, 0, 0, 0.6)"
          zoomable
          pannable
          aria-label="Workflow minimap"
        />
      </ReactFlow>

      {/* Empty state message - Requirement 9.4 */}
      {nodes.length === 0 && (
        <div 
          className="workflow-empty-state absolute inset-0 flex items-center justify-center pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div className="text-center">
            <div className="size-16 mx-auto mb-4 rounded-full bg-accent border-2 border-border flex items-center justify-center shadow-lg">
              <span className="text-3xl" aria-hidden="true">🎨</span>
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              Start Building Your Workflow
            </h3>
            <p className="text-sm text-muted-foreground max-w-md px-4">
              Drag agents from the sidebar onto the canvas to begin creating your workflow
            </p>
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="workflow-badge workflow-badge-info" aria-hidden="true">Tip</span>
              <span>Double-click nodes to configure them</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
