import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ChevronDown,
  Clock,
  Loader2,
  CheckCircle,
  XCircle,
  PackageOpen,
  RefreshCw,
  Rocket,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
import {
  getFabricatorQueue,
  subscribeToFabricationEvents,
  type FabricationQueueItem,
} from '../services/fabricatorQueueService';
import { agentConfigService } from '../services/agentConfigService';

interface FabricationStatusPanelProps {
  /** Project/orchestration id. Jobs are filtered to this project. */
  projectId: string;
  /**
   * Whether the build/implementation phase is active or complete. When true the
   * panel renders even with zero jobs (showing an empty state); when false the
   * panel only appears once at least one job exists.
   */
  phaseActive?: boolean;
}

type FabricationStatus = FabricationQueueItem['status'];

interface StatusMeta {
  /** Human-readable label — rendered as text so status is never color-only. */
  label: string;
  variant: 'secondary' | 'info' | 'success' | 'destructive';
  Icon: typeof Clock;
  spin?: boolean;
}

const STATUS_META: Record<FabricationStatus, StatusMeta> = {
  PENDING: { label: 'Queued', variant: 'secondary', Icon: Clock },
  PROCESSING: { label: 'Building', variant: 'info', Icon: Loader2, spin: true },
  COMPLETED: { label: 'Built', variant: 'success', Icon: CheckCircle },
  FAILED: { label: 'Failed', variant: 'destructive', Icon: XCircle },
};

function StatusBadge({ status, errorMessage }: { status: FabricationStatus; errorMessage?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.PENDING;
  const { label, variant, Icon, spin } = meta;

  const badge = (
    <Badge variant={variant} className="gap-1">
      <Icon className={`size-3 ${spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span>{label}</span>
    </Badge>
  );

  if (status === 'FAILED' && errorMessage) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* tabIndex so keyboard users can reveal the error tooltip */}
            <span tabIndex={0} className="cursor-help">{badge}</span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="text-xs">{errorMessage}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return badge;
}

export function FabricationStatusPanel({ projectId, phaseActive = false }: FabricationStatusPanelProps) {
  const [items, setItems] = useState<FabricationQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);
  // Collapsible body: open by default; auto-collapses once fabrication
  // completes, unless the user has ever toggled manually — their choice
  // wins forever after the first manual toggle.
  const [open, setOpen] = useState(true);
  const userToggledRef = useRef(false);
  const subscriptionRef = useRef<(() => void) | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const queue = await getFabricatorQueue(projectId);
      setItems(queue);
    } catch (err) {
      console.error('Failed to load fabrication queue:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Initial load (and reload when the project changes)
  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Subscribe to real-time fabrication events; update the matching row in place.
  useEffect(() => {
    const unsubscribe = subscribeToFabricationEvents((event) => {
      setItems((prev) =>
        prev.map((item) =>
          item.requestId === event.requestId
            ? { ...item, status: event.type, errorMessage: event.errorMessage ?? item.errorMessage }
            : item,
        ),
      );
    });
    subscriptionRef.current = unsubscribe;
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current();
        subscriptionRef.current = null;
      }
    };
  }, []);

  // Every fabrication job for this project has finished building. Only then
  // does bulk activation make sense.
  const allBuilt = items.length > 0 && items.every((i) => i.status === 'COMPLETED');
  const builtCount = items.filter((i) => i.status === 'COMPLETED').length;

  // Completion signal for auto-collapse. Verified: FabricationQueueItem
  // carries NO activation state, and the local `activated` flag reflects
  // only THIS panel's button — agents are usually activated conversationally
  // (intake flow), so gating on it would strand the panel expanded forever.
  // allBuilt is therefore the strongest authoritative completion signal
  // available to the panel.
  const complete = allBuilt;

  useEffect(() => {
    if (complete && !userToggledRef.current) {
      setOpen(false);
    }
  }, [complete]);

  // Any trigger interaction (click / Enter / Space) is a manual toggle — the
  // auto-collapse never fights the user again afterwards.
  const handleOpenChange = (next: boolean) => {
    userToggledRef.current = true;
    setOpen(next);
  };

  // Visibility: show during/after build, or whenever jobs exist. Avoid a
  // loading flash before the build phase when there are no jobs.
  const visible = phaseActive || items.length > 0;
  if (!visible) {
    return null;
  }

  const statusCountText = allBuilt
    ? `${items.length} agent${items.length === 1 ? '' : 's'} built`
    : `${builtCount} of ${items.length} agents built`;

  const handleActivateAll = async () => {
    setActivating(true);
    try {
      const result = await agentConfigService.activateProjectAgents(projectId);
      const activatedCount = result.activated.length;
      const failedCount = result.failed.length;

      if (failedCount > 0) {
        toast.warning(
          `Activated ${activatedCount} agent${activatedCount === 1 ? '' : 's'}, ${failedCount} failed`,
          { description: result.failed.join(', ') },
        );
      } else {
        toast.success(`Activated ${activatedCount} agent${activatedCount === 1 ? '' : 's'}`);
      }
      // Disable after a run that did not fail outright so the user isn't
      // tempted to re-activate already-active agents.
      setActivated(true);
    } catch (err) {
      console.error('Failed to activate project agents:', err);
      toast.error('Failed to activate agents. Please try again.');
    } finally {
      setActivating(false);
    }
  };

  return (
    <section
      aria-label="Fabrication status"
      className="px-4 py-3 border-b border-border/50 bg-card"
    >
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <div className="flex items-center justify-between mb-2">
          {/* The header text is the trigger (Radix supplies aria-expanded /
              aria-controls and native button Enter/Space handling). The
              action buttons stay OUTSIDE it — nested interactive controls
              inside a button are not operable. */}
          <CollapsibleTrigger className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors duration-200">
            <ChevronDown
              aria-hidden="true"
              className={`size-3 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
            />
            <span>Agent Fabrication</span>
            {!open && items.length > 0 && (
              <Badge variant="secondary" className="normal-case tracking-normal">
                {/* Polite live region: status changes announce without
                    stealing focus while the list is collapsed. */}
                <span aria-live="polite">{statusCountText}</span>
              </Badge>
            )}
          </CollapsibleTrigger>
          <div className="flex items-center gap-1">
            {allBuilt && (
              <Button
                variant="default"
                size="sm"
                className="h-6 text-xs gap-1"
                onClick={handleActivateAll}
                disabled={activating || activated}
                aria-label="Activate all agents"
              >
                {activating ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Rocket className="size-3" aria-hidden="true" />
                )}
                {activated ? 'Agents activated' : 'Activate all agents'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs gap-1"
              onClick={loadQueue}
              aria-label="Refresh fabrication status"
            >
              <RefreshCw className="size-3" aria-hidden="true" /> Refresh
            </Button>
          </div>
        </div>

        <CollapsibleContent>
          {loading && items.length === 0 ? (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground" role="status" aria-live="polite">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              <span>Loading fabrication status...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center gap-2">
              <PackageOpen className="size-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-xs text-muted-foreground">No agents are being fabricated yet.</p>
            </div>
          ) : (
            <ul role="list" className="flex flex-col gap-1.5">
              {items.map((item) => {
                const meta = STATUS_META[item.status] ?? STATUS_META.PENDING;
                const label = `${item.agentName}: ${meta.label}${
                  item.status === 'FAILED' && item.errorMessage ? ` — ${item.errorMessage}` : ''
                }`;
                return (
                  <li
                    key={item.requestId}
                    aria-label={label}
                    className="flex items-center justify-between gap-2 rounded-md bg-accent border border-border px-2.5 py-1.5"
                  >
                    <span className="truncate text-sm text-foreground" title={item.agentName}>
                      {item.agentName}
                    </span>
                    <StatusBadge status={item.status} errorMessage={item.errorMessage} />
                  </li>
                );
              })}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
