/**
 * ResourceBadge Component
 *
 * Sub-node badge showing resource name, type icon, and directional indicator.
 * Used within AgentNode to visualize data store and integration bindings.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

import { Button } from './ui/button';

export type ResourceDirection = 'input' | 'output' | 'bidirectional';
export type ResourceType = 'datastore' | 'integration';

export interface ResourceBadgeProps {
  name: string;
  type: ResourceType;
  direction: ResourceDirection;
  onClick?: () => void;
}

const directionIndicators: Record<ResourceDirection, string> = {
  input: '←',
  output: '→',
  bidirectional: '↔',
};

export function ResourceBadge({ name, type, direction, onClick }: ResourceBadgeProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-auto whitespace-normal justify-start gap-1.5 px-2 py-1 rounded border border-border bg-accent text-xs text-foreground hover:border-primary transition-colors"
    >
      <span data-testid={`resource-icon-${type}`} className="text-sm">
        {type === 'datastore' ? '🗄' : '🔌'}
      </span>
      <span className="truncate max-w-[120px]">{name}</span>
      <span className="text-muted-foreground">{directionIndicators[direction]}</span>
    </Button>
  );
}
