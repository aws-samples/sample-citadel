/**
 * WorkflowPersistenceControls Component
 *
 * Thin wrapper around useWorkflowPersistence hook. Shows save status indicators
 * (Saving.../Saved/Conflict), Export button (calls exportWorkflow), and
 * Load button (calls importWorkflow).
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 24.5, 24.6
 */

import React, { useRef } from 'react';
import { useWorkflowPersistence } from '../hooks/useWorkflowPersistence';
import { workflowApiService } from '../services/workflowApiService';
import { Button } from './ui/button';

export interface WorkflowPersistenceControlsProps {
  workflowId: string;
  orgId?: string;
  onSave?: (data: any) => void;
}

export function WorkflowPersistenceControls({
  workflowId,
  orgId,
  onSave: _onSave,
}: WorkflowPersistenceControlsProps) {
  const { isSaving, lastSaved, conflict } = useWorkflowPersistence(workflowId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    const json = await workflowApiService.exportWorkflow(workflowId);
    try {
      const blob = new Blob([typeof json === 'string' ? json : JSON.stringify(json)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workflow-${workflowId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback for environments without Blob URL support
    }
  };

  const handleLoadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      if (text) {
        await workflowApiService.importWorkflow({
          orgId: orgId ?? '',
          workflowJson: text,
        });
      }
    };
    reader.readAsText(file);
  };

  const statusLabel = conflict
    ? 'Conflict'
    : isSaving
      ? 'Saving...'
      : lastSaved
        ? 'Saved'
        : null;

  return (
    <div className="flex items-center gap-2">
      {/* Save status indicator */}
      {statusLabel && (
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            conflict
              ? 'bg-destructive text-destructive'
              : isSaving
                ? 'bg-chart-4 text-chart-4'
                : 'bg-chart-2 text-chart-2'
          }`}
        >
          {statusLabel}
        </span>
      )}

      {/* Export button */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleExport}
        className="h-auto px-2 py-1 text-xs"
      >
        Export
      </Button>

      {/* Load button + hidden file input */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleLoadClick}
        className="h-auto px-2 py-1 text-xs"
      >
        Load
      </Button>
      <input
        ref={fileInputRef}
        data-testid="import-file-input"
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
