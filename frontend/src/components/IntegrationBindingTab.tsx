/**
 * IntegrationBindingTab Component
 *
 * Tab in AgentNode config panel listing tools with current bindings.
 * Allows workflow-specific overrides stored in WorkflowConfiguration.agentProperties.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5
 */

import React, { useState } from 'react';
import { workflowApiService } from '../services/workflowApiService';

export type BindingStatus = 'bound' | 'unbound' | 'overridden';

export interface ToolBinding {
  toolId: string;
  toolName: string;
  status: BindingStatus;
  integrationId: string | null;
}

export interface IntegrationBindingTabProps {
  bindings: ToolBinding[];
  workflowId: string;
  agentId: string;
  version: number;
  onSaved: (newVersion: number) => void;
}

const statusColors: Record<BindingStatus, string> = {
  bound: 'bg-chart-2 text-chart-2',
  unbound: 'bg-muted text-muted-foreground',
  overridden: 'bg-chart-4 text-chart-4',
};

export function IntegrationBindingTab({
  bindings,
  workflowId,
  agentId,
  version,
  onSaved,
}: IntegrationBindingTabProps) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const config = JSON.stringify({
        agentProperties: {
          [agentId]: { toolOverrides: overrides },
        },
      });
      const result = await workflowApiService.updateWorkflowConfiguration(
        workflowId,
        config,
        version
      );
      onSaved(result?.version ?? version + 1);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <h3 className="text-sm font-semibold text-foreground">Tool Bindings</h3>

      <div className="flex flex-col gap-2">
        {bindings.map((binding) => (
          <div
            key={binding.toolId}
            className="flex items-center justify-between gap-2 p-2 rounded bg-accent border border-border"
          >
            <span className="text-sm text-foreground truncate">{binding.toolName}</span>

            <div className="flex items-center gap-2">
              <span
                data-testid={`binding-status-${binding.toolId}`}
                className={`text-xs px-2 py-0.5 rounded ${statusColors[binding.status]}`}
              >
                {binding.status}
              </span>

              {editingToolId !== binding.toolId ? (
                <button
                  data-testid={`override-btn-${binding.toolId}`}
                  onClick={() => setEditingToolId(binding.toolId)}
                  className="text-xs text-primary hover:text-primary"
                >
                  Override
                </button>
              ) : (
                <input
                  data-testid={`override-input-${binding.toolId}`}
                  className="text-xs border border-border rounded px-1 py-0.5 bg-background text-foreground w-24"
                  placeholder="Integration ID"
                  value={overrides[binding.toolId] ?? ''}
                  onChange={(e) =>
                    setOverrides((prev) => ({ ...prev, [binding.toolId]: e.target.value }))
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1.5 bg-primary text-foreground rounded text-sm disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Overrides'}
      </button>
    </div>
  );
}
