import React from 'react';
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

interface RequireReapprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  recordKind?: 'agent' | 'tool';
}

/**
 * Shared confirm shown before saving a content edit (Details or Code tab)
 * to a registry-backed, approved record. Saving demotes APPROVED/REJECTED
 * back to Draft, so the demotion must never happen silently.
 */
export const RequireReapprovalDialog: React.FC<RequireReapprovalDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  recordKind = 'agent',
}) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Saving will require re-approval</AlertDialogTitle>
          <AlertDialogDescription>
            This {recordKind} is approved. Saving changes moves it back to Draft in the registry;
            use Activate afterwards to resubmit it for approval.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Save</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
