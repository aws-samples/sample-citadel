/**
 * FabricationStatusCard — in-chat fabrication progress card.
 *
 * Rendered inside the chat stream after the last message while the project
 * has fabrication jobs. Per-agent status, 'All N agents built', and a
 * truthful Activate button reporting honest counts for activated /
 * submitted / failed.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle,
  Clock,
  Loader2,
  Rocket,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { agentConfigService, type ActivateAgentsResult } from '../services/agentConfigService';
import type { FabricationQueueItem } from '../services/fabricatorQueueService';

type FabricationStatus = FabricationQueueItem['status'];

const STATUS_ICON: Record<FabricationStatus, { Icon: typeof Clock; spin?: boolean; className: string }> = {
  PENDING: { Icon: Clock, className: 'text-muted-foreground' },
  PROCESSING: { Icon: Loader2, spin: true, className: 'text-primary' },
  COMPLETED: { Icon: CheckCircle, className: 'text-chart-2' },
  FAILED: { Icon: XCircle, className: 'text-destructive' },
};

const STATUS_LABEL: Record<FabricationStatus, string> = {
  PENDING: 'Queued',
  PROCESSING: 'Building',
  COMPLETED: 'Built',
  FAILED: 'Failed',
};

type ActivationState =
  | { kind: 'idle' }
  | { kind: 'activating' }
  | { kind: 'result'; result: ActivateAgentsResult }
  | { kind: 'error'; message: string }
  | { kind: 'all-active' };

export interface FabricationStatusCardProps {
  items: FabricationQueueItem[];
  projectId: string;
  allBuilt: boolean;
  allTerminal: boolean;
}

export function FabricationStatusCard({ items, projectId, allBuilt }: FabricationStatusCardProps) {
  const [activation, setActivation] = useState<ActivationState>({ kind: 'idle' });

  if (items.length === 0) return null;

  const builtCount = items.filter((i) => i.status === 'COMPLETED').length;

  const handleActivate = async () => {
    setActivation({ kind: 'activating' });
    try {
      const result = await agentConfigService.activateProjectAgents(projectId);

      // All activated or alreadyActive
      const allActive =
        result.activated.length + result.alreadyActive.length === items.length &&
        result.failed.length === 0 &&
        (!result.submitted || result.submitted.length === 0);

      if (allActive) {
        setActivation({ kind: 'all-active' });
      } else if (
        result.activated.length === 0 &&
        result.failed.length === 0 &&
        result.alreadyActive.length === 0 &&
        (!result.submitted || result.submitted.length === 0)
      ) {
        // All-empty response — the backend returned nothing useful.
        setActivation({ kind: 'error', message: 'No agents found for this project yet' });
      } else {
        setActivation({ kind: 'result', result });
      }
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('No agents found') || msg.includes('ValidationError')) {
        setActivation({ kind: 'error', message: 'No agents found for this project yet' });
      } else {
        setActivation({ kind: 'error', message: msg || 'Activation failed' });
      }
    }
  };

  const hasSubmitted =
    activation.kind === 'result' &&
    activation.result.submitted &&
    activation.result.submitted.length > 0;

  const buttonLabel = (() => {
    if (activation.kind === 'activating') return 'Activating…';
    if (activation.kind === 'all-active') return 'Agents active';
    if (hasSubmitted) return 'Activate approved agents';
    return 'Activate agents';
  })();

  return (
    <Card className="bg-accent border border-border rounded-lg px-3 py-2 text-sm gap-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Agent Fabrication
        </span>
        <span className="text-xs text-muted-foreground">
          {allBuilt
            ? `All ${items.length} agents built`
            : `${builtCount} of ${items.length} built`}
        </span>
      </div>

      {/* Per-agent rows */}
      <ul role="list" className="flex flex-col gap-1">
        {items.map((item) => {
          const { Icon, spin, className } = STATUS_ICON[item.status] ?? STATUS_ICON.PENDING;
          return (
            <li key={item.requestId} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-foreground">{item.agentName}</span>
              <Badge variant="secondary" className="gap-1">
                <Icon className={`size-3 ${spin ? 'animate-spin' : ''} ${className}`} aria-hidden="true" />
                <span>{STATUS_LABEL[item.status] ?? 'Unknown'}</span>
              </Badge>
            </li>
          );
        })}
      </ul>

      {/* Activate button */}
      {allBuilt && (
        <div className="mt-2">
          <Button
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={handleActivate}
            disabled={activation.kind === 'activating' || activation.kind === 'all-active'}
            aria-label={buttonLabel}
          >
            {activation.kind === 'activating' ? (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <Rocket className="size-3" aria-hidden="true" />
            )}
            {buttonLabel}
          </Button>
        </div>
      )}

      {/* Activation result */}
      {activation.kind === 'result' && (
        <div className="mt-1.5 text-xs space-y-0.5">
          {activation.result.activated.length > 0 && (
            <p className="text-chart-2">{activation.result.activated.length} activated</p>
          )}
          {activation.result.submitted && activation.result.submitted.length > 0 && (
            <p className="text-primary">
              Submitted {activation.result.submitted.length} for approval —{' '}
              <Link to="/approvals" className="underline">
                Approvals page
              </Link>
            </p>
          )}
          {activation.result.failed.length > 0 && (
            <p className="text-destructive flex items-center gap-1">
              <AlertTriangle className="size-3" aria-hidden="true" />
              {activation.result.failed.length} failed
            </p>
          )}
        </div>
      )}

      {/* Error state */}
      {activation.kind === 'error' && (
        <p className="mt-1.5 text-xs text-destructive flex items-center gap-1">
          <XCircle className="size-3" aria-hidden="true" />
          {activation.message}
        </p>
      )}
    </Card>
  );
}
