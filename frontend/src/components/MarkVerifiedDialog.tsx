/**
 * MarkVerifiedDialog
 *
 * Operator attestation dialog for the 6 manual readiness stubs (tel-1,
 * tel-2, rb-2, own-1, own-2, own-3). The dialog gathers a verification
 * window (1 / 3 / 7 / 30 days, default 7) and an optional note, then
 * calls `governanceService.markReadinessCheckVerified` which writes the
 * SSM record consumed by `getRolloutReadiness`.
 *
 * The component is intentionally simple: a single mutation, inline error
 * surface, no readiness re-fetch (the parent `Rollout.tsx` triggers that
 * after onVerified). Colour discipline mirrors ModeFlipDialog — every
 * status colour comes from Tailwind tokens, no hex literals.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  governanceService,
  MarkReadinessCheckVerifiedResult,
} from '../services/governanceService';

const ALLOWED_DAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1 day' },
  { value: 3, label: '3 days' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
];
const DEFAULT_DAYS = 7;
const NOTE_MAX_LENGTH = 200;

export interface MarkVerifiedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkId: string;
  checkLabel: string;
  onVerified: (result: MarkReadinessCheckVerifiedResult) => void;
}

export function MarkVerifiedDialog({
  open,
  onOpenChange,
  checkId,
  checkLabel,
  onVerified,
}: MarkVerifiedDialogProps) {
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset every field when the dialog opens. We never want a stale value
  // carried across separate verification flows.
  useEffect(() => {
    if (!open) return;
    setDays(DEFAULT_DAYS);
    setNote('');
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await governanceService.markReadinessCheckVerified({
        checkId,
        expiresInDays: days,
        note: note.trim().length > 0 ? note.trim() : null,
      });
      onVerified(result);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Mark verified failed';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    onOpenChange(false);
  };

  const noteLength = note.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="mark-verified-dialog"
        data-check-id={checkId}
      >
        <DialogHeader>
          <DialogTitle data-testid="mark-verified-dialog-title">
            Mark verified: {checkLabel}
          </DialogTitle>
          <DialogDescription data-testid="mark-verified-dialog-intro">
            Attest that you have performed this manual operator check (for
            example, reviewed the dashboard or confirmed the PagerDuty test).
            The readiness page will treat this check as PASS until the
            verification expires.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="mark-verified-days"
              className="text-xs text-muted-foreground"
            >
              Verification window
            </Label>
            <Select
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
              disabled={submitting}
            >
              <SelectTrigger
                id="mark-verified-days"
                data-testid="mark-verified-days-trigger"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALLOWED_DAYS.map((d) => (
                  <SelectItem
                    key={d.value}
                    value={String(d.value)}
                    data-testid={`mark-verified-days-option-${d.value}`}
                  >
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="mark-verified-note"
              className="text-xs text-muted-foreground"
            >
              Note (optional, {NOTE_MAX_LENGTH} char max) — {noteLength}/{NOTE_MAX_LENGTH}
            </Label>
            <Textarea
              id="mark-verified-note"
              value={note}
              onChange={(e) =>
                setNote(e.target.value.slice(0, NOTE_MAX_LENGTH))
              }
              placeholder="Operator notes — surfaced on the readiness detail line."
              aria-label="Note"
              data-testid="mark-verified-note"
              disabled={submitting}
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
            />
          </div>

          {submitError && (
            <Alert variant="destructive" data-testid="mark-verified-error">
              <AlertTitle>Mark verified failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="mark-verified-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleConfirm}
            disabled={submitting}
            data-testid="mark-verified-confirm"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Marking...
              </>
            ) : (
              <>Mark verified</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MarkVerifiedDialog;
