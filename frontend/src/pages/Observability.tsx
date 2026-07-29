/**
 * Observability — waterfall trace viewer page.
 *
 * Route: /observability/trace/:kind/:id (kind = 'execution' | 'conversation' | 'traceId').
 * Deep-linked from ExecutionDetailSheet ("View trace") and ProjectWorkspace
 * ("View trace") per the design's deep-link list. Also reachable directly via
 * the admin-only raw-trace-id input (design §1: `/traces/{traceId}` has no org
 * entry key, so it is admin-only — the input is gated on `useOrganization().isAdmin`).
 *
 * Freshness handling: a 0-summary "indexing" response auto-retries once after
 * a short delay (X-Ray eventual availability, design §2's ~90s window) before
 * falling back to the indexing UI with a manual retry action.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageContainer } from '../components/PageContainer';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { useOrganization } from '../contexts/OrganizationContext';
import { traceService, type TraceQueryKind, type TraceWaterfallResponse } from '../services/traceService';
import { TraceWaterfall } from '../components/trace/TraceWaterfall';
import {
  TraceLoadingState,
  TraceIndexingState,
  TraceEmptyState,
  TraceUnauthorizedState,
  TraceUnavailableState,
  TraceErrorState,
} from '../components/trace/TraceStates';

const AUTO_RETRY_DELAY_MS = 4000;

type ViewState =
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'unauthorized'; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'indexing' }
  | { kind: 'ready'; data: TraceWaterfallResponse };

function fetchByKind(kind: TraceQueryKind, id: string) {
  switch (kind) {
    case 'execution':
      return traceService.getByExecution(id);
    case 'conversation':
      return traceService.getByConversation(id);
    case 'traceId':
      return traceService.getByTraceId(id);
    default:
      return traceService.getByExecution(id);
  }
}

function isValidKind(value: string | undefined): value is TraceQueryKind {
  return value === 'execution' || value === 'conversation' || value === 'traceId';
}

export function Observability() {
  const navigate = useNavigate();
  const { kind: kindParam, id: idParam } = useParams<{ kind: string; id: string }>();
  const { isAdmin } = useOrganization();
  const [rawTraceId, setRawTraceId] = useState('');
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const autoRetriedRef = useRef(false);

  const kind: TraceQueryKind | null = isValidKind(kindParam) ? kindParam : null;
  const id = idParam ?? '';

  const load = useCallback(async () => {
    if (!kind || !id) {
      setState({ kind: 'empty' });
      return;
    }
    if (!traceService.isAvailable()) {
      setState({ kind: 'unavailable' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const result = await fetchByKind(kind, id);
      if (!result.available) {
        setState({ kind: 'unavailable' });
        return;
      }
      if (result.unauthorized) {
        setState({ kind: 'unauthorized', reason: result.reason });
        return;
      }
      if (result.data.status === 'ready') {
        setState({ kind: 'ready', data: result.data });
      } else if (result.data.status === 'indexing') {
        setState({ kind: 'indexing' });
      } else {
        setState({ kind: 'empty' });
      }
    } catch (err: any) {
      setState({ kind: 'error', message: err?.message || 'Failed to load trace' });
    }
  }, [kind, id]);

  useEffect(() => {
    autoRetriedRef.current = false;
    load();
  }, [load]);

  // Auto-retry once on an "indexing" response — X-Ray eventual availability
  // means the trace may become queryable within the freshness window without
  // the user needing to click anything.
  useEffect(() => {
    if (state.kind === 'indexing' && !autoRetriedRef.current) {
      autoRetriedRef.current = true;
      const timer = setTimeout(load, AUTO_RETRY_DELAY_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state.kind, load]);

  const handleRawTraceIdSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawTraceId.trim()) return;
    navigate(`/observability/trace/traceId/${encodeURIComponent(rawTraceId.trim())}`);
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-4 max-w-5xl mx-auto">
        <div>
          <h1 className="text-lg font-medium text-foreground">Trace Viewer</h1>
          <p className="text-sm text-muted-foreground">
            Waterfall view of X-Ray spans for a workflow execution or agent conversation.
          </p>
        </div>

        {isAdmin && (
          <form onSubmit={handleRawTraceIdSubmit} className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="raw-trace-id" className="text-xs text-muted-foreground">
                Raw trace ID (admin only)
              </Label>
              <Input
                id="raw-trace-id"
                placeholder="1-abcdef12-0123456789abcdef01234567"
                value={rawTraceId}
                onChange={(e) => setRawTraceId(e.target.value)}
                className="w-96 font-mono text-xs"
              />
            </div>
            <Button type="submit" size="sm" variant="outline">
              Look up
            </Button>
          </form>
        )}

        {!kind || !id ? (
          <TraceEmptyState />
        ) : (
          <>
            {state.kind === 'loading' && <TraceLoadingState />}
            {state.kind === 'unavailable' && <TraceUnavailableState />}
            {state.kind === 'unauthorized' && <TraceUnauthorizedState reason={state.reason} />}
            {state.kind === 'error' && <TraceErrorState message={state.message} onRetry={load} />}
            {state.kind === 'empty' && <TraceEmptyState />}
            {state.kind === 'indexing' && <TraceIndexingState onRetry={load} />}
            {state.kind === 'ready' && state.data.traces.length === 0 && <TraceEmptyState />}
            {state.kind === 'ready' && state.data.traces.length > 0 && (
              <TraceWaterfall traces={state.data.traces} />
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

export default Observability;
