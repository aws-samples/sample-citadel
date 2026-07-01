import { useState } from 'react';
import {
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Lock,
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { agentImportService } from '../services/agentImportService';
import type { AgentImportRecord, ProposedManifest } from '../types/agentImport';

interface Tier3ProposalPanelProps {
  /** The DRAFT import record id (importId) — used for accept + refresh. */
  agentId: string;
  /** Candidate reference for the proposal request (proposeAgentManifestTier3). */
  reference: string;
  /**
   * The proposed manifest already parked on the record (if any). Absent ⇒ the
   * panel offers the propose action; present ⇒ it renders the review/failed/
   * accepted state. The panel NEVER fetches on mount.
   */
  proposedManifest?: ProposedManifest | null;
  /** Optional cross-account discovery role threaded into the proposal request. */
  discoveryRoleArn?: string;
  discoveryExternalId?: string;
  /** Notified after a successful accept with the updated record. */
  onAccepted?: (record: AgentImportRecord) => void;
}

type Phase = 'idle' | 'proposing' | 'pending' | 'accepting' | 'accepted';

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

/**
 * Operator UI for the Tier-3 (AI-assisted) agent-import manifest proposal.
 *
 * The proposed manifest is AI-GENERATED, LOW-CONFIDENCE and REQUIRES HUMAN
 * REVIEW. Accepting it only fills in the manifest — the agent STAYS a DRAFT and
 * is NOT activated (governance + activation remain separate, explicit steps).
 * Accept is never automatic.
 */
export function Tier3ProposalPanel({
  agentId,
  reference,
  proposedManifest = null,
  discoveryRoleArn,
  discoveryExternalId,
  onAccepted,
}: Tier3ProposalPanelProps) {
  const [proposal, setProposal] = useState<ProposedManifest | null>(proposedManifest);
  const [phase, setPhase] = useState<Phase>(
    proposedManifest?.reviewState === 'accepted' ? 'accepted' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const reviewState = proposal?.reviewState;

  // Resolve the view from the (proposal × phase) state. `accepted` and the
  // terminal review states win over the transient propose/pending phases.
  const view: 'accepted' | 'review' | 'failed' | 'pending' | 'propose' =
    phase === 'accepted' || reviewState === 'accepted'
      ? 'accepted'
      : reviewState === 'pending_review'
        ? 'review'
        : reviewState === 'failed'
          ? 'failed'
          : phase === 'pending'
            ? 'pending'
            : 'propose';

  const proposing = phase === 'proposing';
  const accepting = phase === 'accepting';

  const handlePropose = async (): Promise<void> => {
    setPhase('proposing');
    setError(null);
    try {
      const opts: { discoveryRoleArn?: string; discoveryExternalId?: string } = {};
      if (discoveryRoleArn) opts.discoveryRoleArn = discoveryRoleArn;
      if (discoveryExternalId) opts.discoveryExternalId = discoveryExternalId;
      await agentImportService.proposeAgentManifestTier3(
        reference,
        Object.keys(opts).length > 0 ? opts : undefined,
      );
      setProposal(null);
      setPhase('pending');
    } catch (err) {
      setError(errorMessage(err, 'Failed to request a manifest proposal'));
      setPhase('idle');
    }
  };

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const record = await agentImportService.getImportRecord(agentId);
      const pm = record?.proposedManifest ?? null;
      setProposal(pm);
      if (pm?.reviewState === 'accepted') {
        setPhase('accepted');
      } else if (pm) {
        // a landed pending_review / failed proposal is rendered by `view`
        setPhase('idle');
      }
      // still nothing parked ⇒ stay in the pending phase
    } catch (err) {
      setError(errorMessage(err, 'Failed to refresh the proposal'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleAccept = async (): Promise<void> => {
    setPhase('accepting');
    setError(null);
    try {
      const record = await agentImportService.acceptProposedManifestTier3(agentId);
      setProposal(record.proposedManifest ?? null);
      setPhase('accepted');
      onAccepted?.(record);
    } catch (err) {
      setError(errorMessage(err, 'Failed to accept the proposed manifest'));
      // fall back to the review state so the operator can retry
      setPhase('idle');
    }
  };

  const proposeButton = (label: string) => (
    <Button
      type="button"
      onClick={handlePropose}
      disabled={proposing}
      className="self-start bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
    >
      {proposing ? <Loader2 className="size-4 mr-2 animate-spin" /> : (
        <Sparkles className="size-4 mr-2" />
      )}
      {proposing ? 'Proposing…' : label}
    </Button>
  );

  const errorAlert = error ? (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertTriangle className="size-4 mt-0.5 shrink-0" />
      <span>{error}</span>
    </div>
  ) : null;

  const manifestBody = proposal?.manifest
    ? JSON.stringify(proposal.manifest, null, 2)
    : '';

  return (
    <section
      aria-label="Tier-3 AI-assisted manifest proposal"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">
          AI-assisted manifest proposal (Tier-3)
        </h3>
      </div>

      {view === 'propose' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            This agent&apos;s capability looks thin. You can ask an AI assistant to
            propose a manifest. The proposal is low-confidence and requires your review
            before any of it is applied.
          </p>
          {errorAlert}
          {proposeButton('Propose manifest (Tier-3, AI-assisted)')}
        </div>
      )}

      {view === 'pending' && (
        <div className="flex flex-col gap-3">
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-chart-3/40 bg-chart-3/5 p-3 text-sm text-foreground"
          >
            <Loader2 className="size-4 animate-spin text-chart-3" />
            <span>Proposing… the AI-proposed manifest will appear here once ready.</span>
          </div>
          {errorAlert}
          <Button
            type="button"
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing}
            className="self-start cursor-pointer"
          >
            <RefreshCw
              className={`size-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>
      )}

      {view === 'review' && proposal && (
        <div className="flex flex-col gap-3">
          {/* AI-proposed / review-required / low-confidence framing (text + icon,
              never colour alone) */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border border-chart-3/40 bg-chart-3/15 text-chart-3">
              <Sparkles className="size-3 mr-1" />
              <span>AI-proposed — review required</span>
            </Badge>
            <Badge className="border border-destructive/40 bg-destructive/10 text-destructive">
              <AlertTriangle className="size-3 mr-1" />
              <span>
                {proposal.confidence === 'low'
                  ? 'Low confidence'
                  : `${proposal.confidence ?? 'Unknown'} confidence`}
              </span>
            </Badge>
            <Badge variant="secondary">
              <Lock className="size-3 mr-1" />
              <span>Read-only</span>
            </Badge>
          </div>

          <p className="text-sm text-muted-foreground">
            This manifest was generated by AI and has not been reviewed. It is shown
            read-only — review it carefully before accepting.
          </p>

          <pre
            aria-label="AI-proposed agent manifest (read-only)"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-3 text-xs text-muted-foreground"
          >
            {manifestBody || 'No manifest body was returned.'}
          </pre>

          <p className="text-sm text-foreground">
            Accepting fills in the agent&apos;s manifest. The agent stays a DRAFT and is
            not activated — it must still be governed and activated separately.
          </p>

          {errorAlert}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleAccept}
              disabled={accepting}
              className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
            >
              {accepting ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4 mr-2" />
              )}
              {accepting ? 'Accepting…' : 'Accept proposed manifest'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshing}
              className="cursor-pointer"
            >
              <RefreshCw
                className={`size-4 mr-2 ${refreshing ? 'animate-spin' : ''}`}
              />
              Refresh
            </Button>
          </div>
        </div>
      )}

      {view === 'failed' && (
        <div className="flex flex-col gap-3">
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-1">
              <span className="font-medium">Manifest proposal failed</span>
              {proposal?.error && <span>{proposal.error}</span>}
              <span className="text-muted-foreground">
                You can try proposing a manifest again.
              </span>
            </div>
          </div>
          {errorAlert}
          {proposeButton('Propose manifest (Tier-3, AI-assisted)')}
        </div>
      )}

      {view === 'accepted' && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-chart-2/40 bg-chart-2/5 p-3 text-sm"
        >
          <CheckCircle2 className="size-4 mt-0.5 shrink-0 text-chart-2" />
          <div className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Proposed manifest accepted</span>
            <span className="text-muted-foreground">
              The agent&apos;s manifest has been populated from the AI proposal. The agent
              is still a DRAFT and has not been activated — it must still be governed and
              activated separately.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
