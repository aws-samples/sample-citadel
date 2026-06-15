/**
 * CaseLawActionDialog
 *
 * Inline case-law admin dialog wired by the governance Case-law page.
 * Three modes share the same dialog shell and three layered safety
 * gates (acknowledgement, optional reason, mode-specific guard):
 *
 *   - revoke              → soft-delete a precedent. Typed-match REVOKE.
 *   - unrevoke            → restore a previously-revoked precedent.
 *                            Typed-match RESTORE.
 *   - update-precedence   → change the precedence integer used at
 *                            engine step 1. Number Input gated by
 *                            [-1000, 1000] integer range + must
 *                            differ from the existing value. (No
 *                            typed-match — lower-blast-radius op.)
 *
 * Layered safety gates:
 *   1. Admin-only (parent page already checks; the resolver enforces).
 *   2. Acknowledgement checkbox using the verbatim shared constant.
 *   3. Per-mode confirm-input requirement (typed REVOKE / RESTORE for
 *      the soft-delete pair; numeric-bounds + delta for precedence).
 *
 * Colour discipline: every status colour comes from Tailwind tokens
 * (`text-destructive`, `text-muted-foreground`, etc.) so theme-mode
 * inversion stays correct. No hex literals.
 */

import { useEffect, useMemo, useState } from 'react';
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
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  governanceService,
  CASELAW_ACKNOWLEDGEMENT_TEXT,
  CaseLawEntry,
  CaseLawMutationResult,
} from '../services/governanceService';

export type CaseLawActionMode =
  | 'revoke'
  | 'unrevoke'
  | 'update-precedence';

export interface CaseLawActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: CaseLawActionMode;
  entry: CaseLawEntry;
  onCommitted: (result: CaseLawMutationResult) => void;
}

const REASON_MAX_LENGTH = 200;
const PRECEDENCE_MIN = -1000;
const PRECEDENCE_MAX = 1000;

const TYPED_TOKENS: Record<CaseLawActionMode, string | null> = {
  revoke: 'REVOKE',
  unrevoke: 'RESTORE',
  'update-precedence': null,
};

function isFiniteIntegerInRange(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= PRECEDENCE_MIN &&
    value <= PRECEDENCE_MAX
  );
}

export function CaseLawActionDialog({
  open,
  onOpenChange,
  mode,
  entry,
  onCommitted,
}: CaseLawActionDialogProps) {
  const isPrecedenceMode = mode === 'update-precedence';
  const typedToken = TYPED_TOKENS[mode];
  const requiresTypedMatch = typedToken !== null;

  const [acknowledged, setAcknowledged] = useState(false);
  const [typedMatch, setTypedMatch] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [precedenceText, setPrecedenceText] = useState(
    String(entry.precedence),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset every gate when the dialog opens or the target entry / mode
  // changes. We never want a stale typed value or acknowledgement
  // carried across separate edits — including the precedence input,
  // which must re-prefill from the current entry every time.
  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setTypedMatch('');
    setReasonText('');
    setPrecedenceText(String(entry.precedence));
    setSubmitError(null);
    setSubmitting(false);
  }, [open, mode, entry.caseId, entry.precedence]);

  const parsedPrecedence = useMemo(() => {
    const trimmed = precedenceText.trim();
    if (trimmed.length === 0) return Number.NaN;
    const n = Number(trimmed);
    return n;
  }, [precedenceText]);

  const precedenceOk = isPrecedenceMode
    ? isFiniteIntegerInRange(parsedPrecedence) &&
      parsedPrecedence !== entry.precedence
    : true;
  const typedMatchOk = !requiresTypedMatch || typedMatch === typedToken;
  const allGatesOk = acknowledged && typedMatchOk && precedenceOk;
  const confirmDisabled = !allGatesOk || submitting;

  const title = useMemo(() => {
    if (mode === 'revoke') return `Revoke case-law entry ${entry.caseId}`;
    if (mode === 'unrevoke') {
      return `Restore revoked case-law entry ${entry.caseId}`;
    }
    return `Update precedence for ${entry.caseId}`;
  }, [mode, entry.caseId]);

  const description = useMemo(() => {
    if (mode === 'revoke') {
      return 'Revoking removes this precedent from engine evaluation. The next dispatch matching the pattern may now escalate or fall through to a different rule.';
    }
    if (mode === 'unrevoke') {
      return 'Restoring reactivates this precedent at engine step 1. The next dispatch matching the pattern will be evaluated against this case-law entry again.';
    }
    return 'Precedence determines the order in which case-law entries are evaluated at engine step 1 (highest first). Must be an integer in the range [-1000, 1000] and different from the current value.';
  }, [mode]);

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    const reason = reasonText.length > 0 ? reasonText : null;
    try {
      let result: CaseLawMutationResult;
      if (mode === 'revoke') {
        result = await governanceService.revokeCaseLaw(entry.caseId, reason);
      } else if (mode === 'unrevoke') {
        result = await governanceService.unrevokeCaseLaw(
          entry.caseId,
          reason,
        );
      } else {
        result = await governanceService.updateCaseLawPrecedence(
          entry.caseId,
          parsedPrecedence,
          reason,
        );
      }
      onCommitted(result);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Case-law mutation failed';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="case-law-action-dialog"
        data-mode={mode}
        data-case-id={entry.caseId}
      >
        <DialogHeader>
          <DialogTitle data-testid="case-law-action-title">{title}</DialogTitle>
          <DialogDescription data-testid="case-law-action-description">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <Card
            className="rounded-md p-3 text-xs flex flex-col gap-1"
            data-testid="case-law-action-summary"
          >
            <p className="text-muted-foreground">Case-law entry</p>
            <p className="font-mono text-foreground" data-testid="case-law-action-summary-pattern">
              <span className="text-muted-foreground">pattern: </span>
              <span>{entry.pattern}</span>
            </p>
            <p className="font-mono text-foreground" data-testid="case-law-action-summary-resolution">
              <span className="text-muted-foreground">resolution: </span>
              <span>{entry.resolution}</span>
            </p>
            <p className="font-mono text-foreground" data-testid="case-law-action-summary-precedence">
              <span className="text-muted-foreground">current precedence: </span>
              <span>{entry.precedence}</span>
            </p>
            <p className="font-mono text-foreground" data-testid="case-law-action-summary-encoded-by">
              <span className="text-muted-foreground">encoded by: </span>
              <span>{entry.encodedBy}</span>
            </p>
          </Card>

          {isPrecedenceMode && (
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="case-law-action-new-precedence"
                className="text-xs text-muted-foreground"
              >
                New precedence (integer, range {PRECEDENCE_MIN} to {PRECEDENCE_MAX})
              </Label>
              <Input
                id="case-law-action-new-precedence"
                type="number"
                min={PRECEDENCE_MIN}
                max={PRECEDENCE_MAX}
                step={1}
                value={precedenceText}
                onChange={(e) => setPrecedenceText(e.target.value)}
                className="font-mono"
                aria-label="New precedence"
                data-testid="case-law-action-new-precedence"
                disabled={submitting}
                autoComplete="off"
              />
              {precedenceText.length > 0 && !precedenceOk && (
                <p
                  className="text-destructive text-xs"
                  data-testid="case-law-action-precedence-error"
                >
                  Precedence must be an integer in range [{PRECEDENCE_MIN}, {PRECEDENCE_MAX}] and differ from the current value.
                </p>
              )}
            </div>
          )}

          {requiresTypedMatch && (
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="case-law-action-typed-match"
                className="text-xs text-muted-foreground"
              >
                Type &quot;{typedToken}&quot; to confirm
              </Label>
              <Input
                id="case-law-action-typed-match"
                value={typedMatch}
                onChange={(e) => setTypedMatch(e.target.value)}
                placeholder={`Type "${typedToken}" to confirm`}
                className="font-mono"
                aria-label="Typed confirmation"
                data-testid="case-law-action-typed-match"
                disabled={submitting}
                autoComplete="off"
              />
            </div>
          )}

          <div className="flex items-start gap-2">
            <Checkbox
              id="case-law-action-ack-checkbox"
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              data-testid="case-law-action-ack-checkbox"
              disabled={submitting}
            />
            <Label
              htmlFor="case-law-action-ack-checkbox"
              className="text-sm text-foreground leading-snug"
              data-testid="case-law-action-ack-label"
            >
              {CASELAW_ACKNOWLEDGEMENT_TEXT}
            </Label>
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="case-law-action-reason"
              className="text-xs text-muted-foreground"
            >
              Reason (optional, max {REASON_MAX_LENGTH} chars)
            </Label>
            <Textarea
              id="case-law-action-reason"
              value={reasonText}
              onChange={(e) =>
                setReasonText(e.target.value.slice(0, REASON_MAX_LENGTH))
              }
              maxLength={REASON_MAX_LENGTH}
              placeholder="Optional context for the audit log"
              className="font-mono text-xs"
              data-testid="case-law-action-reason"
              disabled={submitting}
            />
          </div>

          {submitError && (
            <Alert variant="destructive" data-testid="case-law-action-error">
              <AlertTitle>Case-law mutation failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="case-law-action-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={mode === 'revoke' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="case-law-action-confirm"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {mode === 'revoke'
                  ? 'Revoking…'
                  : mode === 'unrevoke'
                    ? 'Restoring…'
                    : 'Saving…'}
              </>
            ) : (
              <>
                {mode === 'revoke'
                  ? 'Revoke entry'
                  : mode === 'unrevoke'
                    ? 'Restore entry'
                    : 'Save precedence'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CaseLawActionDialog;
