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
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { useOrganization } from '../contexts/OrganizationContext';
import { traceService, type TraceQueryKind, type TraceWaterfallResponse } from '../services/traceService';
import { governanceService, type GovernanceFinding } from '../services/governanceService';
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
              <>
                <TraceWaterfall traces={state.data.traces} />
                <GovernanceDecisionsPanel traces={state.data.traces} />
              </>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Governance decisions panel (design task 9b3f4f78, §4/§5 — runtime ->
// decision direction).
//
// Reads the execution_id annotation (fallback correlation_id) off the
// loaded waterfall traces, then queries
// listGovernanceFindings(workflowId=execution_id) via the EXISTING
// any-authenticated workflow-index GSI read (design §3 direction (b)).
//
// Join-key note (see docs/OBSERVABILITY.md Known-limitation section): this
// direction assumes finding.workflowId (== supervisor orchestrationId)
// equals the runtime execution_id. That equivalence does NOT hold in
// general for supervisor-dispatched findings today — a zero-result panel
// here is expected/honest for many executions, not necessarily a bug.
// ---------------------------------------------------------------------------

type DecisionsPanelState =
  | { kind: 'no-execution-id' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; findings: GovernanceFinding[] };

function GovernanceDecisionsPanel({ traces }: { traces: TraceWaterfallResponse['traces'] }) {
  const navigate = useNavigate();
  const [panelState, setPanelState] = useState<DecisionsPanelState>({ kind: 'loading' });

  // Every trace in a waterfall response shares the same correlation id
  // (design: they're all hops of the same execution/conversation), so the
  // first trace's annotations are representative.
  const executionId = traces[0]?.annotations?.execution_id ?? traces[0]?.annotations?.correlation_id;

  useEffect(() => {
    if (!executionId) {
      setPanelState({ kind: 'no-execution-id' });
      return;
    }
    let cancelled = false;
    setPanelState({ kind: 'loading' });
    governanceService
      .listGovernanceFindings({ workflowId: executionId })
      .then((conn) => {
        if (!cancelled) setPanelState({ kind: 'loaded', findings: conn.items });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPanelState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Failed to load governance decisions',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [executionId]);

  if (panelState.kind === 'no-execution-id') {
    return (
      <Card className="p-4 text-sm text-muted-foreground" data-testid="governance-decisions-no-execution-id">
        Execution id unavailable on this trace — cannot look up governance decisions.
      </Card>
    );
  }

  if (panelState.kind === 'loading') {
    return (
      <Card className="p-4 text-sm text-muted-foreground" data-testid="governance-decisions-loading">
        Loading governance decisions…
      </Card>
    );
  }

  if (panelState.kind === 'error') {
    // Inline error only — must not break the waterfall render (design §5).
    return (
      <Card className="p-4 text-sm text-destructive" data-testid="governance-decisions-error">
        Failed to load governance decisions: {panelState.message}
      </Card>
    );
  }

  const { findings } = panelState;

  return (
    <Card className="p-4 flex flex-col gap-3" data-testid="governance-decisions-panel">
      <p className="text-sm font-medium text-foreground">
        Governance decisions ({findings.length})
      </p>
      {findings.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="governance-decisions-empty">
          No governance decisions recorded for this execution.
        </p>
      )}
      {findings.length > 0 && (
        <div className="flex flex-col gap-1">
          {findings.map((f) => (
            <Button
              key={f.findingId}
              type="button"
              variant="ghost"
              className="flex items-center justify-start gap-2 h-auto py-1 px-2"
              data-testid="governance-decisions-row"
              onClick={() => navigate(`/governance/ledger?findingId=${f.findingId}`)}
            >
              <Badge variant="secondary" className="capitalize">
                {f.decision}
              </Badge>
              <span className="text-muted-foreground truncate">{f.reason}</span>
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

export default Observability;
