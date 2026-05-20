/**
 * AgentNode Component
 * 
 * Custom ReactFlow node component for displaying agent instances on the workflow canvas.
 * Provides visual representation with handles for connections, selection states, and action buttons.
 * 
 * Requirements: 2.4, 6.3, 9.5
 */

import { memo } from 'react';
import { Handle, Position, NodeProps, useReactFlow } from 'reactflow';
import { Trash2, Settings } from 'lucide-react';
import type { AgentNodeData } from '../types';
import { ResourceBadge } from './ResourceBadge';

/**
 * AgentNode component renders an individual agent node on the workflow canvas
 * 
 * Features:
 * - Node header with agent name and icon
 * - Input and output handles for connections
 * - Selection styling and visual states
 * - Delete and configure action buttons (shown when selected)
 * - Validation error indicators and tooltips
 */
export const AgentNode = memo(({ id, data, selected }: NodeProps<AgentNodeData>) => {
  const { label, icon, agentConfig, validationErrors } = data;
  const { setNodes, setEdges } = useReactFlow();
  const hasErrors = validationErrors && validationErrors.length > 0;

  /**
   * Handle node deletion
   * Removes the node and all connected edges
   */
  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    
    // Remove the node
    setNodes((nds) => nds.filter((node) => node.id !== id) as any);
    
    // Remove all edges connected to this node
    setEdges((eds) => 
      eds.filter((edge) => edge.source !== id && edge.target !== id)
    );
  };

  /**
   * Handle node configuration
   * Opens configuration panel by triggering a double-click event
   */
  const handleConfigure = (event: React.MouseEvent) => {
    event.stopPropagation();
    // Trigger double-click event to open configuration panel
    const nodeElement = (event.target as HTMLElement).closest('.react-flow__node');
    if (nodeElement) {
      const dblClickEvent = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      nodeElement.dispatchEvent(dblClickEvent);
    }
  };

  /**
   * Handle keyboard interactions for accessibility
   */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Enter or Space to configure
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleConfigure(event as any);
    }
    // Delete or Backspace to delete
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handleDelete(event as any);
    }
  };

  // Generate accessible description
  const ariaLabel = `${label} agent node${hasErrors ? ', has validation errors' : ''}${selected ? ', selected' : ''}`;
  const ariaDescription = hasErrors 
    ? `Validation errors: ${validationErrors?.map(e => e.message).join(', ')}`
    : `${agentConfig.config?.description || 'Agent node in workflow'}`;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-description={ariaDescription}
      aria-selected={selected}
      aria-invalid={hasErrors}
      onKeyDown={handleKeyDown}
      className={`
        relative bg-accent border-2 rounded-lg min-w-[200px]
        transition-all duration-200 ease-in-out
        focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-surface-0
        ${hasErrors
          ? 'border-destructive shadow-lg shadow-red-500/30 has-error'
          : selected 
            ? 'border-primary shadow-lg shadow-blue-500/40' 
            : 'border-border hover:border-input shadow-md shadow-black/20 hover:shadow-lg hover:shadow-black/30'
        }
      `}
      title={hasErrors ? validationErrors?.map(e => e.message).join('\n') : undefined}
    >
      {/* Input Handle - Top */}
      <Handle
        type="target"
        position={Position.Top}
        id="input"
        aria-label={`Input connection point for ${label}`}
        className={`
          !w-3 !h-3 !bg-chart-2 !border-2 !border-border/50
          hover:!bg-chart-2 transition-colors
          focus:!ring-2 focus:!ring-green-400 focus:!ring-offset-2
          ${selected ? '!border-primary' : ''}
        `}
        style={{ top: -6 }}
      />

      {/* Validation Error Badge */}
      {hasErrors && (
        <div 
          className="absolute -top-2 -right-2 size-6 bg-destructive rounded-full flex items-center justify-center text-foreground text-xs font-bold shadow-lg z-10"
          title={validationErrors?.map(e => e.message).join('\n')}
        >
          !
        </div>
      )}

      {/* Node Header */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {/* Agent Icon */}
          {icon ? (
            <div className="size-6 flex items-center justify-center text-lg">
              {icon}
            </div>
          ) : (
            <div className="size-6 flex items-center justify-center bg-accent rounded text-xs text-muted-foreground">
              A
            </div>
          )}
          
          {/* Agent Name */}
          <div className="flex-1 min-w-0">
            <div className="text-foreground font-medium text-sm truncate">
              {label}
            </div>
            {agentConfig.categories && agentConfig.categories.length > 0 && (
              <div className="text-muted-foreground text-xs truncate">
                {agentConfig.categories[0]}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Node Body */}
      <div className="px-4 py-3">
        {hasErrors ? (
          <div className="flex flex-col gap-1">
            {validationErrors?.slice(0, 2).map((error, index) => (
              <div key={index} className="text-destructive text-xs flex items-start gap-1">
                <span className="shrink-0">•</span>
                <span className="line-clamp-2">{error.message}</span>
              </div>
            ))}
            {validationErrors && validationErrors.length > 2 && (
              <div className="text-destructive text-xs">
                +{validationErrors.length - 2} more error{validationErrors.length - 2 > 1 ? 's' : ''}
              </div>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground text-xs">
            {agentConfig.state === 'active' ? (
              <span className="flex items-center gap-1">
                <span className="size-2 bg-chart-2 rounded-full"></span>
                Active
              </span>
            ) : agentConfig.state === 'maintenance' ? (
              <span className="flex items-center gap-1">
                <span className="size-2 bg-chart-4 rounded-full"></span>
                Maintenance
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="size-2 bg-muted-foreground rounded-full"></span>
                Inactive
              </span>
            )}
          </div>
        )}
      </div>

      {/* Resource Bindings — data stores and integrations */}
      {data.toolBindings && data.toolBindings.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1" data-testid="agent-node-bindings">
          {data.toolBindings.map((binding) => (
            <ResourceBadge
              key={`${binding.toolId}-${binding.resourceName}`}
              name={binding.resourceName}
              type={binding.resourceType}
              direction={binding.direction}
            />
          ))}
        </div>
      )}

      {/* Action Buttons - Only visible when selected */}
      {selected && (
        <div 
          className="absolute -top-10 right-0 flex gap-1 bg-accent border border-border rounded-md p-1 shadow-lg animate-in fade-in slide-in-from-top-2 duration-200"
          role="toolbar"
          aria-label={`Actions for ${label}`}
        >
          <button
            className="p-1.5 hover:bg-accent rounded transition-all duration-200 text-muted-foreground hover:text-primary hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-blue-400"
            title="Configure"
            aria-label={`Configure ${label}`}
            onClick={handleConfigure}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
          <button
            className="p-1.5 hover:bg-accent rounded transition-all duration-200 text-muted-foreground hover:text-destructive hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-red-400"
            title="Delete"
            aria-label={`Delete ${label}`}
            onClick={handleDelete}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Output Handle - Bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="output"
        aria-label={`Output connection point for ${label}`}
        className={`
          !w-3 !h-3 !bg-primary !border-2 !border-border/50
          hover:!bg-primary transition-colors
          focus:!ring-2 focus:!ring-blue-400 focus:!ring-offset-2
          ${selected ? '!border-primary' : ''}
        `}
        style={{ bottom: -6 }}
      />
    </div>
  );
});

AgentNode.displayName = 'AgentNode';
