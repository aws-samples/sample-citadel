import React, { memo, useCallback } from 'react';
import { AgentConfig } from '../services/agentConfigService';
import { Card } from './ui/card';
import { cn } from './ui/utils';

interface AgentTrayItemProps {
  agent: AgentConfig;
  onDragStart: (event: React.DragEvent, agent: AgentConfig) => void;
}

export const AgentTrayItem = memo(function AgentTrayItem({ agent, onDragStart }: AgentTrayItemProps) {
  const agentName = (agent as any).name || agent.config?.name || agent.agentId;
  const agentDescription = agent.config?.description || 'No description available';
  const agentIcon = agent.config?.icon;
  const category = agent.categories?.[0] || 'Uncategorized';

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Allow Enter or Space to initiate drag (simulate click)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      // Focus on the element to indicate selection
      (e.currentTarget as HTMLElement).focus();
    }
  }, []);

  return (
    <Card
      role="listitem"
      draggable
      tabIndex={0}
      onDragStart={(e) => onDragStart(e, agent)}
      onKeyDown={handleKeyDown}
      aria-label={`${agentName} agent. ${agentDescription}. Category: ${category}. State: ${agent.state || 'unknown'}. Drag to add to workflow.`}
      className={cn(
        "agent-tray-item group relative flex flex-col gap-2 p-3 rounded-lg",
        "bg-accent hover:bg-accent hover:border-input",
        "cursor-grab active:cursor-grabbing transition-all duration-200",
        "hover:shadow-lg hover:shadow-black/30 hover:-translate-y-0.5",
        "active:scale-95",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-surface-0"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Agent Icon */}
        <div 
          className="flex-shrink-0 size-10 rounded-md bg-accent flex items-center justify-center text-lg"
          aria-hidden="true"
        >
          {agentIcon ? (
            <span>{agentIcon}</span>
          ) : (
            <span className="text-muted-foreground">🤖</span>
          )}
        </div>

        {/* Agent Info */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground truncate">
            {agentName}
          </h3>
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
            {agentDescription}
          </p>
        </div>
      </div>

      {/* Category Badge */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent text-muted-foreground border border-input">
          {category}
        </span>
        {agent.state && (
          <span
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
              agent.state === 'active' && "bg-chart-2/10 text-chart-2 border border-chart-2/20",
              agent.state === 'inactive' && "bg-muted/10 text-muted-foreground border border-border",
              agent.state === 'maintenance' && "bg-chart-4/10 text-chart-4 border border-chart-4/20"
            )}
          >
            {agent.state}
          </span>
        )}
      </div>
    </Card>
  );
});
