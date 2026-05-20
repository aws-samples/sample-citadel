/**
 * WorkflowConfigPanel Component
 *
 * Workflow-level configuration editor with sections for Integrations,
 * Credentials, Agent Properties, and Parameters. Calls
 * updateWorkflowConfiguration on save with optimistic locking.
 *
 * Requirements: 9.5, 9.1
 */

import React, { useState } from 'react';
import type { WorkflowConfiguration } from '../types/workflow';
import { workflowApiService } from '../services/workflowApiService';

export interface WorkflowConfigPanelProps {
  workflowId: string;
  configuration: WorkflowConfiguration;
  version: number;
  onSaved: (updatedVersion: number) => void;
}

/**
 * Renders a key-value editor for a Record<string, string> section.
 */
function KeyValueSection({
  title,
  data,
  onChange,
}: {
  title: string;
  data: Record<string, string>;
  onChange: (updated: Record<string, string>) => void;
}) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <div className="flex flex-col gap-1">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="flex gap-2 items-center text-xs">
            <span className="font-mono bg-muted px-1 rounded">{key}</span>
            <input
              className="border rounded px-1 py-0.5 flex-1 text-xs"
              value={typeof value === 'string' ? value : JSON.stringify(value)}
              onChange={(e) => onChange({ ...data, [key]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkflowConfigPanel({
  workflowId,
  configuration,
  version,
  onSaved,
}: WorkflowConfigPanelProps) {
  const [config, setConfig] = useState<WorkflowConfiguration>({ ...configuration });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await workflowApiService.updateWorkflowConfiguration(
        workflowId,
        JSON.stringify(config),
        version
      );
      onSaved(result?.version ?? version + 1);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="workflow-config-panel" className="flex flex-col p-4 gap-4">
      <h2 className="text-base font-bold">Workflow Configuration</h2>

      <KeyValueSection
        title="Integrations"
        data={flattenRecord(config.integrations)}
        onChange={(updated) => setConfig((c) => ({ ...c, integrations: unflattenRecord(updated) }))}
      />

      <KeyValueSection
        title="Credentials"
        data={config.credentials ?? {}}
        onChange={(updated) => setConfig((c) => ({ ...c, credentials: updated }))}
      />

      <KeyValueSection
        title="Agent Properties"
        data={flattenRecord(config.agentProperties)}
        onChange={(updated) => setConfig((c) => ({ ...c, agentProperties: unflattenRecord(updated) }))}
      />

      <KeyValueSection
        title="Parameters"
        data={config.parameters ?? {}}
        onChange={(updated) => setConfig((c) => ({ ...c, parameters: updated }))}
      />

      <button
        className="px-3 py-1.5 bg-primary text-foreground rounded text-sm disabled:opacity-50"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? 'Saving...' : 'Save Configuration'}
      </button>
    </div>
  );
}

/** Flatten a Record<string, any> to Record<string, string> for display */
function flattenRecord(rec?: Record<string, any>): Record<string, string> {
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/** Attempt to parse JSON strings back into objects */
function unflattenRecord(rec: Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(rec)) {
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
