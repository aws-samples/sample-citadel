/**
 * BlueprintCard Component
 * Displays a single blueprint as a card with name, description, agent count,
 * category tags, "Use in App" button, and "Preview" action.
 * CIT-289: Also shows version, created date, short ID with copy, and placeholder warning badge.
 *
 * Requirements: 7.2, 7.9, 23.3
 */
import { useState } from 'react';
import { AlertTriangle, Copy, Check } from 'lucide-react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { hasPlaceholderNodes, shortId as computeShortId } from '../utils/workflowListHelpers';
import { relativeDate, absoluteDate } from '../utils/relativeDate';


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

function parseDefinition(definition: string): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
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
  const bpShortId = computeShortId(blueprint.workflowId);
  const placeholders = hasPlaceholderNodes(blueprint.definition);
  const [copied, setCopied] = useState(false);

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(blueprint.workflowId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silently fail
    }
  };

  return (
    <Card
      className="rounded-lg p-4 hover:border-input transition-colors gap-0"
      data-testid={`blueprint-card-${blueprint.workflowId}`}
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-foreground font-medium text-sm">{blueprint.name}</h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-muted-foreground">v{blueprint.version}</span>
          {meta.isSystem && (
            <span className="text-xs bg-primary/50 text-primary px-2 py-0.5 rounded">System</span>
          )}
        </div>
      </div>

      {blueprint.description && (
        <p className="text-muted-foreground text-xs mb-2 line-clamp-2">{blueprint.description}</p>
      )}

      <div className="flex items-center gap-2 mb-2 flex-wrap text-xs text-muted-foreground">
        <span>{agentCount} agent{agentCount !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span title={absoluteDate(blueprint.createdAt)}>{relativeDate(blueprint.createdAt)}</span>
        <span>·</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="font-mono hover:text-foreground h-auto px-1 py-0 text-xs text-muted-foreground"
          title={`Copy full ID: ${blueprint.workflowId}`}
          data-testid={`blueprint-copy-id-${blueprint.workflowId}`}
          onClick={handleCopyId}
        >
          …{bpShortId} {copied ? <Check className="inline size-3 text-chart-2" /> : <Copy className="inline size-3" />}
        </Button>
        {meta.category && (
          <span className="bg-accent px-2 py-0.5 rounded">{meta.category}</span>
        )}
        {meta.tags?.map((tag) => (
          <span key={tag} className="bg-accent px-1.5 py-0.5 rounded">
            {tag}
          </span>
        ))}
      </div>

      {placeholders && (
        <p className="text-xs text-amber-500 mb-2" data-testid={`blueprint-placeholder-badge-${blueprint.workflowId}`}>
          <AlertTriangle className="inline size-3 mr-1" />Placeholder nodes
        </p>
      )}

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
