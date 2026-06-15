/**
 * Governance case-law timeline
 *
 * Read-only admin page that surfaces the case-law DDB table (encoded
 * resolutions of prior human-adjudicated escalations). Each entry is
 * rendered as a card stacked top-to-bottom by precedence (highest
 * first) — at evaluation time the engine consults case law in
 * precedence order before falling back to the composition / authority
 * unit pipeline (see arbiter/governance/engine.py).
 *
 * Layout:
 *   1. Header + subtitle
 *   2. Filter bar (include-revoked switch + resolution select + refresh)
 *   3. Stats line (count + highest precedence + most recent encodedAt)
 *   4. Vertical timeline of cards
 *   5. Resolution legend (footer)
 *   6. Empty state when no entries
 *
 * will enable the inline `Revoke` and `Edit precedence`
 * affordances on each card. They render disabled here with tooltips
 * explaining the deferral.
 *
 * The resolution palette mirrors the project-wide decision palette
 * already used by Ledger / Mismatches / Tracer pages: chart-2 for
 * PERMIT (success), destructive for DENY, amber-500 for ESCALATE,
 * pink-500 for HALT. Unknown resolutions degrade to a muted badge.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { Badge } from '../../components/ui/badge';
import { Switch } from '../../components/ui/switch';
import { Card } from '../../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  CaseLawActionDialog,
  CaseLawActionMode,
} from '../../components/CaseLawActionDialog';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  CaseLawEntry,
  CaseLawMutationResult,
} from '../../services/governanceService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INCLUDE_REVOKED_STORAGE_KEY = 'governance.caselaw.includeRevoked';

const RESOLUTION_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'permit', label: 'Permit' },
  { value: 'deny', label: 'Deny' },
  { value: 'escalate', label: 'Escalate' },
  { value: 'halt', label: 'Halt' },
] as const;

// Tailwind tokens for resolution badges. Source of truth is the
// project-wide decision palette already used by Ledger / Mismatches /
// Tracer pages. NO inline colour literals — these all reference the
// theme tokens registered in tailwind.config.
const RESOLUTION_BADGE_CLASS: Record<string, string> = {
  permit: 'bg-chart-2/10 text-chart-2 border-chart-2/40',
  deny: 'bg-destructive/10 text-destructive border-destructive/40',
  escalate: 'bg-amber-500/10 text-amber-500 border-amber-500/40',
  halt: 'bg-pink-500/10 text-pink-500 border-pink-500/40',
};

const RESOLUTION_LEGEND: Array<{ resolution: string; description: string }> = [
  {
    resolution: 'permit',
    description:
      'Engine permits the request — case law overrides the composition pipeline.',
  },
  {
    resolution: 'deny',
    description:
      'Engine denies the request with the encoded reason; no further evaluation.',
  },
  {
    resolution: 'escalate',
    description:
      'Engine routes the request to the configured escalation target for human review.',
  },
  {
    resolution: 'halt',
    description:
      'Engine halts execution immediately — used for irrecoverable conflicts.',
  },
];

// First N characters of the JSON value rendered when a collapsible
// pretty-printer block is in its closed state. Tuned to fit on a
// single line within the card layout without truncating mid-token in
// most realistic patterns.
const COLLAPSED_JSON_PREVIEW_LENGTH = 80;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolutionBadgeClass(resolution: string): string {
  return (
    RESOLUTION_BADGE_CLASS[resolution] ??
    'bg-muted text-muted-foreground border-muted-foreground/30'
  );
}

/**
 * Lazy JSON pretty-printer. Implemented as a top-level helper rather
 * than imported because the constraint forbids new npm dependencies
 * and the formatting need is minimal — just JSON.stringify with
 * 2-space indentation, defensively handling already-stringified-twice
 * payloads (rare, but writer drift is real).
 */
function prettyPrintJson(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    // Not valid JSON — return the raw string so the operator can see
    // the writer drift rather than a blank block.
    return raw;
  }
}

function previewJson(raw: string): string {
  if (!raw) return '';
  if (raw.length <= COLLAPSED_JSON_PREVIEW_LENGTH) return raw;
  return `${raw.slice(0, COLLAPSED_JSON_PREVIEW_LENGTH)}…`;
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const absSec = Math.abs(diffMs) / 1000;
  if (absSec < 60) return diffMs >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(absSec / 60);
  if (minutes < 60) return diffMs >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `${days}d ago` : `in ${days}d`;
}

function readIncludeRevokedFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const v = window.localStorage.getItem(INCLUDE_REVOKED_STORAGE_KEY);
    return v === 'true';
  } catch {
    return false;
  }
}

function writeIncludeRevokedToStorage(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      INCLUDE_REVOKED_STORAGE_KEY,
      value ? 'true' : 'false',
    );
  } catch {
    // localStorage quota / disabled — silently ignore so the toggle
    // still works in-memory.
  }
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CaseLawCardProps {
  entry: CaseLawEntry;
  onAction: (mode: CaseLawActionMode, entry: CaseLawEntry) => void;
}

function CaseLawCard({ entry, onAction }: CaseLawCardProps) {
  const resolution = entry.resolution;
  const knownResolution =
    resolution === 'permit' ||
    resolution === 'deny' ||
    resolution === 'escalate' ||
    resolution === 'halt';

  return (
    <article
      className={`border ${
        entry.revoked ? 'border-destructive/40' : 'border-border'
      } rounded-lg p-4 flex gap-4 mb-3`}
      data-testid={`case-law-card-${entry.caseId}`}
      data-case-id={entry.caseId}
      data-resolution={resolution}
      data-revoked={entry.revoked ? 'true' : 'false'}
    >
      {/* Left rail: precedence number */}
      <div
        className="flex flex-col items-center justify-center min-w-[72px] border-r border-border pr-3"
        data-testid={`case-law-precedence-rail-${entry.caseId}`}
      >
        <span
          className="text-foreground text-3xl font-bold font-mono"
          data-testid={`case-law-precedence-${entry.caseId}`}
        >
          {entry.precedence}
        </span>
        <Badge
          variant="outline"
          className="font-mono text-[10px] mt-1"
          data-testid={`case-law-precedence-badge-${entry.caseId}`}
        >
          precedence
        </Badge>
      </div>

      {/* Main column */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <code
            className="font-mono text-sm text-foreground bg-muted/40 rounded px-1 py-0.5 break-all"
            data-testid={`case-law-id-${entry.caseId}`}
          >
            {entry.caseId}
          </code>
          <Badge
            variant="outline"
            className={`font-mono text-xs uppercase ${resolutionBadgeClass(resolution)}`}
            data-testid={`case-law-resolution-${entry.caseId}`}
            data-known-resolution={knownResolution ? 'true' : 'false'}
          >
            {resolution}
          </Badge>
          {entry.revoked && (
            <Badge
              variant="destructive"
              className="font-mono text-xs"
              data-testid={`case-law-revoked-${entry.caseId}`}
            >
              revoked
            </Badge>
          )}
        </div>

        {/* Subline */}
        <p
          className="text-muted-foreground text-xs mb-3"
          data-testid={`case-law-subline-${entry.caseId}`}
          title={entry.encodedAt}
        >
          {`Encoded by `}
          <span className="text-foreground font-mono">{entry.encodedBy}</span>
          {` at `}
          <span
            className="text-foreground font-mono"
            data-testid={`case-law-encoded-at-${entry.caseId}`}
          >
            {entry.encodedAt}
          </span>
          {entry.encodedAt && (
            <span className="text-muted-foreground">
              {` (${formatRelative(entry.encodedAt)})`}
            </span>
          )}
        </p>

        {/* Pattern preview (collapsible) */}
        <details
          className="mb-2 border border-border rounded p-2"
          data-testid={`case-law-pattern-details-${entry.caseId}`}
        >
          <summary
            className="text-foreground text-xs font-semibold cursor-pointer flex items-center gap-2"
            data-testid={`case-law-pattern-summary-${entry.caseId}`}
          >
            <span>Pattern</span>
            <code
              className="font-mono text-muted-foreground text-[11px] truncate"
              data-testid={`case-law-pattern-preview-${entry.caseId}`}
            >
              {previewJson(entry.pattern)}
            </code>
          </summary>
          <pre
            className="font-mono text-[11px] text-foreground bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre mt-2"
            data-testid={`case-law-pattern-pretty-${entry.caseId}`}
          >
            {prettyPrintJson(entry.pattern)}
          </pre>
        </details>

        {/* Scope-of-applicability preview (collapsible) */}
        <details
          className="mb-2 border border-border rounded p-2"
          data-testid={`case-law-scope-details-${entry.caseId}`}
        >
          <summary
            className="text-foreground text-xs font-semibold cursor-pointer flex items-center gap-2"
            data-testid={`case-law-scope-summary-${entry.caseId}`}
          >
            <span>Scope of applicability</span>
            <code
              className="font-mono text-muted-foreground text-[11px] truncate"
              data-testid={`case-law-scope-preview-${entry.caseId}`}
            >
              {previewJson(entry.scopeOfApplicability)}
            </code>
          </summary>
          <pre
            className="font-mono text-[11px] text-foreground bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre mt-2"
            data-testid={`case-law-scope-pretty-${entry.caseId}`}
          >
            {prettyPrintJson(entry.scopeOfApplicability)}
          </pre>
        </details>
      </div>

      {/* Action column (right-aligned) */}
      <div
        className="flex flex-col gap-2 self-start"
        data-testid={`case-law-actions-${entry.caseId}`}
      >
        {entry.revoked ? (
          <Button
            size="sm"
            variant="outline"
            data-testid={`case-law-restore-${entry.caseId}`}
            onClick={() => onAction('unrevoke', entry)}
          >
            Restore
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            data-testid={`case-law-revoke-${entry.caseId}`}
            onClick={() => onAction('revoke', entry)}
          >
            Revoke
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-testid={`case-law-edit-precedence-${entry.caseId}`}
          onClick={() => onAction('update-precedence', entry)}
        >
          Edit precedence
        </Button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Resolution legend (footer)
// ---------------------------------------------------------------------------

function ResolutionLegend() {
  return (
    <Card className="rounded-md p-3 mt-4 gap-0">
      <details data-testid="resolution-legend">
        <summary
          className="text-foreground text-sm font-semibold cursor-pointer"
          data-testid="resolution-legend-summary"
        >
          Resolution legend
        </summary>
        <table className="mt-2 w-full text-xs">
          <tbody>
            {RESOLUTION_LEGEND.map((entry) => (
              <tr
                key={entry.resolution}
                className="border-b border-border/30 last:border-b-0"
              >
                <td className="py-1 pr-4 align-top">
                  <Badge
                    variant="outline"
                    className={`font-mono text-xs uppercase ${resolutionBadgeClass(entry.resolution)}`}
                    data-testid={`resolution-legend-badge-${entry.resolution}`}
                  >
                    {entry.resolution}
                  </Badge>
                </td>
                <td
                  className="py-1 text-muted-foreground"
                  data-testid={`resolution-legend-description-${entry.resolution}`}
                >
                  {entry.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GovernanceCaseLaw() {
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [entries, setEntries] = useState<CaseLawEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeRevoked, setIncludeRevoked] = useState<boolean>(() =>
    readIncludeRevokedFromStorage(),
  );
  const [resolutionFilter, setResolutionFilter] = useState<string>('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionState, setActionState] = useState<{
    mode: CaseLawActionMode;
    entry: CaseLawEntry;
  } | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    governanceService
      .listCaseLaw({ includeRevoked })
      .then((data) => {
        if (!mounted) return;
        setEntries(data);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load case law';
        setError(msg);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isAdmin, includeRevoked, refreshKey]);

  // Memoise the precedence-sorted list. The resolver already returns
  // entries in precedence-DESC order, so the client-side memo is just
  // a stability guarantee — it avoids re-allocating the resolution
  // filter result on every render and keeps reference equality stable
  // across renders that don't change the inputs.
  const visibleEntries = useMemo(() => {
    if (resolutionFilter === 'all') return entries;
    return entries.filter((e) => e.resolution === resolutionFilter);
  }, [entries, resolutionFilter]);

  const stats = useMemo(() => {
    if (visibleEntries.length === 0) {
      return { count: 0, highestPrecedence: null as number | null, mostRecent: null as string | null };
    }
    let highest = visibleEntries[0].precedence;
    let mostRecent = visibleEntries[0].encodedAt;
    for (const e of visibleEntries) {
      if (e.precedence > highest) highest = e.precedence;
      if (e.encodedAt > mostRecent) mostRecent = e.encodedAt;
    }
    return {
      count: visibleEntries.length,
      highestPrecedence: highest,
      mostRecent,
    };
  }, [visibleEntries]);

  const handleIncludeRevokedChange = (value: boolean) => {
    setIncludeRevoked(value);
    writeIncludeRevokedToStorage(value);
  };

  if (!isAdmin) {
    return (
      <PageContainer
        className="flex-1 flex flex-col bg-background"
        data-testid="governance-case-law"
      >
        <GovernanceBreadcrumbs title="Case law" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Case law
          </h2>
        </div>
        <p
          className="text-muted-foreground text-sm"
          data-testid="case-law-admin-only"
        >
          Admin-only.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      className="flex-1 flex flex-col bg-background"
      data-testid="governance-case-law"
    >
      <GovernanceBreadcrumbs title="Case law" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Case law
        </h2>
        <p className="text-muted-foreground text-sm">
          Encoded resolutions of prior human-adjudicated escalations.
          Sorted by precedence; the top entry wins ties at evaluation
          time.
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap" data-testid="filter-bar">
        <label
          className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer"
          data-testid="include-revoked-label"
        >
          <Switch
            checked={includeRevoked}
            onCheckedChange={handleIncludeRevokedChange}
            data-testid="include-revoked-switch"
          />
          <span>Include revoked</span>
        </label>
        <label className="text-xs text-muted-foreground ml-3">Resolution</label>
        <Select value={resolutionFilter} onValueChange={setResolutionFilter}>
          <SelectTrigger
            className="w-32"
            data-testid="resolution-filter-trigger"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOLUTION_FILTER_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                data-testid={`resolution-filter-option-${opt.value}`}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRefreshKey((k) => k + 1)}
          data-testid="case-law-refresh"
        >
          Refresh
        </Button>
      </div>

      {/* Stats line */}
      <p
        className="text-muted-foreground text-xs mb-3"
        data-testid="case-law-stats"
      >
        {stats.count > 0
          ? `${stats.count} case-law entries • highest precedence: ${stats.highestPrecedence} • most recent: ${stats.mostRecent ?? 'unknown'}`
          : `0 case-law entries`}
      </p>

      {/* Body */}
      {loading ? (
        <Skeleton className="h-40 w-full" data-testid="case-law-skeleton" />
      ) : error ? (
        <p className="text-destructive text-sm" data-testid="case-law-error">
          {error}
        </p>
      ) : visibleEntries.length === 0 ? (
        <Card
          className="rounded-md p-6 text-sm text-muted-foreground gap-0"
          data-testid="case-law-empty"
        >
          <p className="mb-2">
            No case-law entries. The first entry comes from real
            adjudication — see the{' '}
            <code className="font-mono text-foreground">
              case_law_admin
            </code>{' '}
            CLI for encoding.
          </p>
          <p className="text-xs">
            See the{' '}
            <span className="text-foreground font-mono">
              docs/GOVERNANCE_ROLLOUT_RUNBOOK.md
            </span>{' '}
            runbook and{' '}
            <span className="text-foreground font-mono">
              arbiter/governance/case_law_admin.py
            </span>
            .
          </p>
        </Card>
      ) : (
        <div data-testid="case-law-timeline">
          {visibleEntries.map((entry) => (
            <CaseLawCard
              key={entry.caseId}
              entry={entry}
              onAction={(mode, target) =>
                setActionState({ mode, entry: target })
              }
            />
          ))}
        </div>
      )}

      {/* Resolution legend (footer) */}
      <ResolutionLegend />

      {actionState && (
        <CaseLawActionDialog
          open={actionState !== null}
          onOpenChange={(open) => {
            if (!open) setActionState(null);
          }}
          mode={actionState.mode}
          entry={actionState.entry}
          onCommitted={(result: CaseLawMutationResult) => {
            toast.success(`Case-law ${result.action} on ${result.caseId}`);
            // Re-fetch the timeline so the page reflects the new
            // revoked / precedence state and ordering.
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </PageContainer>
  );
}

export default GovernanceCaseLaw;
