/**
 * BlueprintPreviewDialog Component
 * Read-only preview showing blueprint node/edge layout.
 * Uses a simple div-based renderer (no full ReactFlow dependency for testability).
 *
 * Requirements: 7.9
 */

import React from 'react';
import type { BlueprintData } from './BlueprintCard';

interface BlueprintPreviewDialogProps {
  blueprint: BlueprintData;
  open: boolean;
  onClose: () => void;
}

function parseDefinition(definition: string): { nodes: any[]; edges: any[] } {
  try {
    let parsed = typeof definition === 'string' ? JSON.parse(definition) : definition;
    // Handle double-encoded AWSJSON (string within a string)
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export function BlueprintPreviewDialog({ blueprint, open, onClose }: BlueprintPreviewDialogProps) {
  if (!open) return null;

  const { nodes, edges } = parseDefinition(blueprint.definition);

  // Build a position lookup for edge rendering
  const SCALE = 0.4;
  const OFFSET = 40;
  const NODE_W = 80;
  const NODE_H = 24;
  const nodePositions: Record<string, { cx: number; cy: number }> = {};
  for (const node of nodes) {
    const x = (node.position?.x ?? 0) * SCALE + OFFSET;
    const y = (node.position?.y ?? 0) * SCALE + OFFSET;
    nodePositions[node.id] = { cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="blueprint-preview-dialog"
    >
      <div className="bg-card border border-border rounded-lg w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-foreground font-medium">Preview: {blueprint.name}</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm"
            aria-label="Close preview"
          >
            ✕
          </button>
        </div>

        <div className="p-4 min-h-[300px] relative bg-background rounded-b-lg overflow-hidden">
          {nodes.length === 0 && (
            <div className="flex items-center justify-center h-full min-h-[260px] text-muted-foreground text-sm">
              No nodes to preview
            </div>
          )}

          {/* SVG layer for edge arrows */}
          {edges.length > 0 && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" data-testid="preview-edges-svg">
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#4a90d9" />
                </marker>
              </defs>
              {edges.map((edge: any) => {
                const src = nodePositions[edge.source];
                const tgt = nodePositions[edge.target];
                if (!src || !tgt) return null;
                return (
                  <line
                    key={edge.id}
                    x1={src.cx}
                    y1={src.cy}
                    x2={tgt.cx}
                    y2={tgt.cy}
                    stroke="#4a90d9"
                    strokeWidth={1.5}
                    strokeDasharray={edge.condition ? '4 3' : undefined}
                    markerEnd="url(#arrowhead)"
                    data-testid={`preview-edge-${edge.id}`}
                  />
                );
              })}
            </svg>
          )}

          {/* Node boxes */}
          {nodes.map((node: any) => (
            <div
              key={node.id}
              className="absolute bg-accent border border-input rounded px-3 py-2 text-xs text-muted-foreground z-10"
              style={{
                left: `${(node.position?.x ?? 0) * SCALE + OFFSET}px`,
                top: `${(node.position?.y ?? 0) * SCALE + OFFSET}px`,
              }}
              data-testid={`preview-node-${node.id}`}
            >
              {node.id}
            </div>
          ))}

          {edges.length > 0 && (
            <div className="absolute bottom-2 left-2 text-xs text-muted-foreground z-10">
              {nodes.length} node{nodes.length !== 1 ? 's' : ''} · {edges.length} connection{edges.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
