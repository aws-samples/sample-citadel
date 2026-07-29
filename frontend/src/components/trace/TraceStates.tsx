/**
 * TraceStates — honest, no-fake-data states for the waterfall trace viewer.
 * Every non-happy-path (loading / indexing / empty / unauthorized / unavailable)
 * gets its own explicit render — never a spinner masking a real failure, and
 * never a synthesized placeholder trace.
 */
import { RefreshCw, ShieldAlert, Inbox, CloudOff, Clock } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { Button } from '../ui/button';

export function TraceLoadingState() {
  return (
    <div className="flex flex-col gap-3 p-4" role="status" aria-label="Loading trace">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-5/6 ml-4" />
      <Skeleton className="h-10 w-2/3 ml-8" />
    </div>
  );
}

interface TraceIndexingStateProps {
  onRetry: () => void;
}

/**
 * X-Ray has eventual availability (~90s window per the design). Rather than
 * showing a false "no trace recorded", the indexing state tells the user the
 * trace is likely still being ingested and offers an explicit retry.
 */
export function TraceIndexingState({ onRetry }: TraceIndexingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <Clock className="size-8 text-muted-foreground" />
      <p className="text-sm text-foreground font-medium">Trace still indexing</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        X-Ray traces can take up to a minute to become queryable after
        execution. This isn't a missing trace — try again shortly.
      </p>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onRetry}>
        <RefreshCw className="size-3" /> Retry
      </Button>
    </div>
  );
}

export function TraceEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <Inbox className="size-8 text-muted-foreground" />
      <p className="text-sm text-foreground font-medium">No trace recorded</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        No X-Ray trace was found for this execution or conversation. This can
        happen on a sampling miss, or if tracing wasn't yet stitched for this
        flow.
      </p>
    </div>
  );
}

interface TraceUnauthorizedStateProps {
  reason: string;
}

export function TraceUnauthorizedState({ reason }: TraceUnauthorizedStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <ShieldAlert className="size-8 text-destructive" />
      <p className="text-sm text-foreground font-medium">Not authorized</p>
      <p className="text-xs text-muted-foreground max-w-sm">{reason}</p>
    </div>
  );
}

export function TraceUnavailableState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <CloudOff className="size-8 text-muted-foreground" />
      <p className="text-sm text-foreground font-medium">Trace viewer unavailable</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        The trace query API isn't configured for this deployment.
      </p>
    </div>
  );
}

interface TraceErrorStateProps {
  message: string;
  onRetry: () => void;
}

export function TraceErrorState({ message, onRetry }: TraceErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <p className="text-sm text-destructive font-medium">Failed to load trace</p>
      <p className="text-xs text-muted-foreground max-w-sm">{message}</p>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onRetry}>
        <RefreshCw className="size-3" /> Retry
      </Button>
    </div>
  );
}
