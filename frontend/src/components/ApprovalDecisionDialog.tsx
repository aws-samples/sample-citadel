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
import type { PendingApprovalItem, ApprovalDecision } from '../services/approvalsService';

export interface ApprovalDecisionDialogProps {
  record: PendingApprovalItem;
  decision: ApprovalDecision;
  onConfirm: (statusReason?: string) => Promise<void>;
  onCancel: () => void;
}

export const ApprovalDecisionDialog: React.FC<ApprovalDecisionDialogProps> = ({
  record,
  decision,
  onConfirm,
  onCancel,
}) => {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isReject = decision === 'REJECTED';
  const displayName = record.displayName || record.name;
  const reasonValid = !isReject || reason.trim().length >= 3;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm(isReject ? reason.trim() : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isReject ? 'Reject' : 'Approve'} {displayName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isReject
              ? `This will reject "${displayName}". Please provide a reason.`
              : `This will approve "${displayName}" and make it available for use.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isReject && (
          <div className="space-y-2">
            <Label htmlFor="rejection-reason">Reason</Label>
            <Textarea
              id="rejection-reason"
              data-testid="rejection-reason"
              placeholder="Why is this being rejected?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
            />
            {reason.length > 0 && reason.trim().length < 3 && (
              <p className="text-sm text-destructive">Reason must be at least 3 characters.</p>
            )}
          </div>
        )}

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
            data-testid="confirm-decision"
          >
            {submitting ? 'Submitting…' : isReject ? 'Reject' : 'Approve'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
