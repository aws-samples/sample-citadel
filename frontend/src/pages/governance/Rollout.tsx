/**
 * Governance Rollout readiness.
 *
 * Read-only admin page plus the active mode-flip controls
 * shipped. Renders the 11-item readiness checklist from the
 * runbook (`docs/GOVERNANCE_ROLLOUT_RUNBOOK.md` § Pre-flip Readiness
 * Checklist), a permissive → shadow → strict stepper, and the flip /
 * rollback buttons that open the ModeFlipDialog.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Clock,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { Card } from '../../components/ui/card';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  MarkReadinessCheckVerifiedResult,
  ReadinessCheck,
  ReadinessCheckStatus,
  RolloutReadinessReport,
  SetGovernanceModeResult,
} from '../../services/governanceService';
import {
  ModeFlipDialog,
  GovernanceTargetMode,
} from '../../components/ModeFlipDialog';
import { MarkVerifiedDialog } from '../../components/MarkVerifiedDialog';

const STAGES: Array<'permissive' | 'shadow' | 'strict'> = [
  'permissive',
  'shadow',
  'strict',
];

// Only these 3 manual stub IDs may be marked verified by an operator.
// Mirrors the backend's MANUAL_VERIFICATION_ALLOWLIST and the resolver's
// STUB_CHECK_IDS. Drift is a contract bug.
const MANUAL_VERIFICATION_ALLOWLIST: ReadonlySet<string> = new Set([
  'own-1',
  'own-2',
  'own-3',
]);
const VERIFIED_DETAIL_PREFIX = 'Verified by ';

const CATEGORY_ORDER: Array<{ key: string; label: string }> = [
  { key: 'data-integrity', label: 'Data integrity' },
  { key: 'telemetry', label: 'Telemetry' },
  { key: 'rollback', label: 'Rollback' },
  { key: 'ownership', label: 'Ownership' },
];

interface CheckRemediation {
  description: string;
  routePath?: string;
  routeLabel?: string;
}

/**
 * Remediation guidance per readiness check ID. Shown in an expandable
 * 'How to fix' section on FAIL / WARN / UNKNOWN status. Manual STUB
 * checks already render their stubInstruction in the detail line and
 * present a 'Mark verified' button — they don't need a separate
 * remediation block.
 */
const CHECK_REMEDIATION: Record<string, CheckRemediation> = {
  'data-1': {
    description:
      'Some authority units are missing a registryId. Run a registry sync to populate the missing IDs, or revoke the affected units. Inspect the authority graph to identify which units are affected.',
    routePath: '/governance/graph',
    routeLabel: 'Open authority graph',
  },
  'data-2': {
    description:
      'Some registryIds reference registry records that no longer exist. The reconciler page lists the orphan / stale rows and the registry records they point at.',
    routePath: '/governance/reconciler',
    routeLabel: 'Open reconciler',
  },
  'data-3': {
    description:
      'The AgentCore Registry could not be reached, or some governance-aware agents/tools are missing a workload-identity attribute. Confirm the registry is configured (REGISTRY_ID env var on the resolver Lambda, REGISTRY_ENABLED feature flag) and reachable. The reconciler page surfaces drift between the registry and the ledger.',
    routePath: '/governance/reconciler',
    routeLabel: 'Open reconciler',
  },
  'tel-1': {
    description:
      'Shadow traffic spans less than 7 days. Switch to shadow mode using the Flip controls below, then let it run for at least 7 days before flipping to strict.',
  },
  'tel-2': {
    description:
      'The 24-hour mismatch rate exceeds 0.5% (or there is insufficient data to compute the rate). The Mismatch heatmap visualises which workflows and reasons are driving mismatches — investigate the hot cells before flipping to strict.',
    routePath: '/governance/mismatches',
    routeLabel: 'Open mismatch heatmap',
  },
  'tel-3': {
    description:
      'The registry-sync DLQ has had failures in the last 48 hours. Check the CloudWatch alarm and DLQ contents. Sync failures usually indicate a registry IAM or networking issue — contact platform-ops if it persists.',
  },
  'rb-1': {
    description:
      'The governance enforce mode SSM parameter is not configured correctly or has an unrecognised value. Verify the parameter exists at /citadel/governance/enforce/<env> and holds one of: permissive, shadow, strict.',
  },
  'rb-2': {
    description:
      'The rollback path has not been exercised in this environment within the last 7 days. Use the Flip controls below to flip to shadow then back to permissive in a non-prod env, then re-check.',
  },
};

const SOAK_TARGET_DAYS = 7;

function statusIcon(status: ReadinessCheckStatus) {
  if (status === 'PASS') {
    return (
      <CheckCircle2
        className="size-4 shrink-0 text-chart-2"
        data-testid="status-icon-pass"
      />
    );
  }
  if (status === 'FAIL') {
    return (
      <XCircle
        className="size-4 shrink-0 text-destructive"
        data-testid="status-icon-fail"
      />
    );
  }
  if (status === 'WARN') {
    return (
      <AlertTriangle
        className="size-4 shrink-0 text-amber-500"
        data-testid="status-icon-warn"
      />
    );
  }
  if (status === 'UNKNOWN') {
    return (
      <HelpCircle
        className="size-4 shrink-0 text-muted-foreground"
        data-testid="status-icon-unknown"
      />
    );
  }
  return (
    <Clock
      className="size-4 shrink-0 text-muted-foreground"
      data-testid="status-icon-stub"
    />
  );
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffMs = Date.now() - then;
  const sec = Math.abs(diffMs) / 1000;
  if (sec < 60) return diffMs >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function sanitizeEffectiveAt(value: string | null | undefined): string | null {
  // Backend SSM stores '__EMPTY__' as a sentinel for not-yet-set
  // parameters; it must not leak through to the UI. Treat anything that
  // doesn't parse as a date as null.
  if (!value || value === '__EMPTY__') return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return value;
}

function soakDurationDays(startedAtIso: string): number | null {
  const started = new Date(startedAtIso).getTime();
  if (Number.isNaN(started)) return null;
  const diffMs = Date.now() - started;
  if (diffMs < 0) return 0;
  return diffMs / (1000 * 60 * 60 * 24);
}

interface StepperProps {
  currentMode: string;
  effectiveAt: string | null;
  shadowSoakStartedAt: string | null;
}

function ModeStepper({
  currentMode,
  effectiveAt,
  shadowSoakStartedAt,
}: StepperProps) {
  const currentIndex = STAGES.indexOf(currentMode as (typeof STAGES)[number]);
  const effectiveAtSanitized = sanitizeEffectiveAt(effectiveAt);

  return (
    <div
      className="flex items-stretch gap-2 mb-6"
      data-testid="rollout-stepper"
      aria-label="Governance rollout stepper"
    >
      {STAGES.map((stage, i) => {
        const isCurrent = stage === currentMode;
        const isComplete = currentIndex >= 0 && i < currentIndex;
        const borderClass = isCurrent
          ? 'border-primary'
          : isComplete
            ? 'border-chart-2/40'
            : 'border-border';
        const labelClass = isCurrent
          ? 'text-foreground font-semibold'
          : 'text-muted-foreground';

        let footer: string | null = null;
        if (stage === 'shadow') {
          if (currentMode === 'shadow' && shadowSoakStartedAt) {
            const days = soakDurationDays(shadowSoakStartedAt);
            if (days !== null) {
              const dayStr =
                days < 1
                  ? `${Math.round(days * 24)}h`
                  : `${days.toFixed(1)}d`;
              const target =
                days >= SOAK_TARGET_DAYS ? '✓' : `target ${SOAK_TARGET_DAYS}d`;
              footer = `Soak ${dayStr} (${target})`;
            }
          } else if (effectiveAtSanitized) {
            footer = `Effective ${formatRelative(effectiveAtSanitized)}`;
          }
        }
        if (stage === 'strict' && currentMode === 'strict' && effectiveAtSanitized) {
          footer = `Effective ${formatRelative(effectiveAtSanitized)}`;
        }

        return (
          <div
            key={stage}
            className={`flex-1 rounded-lg border ${borderClass} p-4`}
            data-testid={`rollout-step-${stage}`}
            data-current={isCurrent ? 'true' : 'false'}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Step {i + 1}
              </span>
              {isComplete && (
                <CheckCircle2
                  className="size-4 text-chart-2"
                  data-testid={`rollout-step-${stage}-complete`}
                />
              )}
            </div>
            <p className={`text-base capitalize ${labelClass}`}>{stage}</p>
            {footer && (
              <p className="text-muted-foreground text-xs mt-1">{footer}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface CountsBarProps {
  passCount: number;
  failCount: number;
  warnCount: number;
  stubCount: number;
}

function CountsBar({ passCount, failCount, warnCount, stubCount }: CountsBarProps) {
  const pills: Array<{ key: string; count: number; cls: string; label: string }> = [
    { key: 'pass', count: passCount, cls: 'border-chart-2/40 text-chart-2 bg-chart-2/10', label: 'PASS' },
    { key: 'fail', count: failCount, cls: 'border-destructive/40 text-destructive bg-destructive/10', label: 'FAIL' },
    { key: 'warn', count: warnCount, cls: 'border-amber-500/40 text-amber-500 bg-amber-500/10', label: 'WARN' },
    { key: 'stub', count: stubCount, cls: 'border-border text-muted-foreground bg-muted/30', label: 'STUB' },
  ];

  return (
    <div className="flex gap-2 mb-6" data-testid="rollout-counts-bar">
      {pills.map((p) => (
        <span
          key={p.key}
          className={`inline-flex items-center rounded-md border px-3 py-1 text-xs font-medium ${p.cls}`}
          data-testid={`rollout-count-${p.key}`}
        >
          {p.count} {p.label}
        </span>
      ))}
    </div>
  );
}

function CheckRow({
  check,
  isAdmin,
  onMarkVerified,
}: {
  check: ReadinessCheck;
  isAdmin: boolean;
  onMarkVerified: (check: ReadinessCheck) => void;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [remedExpanded, setRemedExpanded] = useState(false);
  const isManual = MANUAL_VERIFICATION_ALLOWLIST.has(check.id);
  const isVerifiedPass =
    check.status === 'PASS' &&
    typeof check.detail === 'string' &&
    check.detail.startsWith(VERIFIED_DETAIL_PREFIX);
  const showMarkVerified =
    isAdmin && isManual && check.status === 'STUB';
  const showReVerify = isAdmin && isManual && isVerifiedPass;
  const remediation = CHECK_REMEDIATION[check.id];
  const showRemediation =
    !!remediation &&
    (check.status === 'FAIL' ||
      check.status === 'WARN' ||
      check.status === 'UNKNOWN');
  return (
    <li
      className="border-b border-border last:border-b-0 py-3 first:pt-0 last:pb-0"
      data-testid={`rollout-check-${check.id}`}
    >
      <div className="flex items-start gap-3">
        {statusIcon(check.status)}
        <div className="flex-1 min-w-0">
          <p className="text-foreground text-sm font-medium">{check.label}</p>
          {check.detail && (
            <p className="text-muted-foreground text-xs mt-0.5">{check.detail}</p>
          )}
          {check.evidence && (
            <div className="mt-1">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => setExpanded((v) => !v)}
                data-testid={`rollout-check-${check.id}-evidence-toggle`}
              >
                {expanded ? 'Hide evidence' : 'Show evidence'}
              </Button>
              {expanded && (
                <pre
                  className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs text-foreground"
                  data-testid={`rollout-check-${check.id}-evidence`}
                >
                  {check.evidence}
                </pre>
              )}
            </div>
          )}
          {showRemediation && remediation && (
            <div className="mt-2">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => setRemedExpanded((v) => !v)}
                data-testid={`rollout-check-${check.id}-remediation-toggle`}
                aria-expanded={remedExpanded}
              >
                {remedExpanded ? 'Hide how to fix' : 'How to fix'}
              </Button>
              {remedExpanded && (
                <div
                  className="mt-1 rounded bg-muted/50 p-3 text-xs"
                  data-testid={`rollout-check-${check.id}-remediation`}
                >
                  <p className="text-foreground whitespace-pre-wrap break-words">
                    {remediation.description}
                  </p>
                  {remediation.routePath && remediation.routeLabel && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => navigate(remediation.routePath!)}
                      data-testid={`rollout-check-${check.id}-remediation-nav`}
                    >
                      {remediation.routeLabel} →
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {(showMarkVerified || showReVerify) && (
            <div className="mt-2 flex items-center gap-2">
              {showMarkVerified && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => onMarkVerified(check)}
                  data-testid={`rollout-check-${check.id}-mark-verified`}
                >
                  Mark verified
                </Button>
              )}
              {showReVerify && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onMarkVerified(check)}
                    data-testid={`rollout-check-${check.id}-re-verify`}
                  >
                    Re-verify
                  </Button>
                  <span
                    className="text-muted-foreground text-xs"
                    title="Verifications are immutable; click Re-verify to refresh the expiry"
                    data-testid={`rollout-check-${check.id}-unverify-pending`}
                  >
                    Re-verify to refresh expiry
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ChecklistByCategory({
  checks,
  isAdmin,
  onMarkVerified,
}: {
  checks: ReadinessCheck[];
  isAdmin: boolean;
  onMarkVerified: (check: ReadinessCheck) => void;
}) {
  const grouped: Record<string, ReadinessCheck[]> = {};
  for (const c of checks) {
    if (!grouped[c.category]) grouped[c.category] = [];
    grouped[c.category].push(c);
  }

  return (
    <div className="flex flex-col gap-4 mb-6" data-testid="rollout-checklist">
      {CATEGORY_ORDER.map((cat) => {
        const items = grouped[cat.key] ?? [];
        if (items.length === 0) return null;
        return (
          <Card
            key={cat.key}
            className="p-5 gap-0"
            data-testid={`rollout-category-${cat.key}`}
          >
            <h3 className="text-foreground text-base font-semibold mb-3">
              {cat.label}
              <span className="text-muted-foreground text-xs font-normal ml-2">
                {items.length} {items.length === 1 ? 'check' : 'checks'}
              </span>
            </h3>
            <ul>
              {items.map((c) => (
                <CheckRow
                  key={c.id}
                  check={c}
                  isAdmin={isAdmin}
                  onMarkVerified={onMarkVerified}
                />
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

interface FlipControlsProps {
  currentMode: string;
  env: string;
  onFlip: (target: GovernanceTargetMode) => void;
}

function FlipControls({ currentMode, env, onFlip }: FlipControlsProps) {
  const isProd = env.startsWith('prod');

  if (currentMode === 'strict') {
    return (
      <div className="flex flex-col gap-3" data-testid="rollout-flip-controls">
        <div
          className="rounded-lg border border-chart-2/40 bg-chart-2/10 p-4 text-sm text-foreground"
          data-testid="rollout-strict-info"
        >
          Strict mode active. Rollback available.
        </div>
        <Button
          variant="outline"
          onClick={() => onFlip('permissive')}
          data-testid="rollout-rollback-permissive"
        >
          Roll back to permissive
        </Button>
      </div>
    );
  }

  if (currentMode === 'shadow') {
    return (
      <div className="flex gap-3" data-testid="rollout-flip-controls">
        <Button
          variant="default"
          onClick={() => onFlip('strict')}
          data-testid="rollout-flip-strict"
        >
          Flip to strict
        </Button>
        <Button
          variant="outline"
          onClick={() => onFlip('permissive')}
          data-testid="rollout-rollback-permissive"
        >
          Roll back to permissive
        </Button>
      </div>
    );
  }

  // Default: currentMode === 'permissive'.
  return (
    <div className="flex gap-3 flex-wrap" data-testid="rollout-flip-controls">
      <Button
        variant="default"
        onClick={() => onFlip('shadow')}
        data-testid="rollout-flip-shadow"
      >
        Flip to shadow
      </Button>
      {!isProd && (
        <Button
          variant="destructive"
          onClick={() => onFlip('strict')}
          data-testid="rollout-flip-strict-skip"
        >
          Flip to strict (skip shadow)
        </Button>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="rollout-loading">
      <div className="flex gap-2 mb-6">
        {STAGES.map((s) => (
          <Skeleton key={s} className="h-20 flex-1" />
        ))}
      </div>
      <div className="flex gap-2 mb-6">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
      </div>
      <Skeleton className="h-32 w-full mb-3" />
      <Skeleton className="h-32 w-full mb-3" />
      <Skeleton className="h-32 w-full mb-3" />
    </div>
  );
}

interface ErrorCardProps {
  message: string;
  onRetry: () => void;
}

function ErrorCard({ message, onRetry }: ErrorCardProps) {
  return (
    <div
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-5"
      data-testid="rollout-error"
    >
      <p className="text-destructive text-sm font-medium">
        Failed to load rollout readiness
      </p>
      <p className="text-muted-foreground text-xs mt-1">{message}</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={onRetry}
        data-testid="rollout-retry"
      >
        Retry
      </Button>
    </div>
  );
}

export function GovernanceRollout() {
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [report, setReport] = useState<RolloutReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] =
    useState<GovernanceTargetMode | null>(null);
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<ReadinessCheck | null>(
    null,
  );

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    governanceService
      .getRolloutReadiness()
      .then((r) => {
        if (!mounted) return;
        setReport(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load rollout readiness';
        setError(msg);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin, reloadKey]);

  const handleFlip = (target: GovernanceTargetMode) => {
    setDialogTarget(target);
    setDialogOpen(true);
  };

  const handleConfirmed = (result: SetGovernanceModeResult) => {
    if (result.noop) {
      toast.info(`Mode is already ${result.newMode}; no-op.`);
      return;
    }
    toast.success(
      `Mode flipped: ${result.previousMode} → ${result.newMode}. Header badge will refresh within 60s.`,
    );
    // Trigger a fresh getRolloutReadiness() to reflect the new mode in the
    // stepper without a full page reload.
    setReloadKey((k) => k + 1);
  };

  const handleMarkVerified = (check: ReadinessCheck) => {
    setVerifyTarget(check);
    setVerifyDialogOpen(true);
  };

  const handleVerifiedSuccess = (result: MarkReadinessCheckVerifiedResult) => {
    toast.success(
      `Check ${result.checkId} marked verified by ${result.verifiedBy} (expires ${result.expiresAt}).`,
    );
    setReloadKey((k) => k + 1);
  };

  if (!isAdmin) {
    return (
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="Rollout readiness" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Rollout readiness
          </h2>
          <p className="text-muted-foreground text-sm">
            Strict-flip readiness checklist per the governance rollout runbook
          </p>
        </div>
        <div
          className="rounded-lg border border-chart-2/40 bg-chart-2/20 p-6 text-sm text-foreground"
          data-testid="rollout-admin-only"
        >
          Admin only — rollout readiness requires admin access
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Rollout readiness" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Rollout readiness
        </h2>
        <p className="text-muted-foreground text-sm">
          Strict-flip readiness checklist per the governance rollout runbook
        </p>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        <ErrorCard
          message={error}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : report ? (
        <>
          <ModeStepper
            currentMode={report.currentMode}
            effectiveAt={report.effectiveAt}
            shadowSoakStartedAt={report.shadowSoakStartedAt}
          />
          <CountsBar
            passCount={report.passCount}
            failCount={report.failCount}
            warnCount={report.warnCount}
            stubCount={report.stubCount}
          />
          <ChecklistByCategory
            checks={report.checks}
            isAdmin={isAdmin}
            onMarkVerified={handleMarkVerified}
          />
          <FlipControls
            currentMode={report.currentMode}
            env={report.env}
            onFlip={handleFlip}
          />
          {dialogTarget && (
            <ModeFlipDialog
              open={dialogOpen}
              onOpenChange={(o) => {
                setDialogOpen(o);
                if (!o) setDialogTarget(null);
              }}
              currentMode={report.currentMode}
              targetMode={dialogTarget}
              readinessSummary={{
                passCount: report.passCount,
                failCount: report.failCount,
                warnCount: report.warnCount,
                stubCount: report.stubCount,
              }}
              onConfirmed={handleConfirmed}
            />
          )}
          {verifyTarget && (
            <MarkVerifiedDialog
              open={verifyDialogOpen}
              onOpenChange={(o) => {
                setVerifyDialogOpen(o);
                if (!o) setVerifyTarget(null);
              }}
              checkId={verifyTarget.id}
              checkLabel={verifyTarget.label}
              onVerified={handleVerifiedSuccess}
            />
          )}
        </>
      ) : null}
    </PageContainer>
  );
}

export default GovernanceRollout;
