/**
 * RunWorkflowDialog — shared dialog for running a workflow with optional JSON input.
 *
 * Used by both the AppDetailView workflows tab and the AgentBlueprints canvas.
 * Features:
 *   - Optional JSON textarea (monospace) with live validation
 *   - Parse-error shown inline, Run disabled while invalid
 *   - Empty textarea = no input argument (one-click run)
 *   - Per-workflow "remember last input" via localStorage
 *   - Calls onRun(workflowId, input?) and lets the caller handle the mutation
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';

const STORAGE_PREFIX = 'citadel:run-input:';

export interface RunWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  workflowName?: string;
  loading?: boolean;
  onRun: (workflowId: string, input?: string) => void;
}

function getStoredInput(workflowId: string): string {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${workflowId}`) ?? '';
  } catch {
    return '';
  }
}

function storeInput(workflowId: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(`${STORAGE_PREFIX}${workflowId}`, value);
    } else {
      localStorage.removeItem(`${STORAGE_PREFIX}${workflowId}`);
    }
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/**
 * Validate a JSON string. Returns null when valid (or empty), otherwise the
 * parse-error message.
 */
function validateJson(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : 'Invalid JSON';
  }
}

export function RunWorkflowDialog({
  open,
  onOpenChange,
  workflowId,
  workflowName,
  loading = false,
  onRun,
}: RunWorkflowDialogProps) {
  const [inputValue, setInputValue] = useState('');

  // Restore remembered input when the dialog opens for a given workflowId
  useEffect(() => {
    if (open && workflowId) {
      setInputValue(getStoredInput(workflowId));
    }
  }, [open, workflowId]);

  const validationError = useMemo(() => validateJson(inputValue), [inputValue]);
  const hasInput = inputValue.trim().length > 0;
  const runDisabled = loading || (hasInput && validationError !== null);

  const handleRun = useCallback(() => {
    const trimmed = inputValue.trim();
    storeInput(workflowId, trimmed);
    if (trimmed) {
      onRun(workflowId, trimmed);
    } else {
      onRun(workflowId);
    }
  }, [inputValue, workflowId, onRun]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="run-workflow-dialog">
        <DialogHeader>
          <DialogTitle>Run Workflow</DialogTitle>
          <DialogDescription>
            {workflowName
              ? `Start an execution of "${workflowName}".`
              : 'Start a workflow execution.'}{' '}
            Optionally provide a JSON input payload.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="run-input">Input (optional)</Label>
          <Textarea
            id="run-input"
            data-testid="run-input-textarea"
            className="font-mono text-xs min-h-[120px]"
            placeholder='e.g. {"route": "branch-b"}'
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            aria-invalid={hasInput && validationError !== null}
          />
          {hasInput && validationError && (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="run-input-error"
            >
              {validationError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            data-testid="run-dialog-confirm"
            disabled={runDisabled}
            onClick={handleRun}
          >
            {loading ? 'Starting…' : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
