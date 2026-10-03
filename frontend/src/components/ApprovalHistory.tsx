import React from 'react';
import { Badge } from './ui/badge';
import { registryStatusLabel } from './registry-status-label';
import type { AgentConfig } from '../services/agentConfigService';

/** Badge variant for each registry status. */
const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'secondary' | 'info'> = {
  APPROVED: 'success',
  REJECTED: 'destructive',
  PENDING_APPROVAL: 'warning',
  DRAFT: 'secondary',
  DEPRECATED: 'info',
};

/**
 * Renders a human-readable relative-time string for an ISO date.
 * Falls back to the raw ISO string when the date cannot be parsed.
 */
function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const diffMs = Date.now() - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface ApprovalHistoryProps {
  agent: AgentConfig;
}

/**
 * Displays the registry approval history for an agent: status badge,
 * decided-by, decided-at, and status-reason fields when present.
 * Renders nothing for legacy agents that have no registryStatus.
 */
export const ApprovalHistory: React.FC<ApprovalHistoryProps> = ({ agent }) => {
  const label = registryStatusLabel(agent.registryStatus);
  if (!label) return null;

  const variant = STATUS_VARIANT[agent.registryStatus!] ?? 'secondary';

  return (
    <div data-testid="approval-history" className="flex flex-col gap-2 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Registry status</span>
        <Badge variant={variant}>{label}</Badge>
      </div>

      {agent.registryStatus === 'PENDING_APPROVAL' && (
        <p className="text-sm text-muted-foreground">Awaiting administrator review</p>
      )}

      {agent.registryStatus === 'REJECTED' && (
        <p className="text-sm text-destructive">
          Rejected records cannot be resubmitted; create a new record
        </p>
      )}

      {agent.decidedBy && (
        <p className="text-sm text-muted-foreground">
          Decided by: <span data-testid="decided-by">{agent.decidedBy}</span>
        </p>
      )}

      {agent.decidedAt && (
        <p className="text-sm text-muted-foreground">
          Decided at:{' '}
          <time dateTime={agent.decidedAt} title={agent.decidedAt} data-testid="decided-at">
            {relativeTime(agent.decidedAt)}
          </time>
        </p>
      )}

      {agent.statusReason && (
        <p className="text-sm text-muted-foreground">
          Reason: <span data-testid="status-reason">{agent.statusReason}</span>
        </p>
      )}
    </div>
  );
};
