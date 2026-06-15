/**
 * AuthorityGraphHistorySettingsDialog
 *
 * Settings card-driven dialog for the authority graph
 * history toggle. Default state is OFF — operators consciously opt in
 * via the Enabled switch + acknowledgement checkbox + Confirm button.
 *
 * Capture modes: 'daily' (scheduled snapshot only), 'on-change' (DDB-
 * stream-driven snapshot only), and 'both'. The two snapshot Lambdas
 * gate themselves on captureMode so toggling between modes does not
 * require redeploying any infrastructure.
 *
 * Layered safety gates:
 *   1. Admin-only (parent page already checks; the resolver enforces).
 *   2. Acknowledgement checkbox using the verbatim shared constant.
 *   3. Confirm button stays disabled until acknowledgement is ticked
 *      AND at least one field has changed from the current settings.
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
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import { Checkbox } from './ui/checkbox';
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
  AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT,
  AuthorityGraphHistorySettings,
  AuthorityGraphHistorySettingsResult,
} from '../services/governanceService';

export interface AuthorityGraphHistorySettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSettings: AuthorityGraphHistorySettings;
  onSaved: (result: AuthorityGraphHistorySettingsResult) => void;
}

const RETENTION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '365 days' },
];

interface CaptureModeOption {
  value: 'daily' | 'on-change' | 'both';
  label: string;
  disabled: boolean;
}

const CAPTURE_MODE_OPTIONS: ReadonlyArray<CaptureModeOption> = [
  { value: 'daily', label: 'daily', disabled: false },
  { value: 'on-change', label: 'on-change', disabled: false },
  { value: 'both', label: 'both', disabled: false },
];

const REASON_MAX_LENGTH = 500;

// Average snapshot size in KB — kept in sync with the resolver default.
const AVG_KB_PER_SNAPSHOT = 8;

function estimateSnapshotsAtRest(
  enabled: boolean,
  retentionDays: number,
  captureMode: string,
): number {
  // 'daily' = 1 snapshot/day; 'on-change' = unknown (depends on edit
  // volume); 'both' = daily + on-change.
  if (!enabled) return 0;
  if (captureMode === 'daily') return Math.max(0, Math.trunc(retentionDays));
  // best-effort: daily count for both modes; on-change adds an
  // indeterminate count so we keep the same lower bound.
  return Math.max(0, Math.trunc(retentionDays));
}

export function AuthorityGraphHistorySettingsDialog({
  open,
  onOpenChange,
  currentSettings,
  onSaved,
}: AuthorityGraphHistorySettingsDialogProps) {
  const [enabled, setEnabled] = useState(currentSettings.enabled);
  const [retentionDays, setRetentionDays] = useState(
    currentSettings.retentionDays,
  );
  const [captureMode, setCaptureMode] =
    useState<CaptureModeOption['value']>(
      (currentSettings.captureMode as CaptureModeOption['value']) ?? 'daily',
    );
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset every gate when the dialog opens or the source settings
  // change. The component is unmounted on close so this is mostly
  // belt-and-braces — the page can keep the dialog mounted and toggle
  // `open` if it ever wants to.
  useEffect(() => {
    if (!open) return;
    setEnabled(currentSettings.enabled);
    setRetentionDays(currentSettings.retentionDays);
    setCaptureMode(
      (currentSettings.captureMode as CaptureModeOption['value']) ?? 'daily',
    );
    setReason('');
    setAcknowledged(false);
    setSubmitError(null);
    setSubmitting(false);
  }, [
    open,
    currentSettings.enabled,
    currentSettings.retentionDays,
    currentSettings.captureMode,
  ]);

  const hasChanges = useMemo(() => {
    return (
      enabled !== currentSettings.enabled ||
      retentionDays !== currentSettings.retentionDays ||
      captureMode !== currentSettings.captureMode
    );
  }, [
    enabled,
    retentionDays,
    captureMode,
    currentSettings.enabled,
    currentSettings.retentionDays,
    currentSettings.captureMode,
  ]);

  const confirmDisabled = !acknowledged || !hasChanges || submitting;

  const projectedCount = estimateSnapshotsAtRest(
    enabled,
    retentionDays,
    captureMode,
  );
  const projectedKb = projectedCount * AVG_KB_PER_SNAPSHOT;

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await governanceService.updateAuthorityGraphHistorySettings({
        enabled,
        retentionDays,
        captureMode,
        reason: reason.length > 0 ? reason : null,
      });
      onSaved(result);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Settings update failed';
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
        data-testid="authority-graph-history-settings-dialog"
      >
        <DialogHeader>
          <DialogTitle data-testid="authority-graph-history-settings-title">
            Authority graph history settings
          </DialogTitle>
          <DialogDescription
            data-testid="authority-graph-history-settings-description"
          >
            When enabled, a daily snapshot of authority units, composition
            contracts, constitutional layers, and case-law entries is
            written to a TTL-managed DDB table. Disable to avoid storage
            cost when traceability is not required.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex items-center justify-between gap-4">
            <Label
              htmlFor="authority-graph-history-enabled"
              className="text-sm text-foreground"
            >
              Enabled
            </Label>
            <Switch
              id="authority-graph-history-enabled"
              checked={enabled}
              onCheckedChange={(c) => setEnabled(c === true)}
              data-testid="authority-graph-history-enabled-switch"
              disabled={submitting}
              aria-label="Enable authority graph history snapshots"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="authority-graph-history-retention"
              className="text-xs text-muted-foreground"
            >
              Retention
            </Label>
            <Select
              value={String(retentionDays)}
              onValueChange={(v) => setRetentionDays(Number(v))}
              disabled={submitting}
            >
              <SelectTrigger
                id="authority-graph-history-retention"
                data-testid="authority-graph-history-retention-trigger"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTION_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={String(opt.value)}
                    data-testid={`authority-graph-history-retention-option-${opt.value}`}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="authority-graph-history-capture-mode"
              className="text-xs text-muted-foreground"
            >
              Capture mode
            </Label>
            <Select
              value={captureMode}
              onValueChange={(v) =>
                setCaptureMode(v as CaptureModeOption['value'])
              }
              disabled={submitting}
            >
              <SelectTrigger
                id="authority-graph-history-capture-mode"
                data-testid="authority-graph-history-capture-mode-trigger"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPTURE_MODE_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.disabled}
                    data-testid={`authority-graph-history-capture-mode-option-${opt.value}`}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p
            className="text-xs text-muted-foreground"
            data-testid="authority-graph-history-storage-estimate"
          >
            Estimated ~{projectedCount} snapshots will be retained at any time
            → ~{projectedKb}KB
          </p>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="authority-graph-history-reason"
              className="text-xs text-muted-foreground"
            >
              Reason (optional)
            </Label>
            <Textarea
              id="authority-graph-history-reason"
              value={reason}
              onChange={(e) =>
                setReason(e.target.value.slice(0, REASON_MAX_LENGTH))
              }
              placeholder="e.g. enabling history for time-scrubber soak"
              data-testid="authority-graph-history-reason"
              disabled={submitting}
              maxLength={REASON_MAX_LENGTH}
            />
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="authority-graph-history-ack-checkbox"
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              data-testid="authority-graph-history-ack-checkbox"
              disabled={submitting}
            />
            <Label
              htmlFor="authority-graph-history-ack-checkbox"
              className="text-sm text-foreground leading-snug"
              data-testid="authority-graph-history-ack-label"
            >
              {AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT}
            </Label>
          </div>

          {submitError && (
            <Alert
              variant="destructive"
              data-testid="authority-graph-history-error"
            >
              <AlertTitle>Settings update failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="authority-graph-history-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="authority-graph-history-confirm"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save settings'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AuthorityGraphHistorySettingsDialog;
