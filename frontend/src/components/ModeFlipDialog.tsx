/**
 * ModeFlipDialog
 *
 * Confirmation dialog for the setGovernanceMode mutation. PRODUCTION-AFFECTING.
 * Layered safety gates (in order): readiness re-fetch + FAIL/UNKNOWN warning,
 * typed-match input, acknowledgement checkbox, optional reason. The Confirm
 * button stays disabled until every applicable gate is satisfied, and the
 * acknowledgement string submitted to the backend is the verbatim shared
 * constant — any drift between this modal and the resolver is a contract bug.
 *
 * Colour discipline: every status colour comes from Tailwind tokens
 * (`text-chart-2`, `text-chart-4`, `text-destructive`, etc.) so theme-mode
 * inversion stays correct. No hex literals.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
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
  MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
  ReadinessCheck,
  RolloutReadinessReport,
  SetGovernanceModeResult,
} from '../services/governanceService';

export type GovernanceTargetMode = 'permissive' | 'shadow' | 'strict';

export interface ModeFlipDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentMode: string;
  targetMode: GovernanceTargetMode;
  /**
   * The summary the parent already has when the dialog opens. The dialog
   * also re-fetches readiness on open so the gate evaluates against
   * fresh data; this prop is kept as the visible default until the
   * re-fetch resolves.
   */
  readinessSummary: {
    passCount: number;
    failCount: number;
    warnCount: number;
    stubCount: number;
  };
  onConfirmed: (result: SetGovernanceModeResult) => void;
}

// Mode-colour discipline. Mirrors ModeBadge.tsx so the title arrow renders
// the same hues the badge already shows in the header.
const MODE_TEXT_CLASS: Record<string, string> = {
  permissive: 'text-muted-foreground',
  shadow: 'text-chart-4',
  strict: 'text-chart-2',
};

const MODE_INTRO: Record<GovernanceTargetMode, string> = {
  permissive:
    'Permissive bypasses the governance gate entirely. Use only as a rollback parking state — no enforcement, no shadow logging.',
  shadow:
    'Shadow evaluates the gate but does not block dispatches. Mismatches are logged so the soak window surfaces data-quality issues before any user-facing rejection.',
  strict:
    'Strict fails closed on any workload-identity mismatch and WILL block dispatches. Confirm only after the readiness checklist is clean and a successful shadow soak is on record.',
};

function modeColourClass(mode: string): string {
  return MODE_TEXT_CLASS[mode] ?? MODE_TEXT_CLASS.permissive;
}

/**
 * Compute UNKNOWN counts client-side from the freshest checks list. The
 * resolver's report shape only carries pass/fail/warn/stub counts; this
 * helper recovers the unknownCount that gates the warning panel.
 */
function countUnknown(checks: ReadinessCheck[] | undefined): number {
  if (!checks) return 0;
  let n = 0;
  for (const c of checks) if (c.status === 'UNKNOWN') n++;
  return n;
}

interface ReadinessSnapshot {
  passCount: number;
  failCount: number;
  warnCount: number;
  stubCount: number;
  unknownCount: number;
}

function snapshotFromReport(report: RolloutReadinessReport): ReadinessSnapshot {
  return {
    passCount: report.passCount,
    failCount: report.failCount,
    warnCount: report.warnCount,
    stubCount: report.stubCount,
    unknownCount: countUnknown(report.checks),
  };
}

function snapshotFromProp(
  prop: ModeFlipDialogProps['readinessSummary'],
): ReadinessSnapshot {
  return {
    passCount: prop.passCount,
    failCount: prop.failCount,
    warnCount: prop.warnCount,
    stubCount: prop.stubCount,
    unknownCount: 0,
  };
}

export function ModeFlipDialog({
  open,
  onOpenChange,
  currentMode,
  targetMode,
  readinessSummary,
  onConfirmed,
}: ModeFlipDialogProps) {
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot>(() =>
    snapshotFromProp(readinessSummary),
  );
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [typedMatch, setTypedMatch] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  const [overrideText, setOverrideText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset every gate when the dialog opens. We never want a stale typed
  // value or acknowledgement carried across separate flips.
  useEffect(() => {
    if (!open) return;
    setTypedMatch('');
    setAcknowledged(false);
    setReason('');
    setOverrideText('');
    setSubmitError(null);
    setSubmitting(false);
    setSnapshot(snapshotFromProp(readinessSummary));
  }, [open, readinessSummary]);

  // Re-fetch readiness on open — only for shadow/strict targets, where the
  // FAIL/UNKNOWN gate matters. Permissive rollback skips the re-fetch.
  useEffect(() => {
    if (!open) return;
    if (targetMode === 'permissive') return;
    let mounted = true;
    setReadinessLoading(true);
    governanceService
      .getRolloutReadiness()
      .then((report) => {
        if (!mounted) return;
        setSnapshot(snapshotFromReport(report));
      })
      .catch(() => {
        // Best-effort. The prop snapshot remains visible; the operator can
        // still proceed via the typed-match + acknowledgement gates if the
        // re-fetch fails.
      })
      .finally(() => {
        if (mounted) setReadinessLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [open, targetMode]);

  const requiresReadinessGate =
    targetMode === 'shadow' || targetMode === 'strict';
  const hasUnknownOrFail =
    requiresReadinessGate &&
    (snapshot.failCount > 0 || snapshot.unknownCount > 0);
  const overrideAccepted = overrideText === 'OVERRIDE';

  // Gates:
  //   1. readiness — failCount/unknownCount must be 0, OR operator typed OVERRIDE
  //   2. typed match — case-sensitive equality with targetMode
  //   3. acknowledgement — checkbox ticked
  // All gates skipped during submission so the spinner reflects the in-flight
  // call; Cancel re-enables on error.
  const readinessOk = !hasUnknownOrFail || overrideAccepted;
  const typedOk = typedMatch === targetMode;
  const allGatesOk = readinessOk && typedOk && acknowledged;
  const confirmDisabled = !allGatesOk || submitting;

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await governanceService.setGovernanceMode({
        targetMode,
        acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
        reason: reason.trim().length > 0 ? reason.trim() : null,
      });
      onConfirmed(result);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Mode flip failed';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    onOpenChange(false);
  };

  const totalChecks = useMemo(
    () =>
      snapshot.passCount +
      snapshot.failCount +
      snapshot.warnCount +
      snapshot.stubCount +
      snapshot.unknownCount,
    [snapshot],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="mode-flip-dialog"
        data-target-mode={targetMode}
        data-current-mode={currentMode}
      >
        <DialogHeader>
          <DialogTitle data-testid="mode-flip-dialog-title">
            Flip governance mode:{' '}
            <span
              className={modeColourClass(currentMode)}
              data-testid="mode-flip-dialog-current"
            >
              {currentMode}
            </span>{' '}
            <ArrowRight className="inline size-4 align-text-bottom text-muted-foreground" />{' '}
            <span
              className={modeColourClass(targetMode)}
              data-testid="mode-flip-dialog-target"
            >
              {targetMode}
            </span>
          </DialogTitle>
          <DialogDescription data-testid="mode-flip-dialog-intro">
            {MODE_INTRO[targetMode]}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {requiresReadinessGate && (
            <Card
              className="rounded-md p-3 gap-0"
              data-testid="mode-flip-readiness-summary"
              data-loading={readinessLoading ? 'true' : 'false'}
            >
              <p className="text-xs text-muted-foreground mb-2">
                Readiness ({totalChecks} checks)
              </p>
              <div className="flex gap-2 flex-wrap">
                <span
                  className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium border-chart-2/40 text-chart-2 bg-chart-2/10"
                  data-testid="mode-flip-pill-pass"
                >
                  {snapshot.passCount} PASS
                </span>
                <span
                  className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium border-destructive/40 text-destructive bg-destructive/10"
                  data-testid="mode-flip-pill-fail"
                >
                  {snapshot.failCount} FAIL
                </span>
                <span
                  className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium border-chart-4/40 text-chart-4 bg-chart-4/10"
                  data-testid="mode-flip-pill-warn"
                >
                  {snapshot.warnCount} WARN
                </span>
                <span
                  className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium border-border text-muted-foreground bg-muted/30"
                  data-testid="mode-flip-pill-stub"
                >
                  {snapshot.stubCount} STUB
                </span>
              </div>
              {hasUnknownOrFail && (
                <Alert
                  variant="destructive"
                  className="mt-3"
                  data-testid="mode-flip-readiness-warning"
                >
                  <AlertTitle>Readiness gate failed</AlertTitle>
                  <AlertDescription>
                    {snapshot.failCount} FAIL and {snapshot.unknownCount} UNKNOWN
                    checks. Type{' '}
                    <span className="font-mono font-semibold">OVERRIDE</span> to
                    proceed anyway.
                  </AlertDescription>
                </Alert>
              )}
              {hasUnknownOrFail && (
                <div className="mt-2 flex flex-col gap-1">
                  <Label
                    htmlFor="mode-flip-override-input"
                    className="text-xs text-muted-foreground"
                  >
                    Type OVERRIDE to bypass
                  </Label>
                  <Input
                    id="mode-flip-override-input"
                    value={overrideText}
                    onChange={(e) => setOverrideText(e.target.value)}
                    placeholder="OVERRIDE"
                    aria-label="Override readiness gate"
                    data-testid="mode-flip-override-input"
                    disabled={submitting}
                  />
                </div>
              )}
            </Card>
          )}

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="mode-flip-typed-input"
              className="text-xs text-muted-foreground"
            >
              Type &quot;{targetMode}&quot; to confirm
            </Label>
            <Input
              id="mode-flip-typed-input"
              value={typedMatch}
              onChange={(e) => setTypedMatch(e.target.value)}
              placeholder={`Type "${targetMode}" to confirm`}
              aria-label="Type target mode to confirm"
              data-testid="mode-flip-typed-input"
              disabled={submitting}
              autoComplete="off"
            />
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="mode-flip-ack-checkbox"
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              data-testid="mode-flip-ack-checkbox"
              disabled={submitting}
            />
            <Label
              htmlFor="mode-flip-ack-checkbox"
              className="text-sm text-foreground leading-snug"
              data-testid="mode-flip-ack-label"
            >
              {MODE_FLIP_ACKNOWLEDGEMENT_TEXT}
            </Label>
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="mode-flip-reason-input"
              className="text-xs text-muted-foreground"
            >
              Reason (optional)
            </Label>
            <Textarea
              id="mode-flip-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Operator notes — rides along on the audit event."
              aria-label="Reason"
              data-testid="mode-flip-reason-input"
              disabled={submitting}
              rows={3}
            />
          </div>

          {submitError && (
            <Alert
              variant="destructive"
              data-testid="mode-flip-submit-error"
            >
              <AlertTitle>Mode flip failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="mode-flip-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="mode-flip-confirm"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Flipping...
              </>
            ) : (
              <>Flip to {targetMode}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ModeFlipDialog;
