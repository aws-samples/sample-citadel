import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Progress } from './ui/progress';
import { ScrollArea } from './ui/scroll-area';
import type { PendingApprovalItem, ApprovalDecision } from '../services/approvalsService';
import type { BulkItemResult } from '../hooks/useBulkApproval';

type Phase = 'confirm' | 'executing' | 'done';

export interface BulkApprovalDialogProps {
  records: PendingApprovalItem[];
  decision: ApprovalDecision;
  results: BulkItemResult[];
  progress: { completed: number; total: number };
  isExecuting: boolean;
  onConfirm: (reason?: string) => void;
  onRetry: () => void;
  onClose: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; label: string; className: string }> = {
  pending: { icon: '⏳', label: 'Pending', className: 'text-muted-foreground' },
  succeeded: { icon: '✓', label: 'Succeeded', className: 'text-primary' },
  conflict: { icon: '⚠', label: 'Conflict', className: 'text-destructive/70' },
  denied: { icon: '🚫', label: 'Denied', className: 'text-destructive' },
  failed: { icon: '✗', label: 'Failed', className: 'text-destructive' },
};

export const BulkApprovalDialog: React.FC<BulkApprovalDialogProps> = ({
  records,
  decision,
  results,
  progress,
  isExecuting,
  onConfirm,
  onRetry,
  onClose,
}) => {
  const [reason, setReason] = useState('');
  const isReject = decision === 'REJECTED';

  const phase: Phase = isExecuting ? 'executing' : results.length > 0 ? 'done' : 'confirm';
  const reasonValid = !isReject || reason.trim().length >= 3;

  const failedCount = results.filter((r) => r.status !== 'succeeded' && r.status !== 'pending').length;
  const succeededCount = results.filter((r) => r.status === 'succeeded').length;
  const actionWord = isReject ? 'rejected' : 'approved';

  const progressPercent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isExecuting) onClose(); }}>
      <DialogContent data-testid="bulk-dialog">
        <DialogHeader>
          <DialogTitle data-testid="bulk-dialog-title">
            {phase === 'confirm' && `${isReject ? 'Reject' : 'Approve'} ${records.length} records?`}
            {phase === 'executing' && `Processing ${progress.completed}/${progress.total}…`}
            {phase === 'done' && `${succeededCount} ${actionWord}, ${failedCount} failed`}
          </DialogTitle>
          {phase === 'confirm' && (
            <DialogDescription>
              {isReject
                ? `This will reject ${records.length} records. Please provide a reason.`
                : `This will approve ${records.length} records and make them available for use.`}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Record list (confirm phase) */}
        {phase === 'confirm' && (
          <>
            <ScrollArea className="max-h-[300px] overflow-y-auto">
              <ul className="flex flex-col gap-2" data-testid="record-list">
                {records.map((record) => (
                  <li key={record.recordId} className="flex items-center gap-2 text-sm">
                    <span>{record.displayName || record.name}</span>
                    <Badge variant={record.recordType === 'agent' ? 'default' : 'secondary'}>
                      {record.recordType}
                    </Badge>
                    {record.version !== undefined && (
                      <span className="text-muted-foreground text-xs">v{record.version}</span>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>

            {isReject && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="bulk-rejection-reason">Reason</Label>
                <Textarea
                  id="bulk-rejection-reason"
                  data-testid="bulk-rejection-reason"
                  placeholder="Why are these being rejected?"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                {reason.length > 0 && reason.trim().length < 3 && (
                  <p className="text-sm text-destructive">Reason must be at least 3 characters.</p>
                )}
              </div>
            )}
          </>
        )}

        {/* Progress + results (executing / done) */}
        {(phase === 'executing' || phase === 'done') && (
          <div className="flex flex-col gap-3">
            <Progress value={progressPercent} data-testid="bulk-progress" />
            <ScrollArea className="max-h-[300px] overflow-y-auto">
              <ul className="flex flex-col gap-1" data-testid="results-list">
                {results.map((r) => {
                  const s = STATUS_ICONS[r.status] ?? STATUS_ICONS.pending;
                  return (
                    <li key={r.recordId} className={`flex items-center gap-2 text-sm ${s.className}`} data-testid={`result-${r.recordId}`}>
                      <span aria-label={s.label}>{s.icon}</span>
                      <span>{r.name}</span>
                      {r.error && <span className="text-xs text-muted-foreground">— {r.error}</span>}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          {phase === 'confirm' && (
            <>
              <Button variant="outline" onClick={onClose} data-testid="bulk-cancel">
                Cancel
              </Button>
              <Button
                variant={isReject ? 'destructive' : 'default'}
                disabled={!reasonValid}
                onClick={() => onConfirm(isReject ? reason.trim() : undefined)}
                data-testid="bulk-confirm"
              >
                {isReject ? 'Reject' : 'Approve'}
              </Button>
            </>
          )}
          {phase === 'executing' && (
            <Button variant="outline" disabled data-testid="bulk-close">
              Processing…
            </Button>
          )}
          {phase === 'done' && (
            <>
              {failedCount > 0 && (
                <Button variant="outline" onClick={onRetry} data-testid="retry-failed">
                  Retry failed ({failedCount})
                </Button>
              )}
              <Button onClick={onClose} data-testid="bulk-close">
                Close
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
