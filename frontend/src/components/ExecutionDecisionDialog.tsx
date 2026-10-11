/**
 * ExecutionDecisionDialog
 *
 * Lightweight AlertDialog for execution actions that require a reason
 * (Pause, Deny). Approve goes through without a dialog.
 *
 * Requirements: CIT-030
 */

import React, { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';

export type ExecutionDecisionKind = 'pause' | 'deny';

export interface ExecutionDecisionDialogProps {
  kind: ExecutionDecisionKind;
  executionId: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
  /** When set to 'execution', the dialog shows execution-scoped copy. */
  scope?: 'execution' | 'node' | null;
  /** Number of paused nodes (used in execution-scoped copy). */
  count?: number;
}

const TITLES: Record<ExecutionDecisionKind, string> = {
  pause: 'Pause execution',
  deny: 'Deny execution',
};

const DESCRIPTIONS: Record<ExecutionDecisionKind, string> = {
  pause: 'Provide a reason for pausing this execution.',
  deny: 'Provide a reason for denying this execution.',
};

function getTitle(kind: ExecutionDecisionKind, scope?: string | null, _count?: number): string {
  if (scope === 'execution') {
    return kind === 'deny' ? 'Deny execution' : 'Resume execution';
  }
  return TITLES[kind];
}

function getDescription(kind: ExecutionDecisionKind, scope?: string | null, count?: number): string {
  const n = count ?? 0;
  const nodeWord = n === 1 ? 'node' : 'nodes';
  if (scope === 'execution') {
    if (kind === 'pause') return `Resume all ${n} paused ${nodeWord}.`;
    return `Deny and fail ${n} ${nodeWord}.`;
  }
  return DESCRIPTIONS[kind];
}

function getConfirmLabel(kind: ExecutionDecisionKind, scope?: string | null): string {
  if (scope === 'execution') {
    return kind === 'deny' ? 'Deny' : 'Resume';
  }
  return kind === 'pause' ? 'Pause' : 'Deny';
}

export const ExecutionDecisionDialog: React.FC<ExecutionDecisionDialogProps> = ({
  kind,
  executionId,
  onConfirm,
  onCancel,
  scope,
  count,
}) => {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const reasonValid = reason.trim().length >= 3;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{getTitle(kind, scope, count)}</AlertDialogTitle>
          <AlertDialogDescription>
            {getDescription(kind, scope, count)} (Execution {executionId.slice(0, 8)}…)
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="execution-decision-reason">Reason</Label>
          <Textarea
            id="execution-decision-reason"
            data-testid="execution-decision-reason"
            placeholder="Reason (min 3 characters)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
          />
          {reason.length > 0 && !reasonValid && (
            <p className="text-sm text-destructive">Reason must be at least 3 characters.</p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting} onClick={onCancel}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting || !reasonValid}
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            data-testid="confirm-execution-decision"
          >
            {submitting ? 'Submitting…' : getConfirmLabel(kind, scope)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
