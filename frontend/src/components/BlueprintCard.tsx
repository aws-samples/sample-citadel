/**
 * BlueprintCard Component
 * Displays a single blueprint as a card with name, description, agent count,
 * category tags, "Use in App" button, and "Preview" action.
 *
 * Requirements: 7.2, 7.9, 23.3
 */
import { Card } from './ui/card';
import { Button } from './ui/button';


export interface BlueprintData {
  workflowId: string;
  name: string;
  description?: string;
  definition: string;
  metadata?: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  isBlueprint: boolean;
}

interface BlueprintCardProps {
  blueprint: BlueprintData;
  onUseInApp: (blueprint: BlueprintData) => void;
  onPreview: (blueprint: BlueprintData) => void;
}

function parseDefinition(definition: string): { nodes: any[]; edges: any[] } {
  try {
    const parsed = JSON.parse(definition);
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function parseMetadata(metadata?: string): { category?: string; tags?: string[]; isSystem?: boolean } {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

export function BlueprintCard({ blueprint, onUseInApp, onPreview }: BlueprintCardProps) {
  const { nodes } = parseDefinition(blueprint.definition);
  const meta = parseMetadata(blueprint.metadata);
  const agentCount = nodes.length;

  return (
    <Card
      className="rounded-lg p-4 hover:border-input transition-colors gap-0"
      data-testid={`blueprint-card-${blueprint.workflowId}`}
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-foreground font-medium text-sm">{blueprint.name}</h3>
        {meta.isSystem && (
          <span className="text-xs bg-primary/50 text-primary px-2 py-0.5 rounded">System</span>
        )}
      </div>

      {blueprint.description && (
        <p className="text-muted-foreground text-xs mb-3 line-clamp-2">{blueprint.description}</p>
      )}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-xs text-muted-foreground">{agentCount} agent{agentCount !== 1 ? 's' : ''}</span>
        {meta.category && (
          <span className="text-xs bg-accent text-muted-foreground px-2 py-0.5 rounded">{meta.category}</span>
        )}
        {meta.tags?.map((tag) => (
          <span key={tag} className="text-xs bg-accent text-muted-foreground px-1.5 py-0.5 rounded">
            {tag}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onUseInApp(blueprint)}
          className="flex-1 text-xs"
        >
          Use in App
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPreview(blueprint)}
          className="text-xs"
        >
          Preview
        </Button>
      </div>
    </Card>
  );
}
