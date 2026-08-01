/**
 * Trace Service
 *
 * Client for the waterfall trace query HTTP API (TelemetryStack `costHttpApi`,
 * pass 2 — see design task 60ba09e4). New routes were added to the SAME
 * `costHttpApi` used by `costService` (zero new config, same Cognito JWT
 * authorizer, same CORS/access-log stage):
 *
 *   GET /traces/by-execution/{executionId}       (ownership-gated)
 *   GET /traces/by-conversation/{conversationId} (ownership-gated)
 *   GET /traces/{traceId}                        (admin-only)
 *
 * Like `costService`, this is a raw HTTP API behind a Cognito JWT authorizer
 * — the Bearer idToken must be attached explicitly on every call via
 * `fetchAuthSession()`.
 *
 * Graceful degradation: when `costApiUrl` (`aws_cost_api_url`) is not
 * configured, every method resolves to an `{ available: false }` result
 * with ZERO fetches and zero `fetchAuthSession()` calls — mirrors
 * `costService`'s unconfigured behavior exactly.
 *
 * Honest 403 handling: a 403 response is NOT thrown as a generic error.
 * The backend's ownership gate (design §1) legitimately denies non-admins
 * on other orgs' executions/conversations, and always denies non-admins on
 * the raw trace-id route. The UI needs to render an explicit "unauthorized"
 * state rather than a generic error banner, so a 403 is surfaced as
 * `{ available: true, unauthorized: true, reason }`. All other non-2xx
 * responses (400/404/500) still throw, same as `costService`.
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import serverService from './server';

// ---- Types (mirror backend/src/lambda/trace-query-handler.ts response shapes, design §2) ----

export type TraceQueryKind = 'execution' | 'conversation' | 'traceId';
export type TraceWaterfallStatus = 'ready' | 'indexing' | 'empty';
export type TraceSpanStatus = 'ok' | 'error' | 'fault' | 'throttle';

export interface TraceSpanHttp {
  status: number;
}

export interface TraceSpanError {
  type: string;
  message: string;
}

export interface TraceSpan {
  id: string;
  parentId: string | null;
  name: string;
  namespace?: 'aws' | 'remote' | null;
  origin?: string | null;
  startTime: number;
  endTime?: number | null;
  startOffsetMs: number;
  durationMs: number;
  status: TraceSpanStatus;
  http?: TraceSpanHttp | null;
  error?: TraceSpanError | null;
  inProgress?: boolean;
  children: TraceSpan[];
}

export interface TraceAnnotations {
  correlation_id?: string;
  execution_id?: string;
  source_trace_id?: string;
  node_id?: string;
  session_id?: string;
  [key: string]: string | undefined;
}

export interface TraceSummary {
  traceId: string;
  rootName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  hasError: boolean;
  hasFault: boolean;
  hasThrottle: boolean;
  annotations: TraceAnnotations;
  spans: TraceSpan[];
}

export interface TraceWaterfallResponse {
  query: {
    kind: TraceQueryKind;
    id: string;
    correlationId?: string | null;
  };
  status: TraceWaterfallStatus;
  linkedBy?: string;
  traces: TraceSummary[];
  truncated?: boolean;
  meta?: {
    traceCount: number;
    spanCount: number;
    estimate: boolean;
  };
}

/**
 * Discriminated result wrapper. Mirrors `CostResult<T>`'s "unconfigured" arm
 * and adds the trace-specific "unauthorized" arm (design §2, 403 handling) so
 * callers can distinguish three states: not configured, denied, and success.
 */
export type TraceResult<T> =
  | { available: false; reason: 'unconfigured' }
  | { available: true; unauthorized: true; reason: string }
  | { available: true; unauthorized?: false; data: T };

class TraceServiceUnavailableError extends Error {
  constructor() {
    super('Trace API is not configured (costApiUrl missing)');
    this.name = 'TraceServiceUnavailableError';
  }
}

/** Thrown internally to signal a 403; caught by `guarded` and converted to the typed unauthorized result. */
class TraceForbiddenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TraceForbiddenError';
  }
}

function getBaseUrl(): string | undefined {
  // Reuse the SAME config key as costService — no new frontend config key
  // (design §4: zero new config, `aws_cost_api_url` reused for the trace routes).
  const configured = serverService.getConfig()?.costApiUrl;
  return configured && configured.length > 0 ? configured : undefined;
}

/** True when the trace query surface is configured for this deployment (reuses the cost API config). */
export function isTraceServiceAvailable(): boolean {
  return getBaseUrl() !== undefined;
}

async function getBearerToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('No authenticated session — cannot call trace API');
  }
  return idToken;
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, value);
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(path: string): Promise<T> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new TraceServiceUnavailableError();
  }

  const idToken = await getBearerToken();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });

  if (!response.ok) {
    // 403 bodies fall back to "Forbidden" (not a generic status message) so the
    // UI's unauthorized state always shows a clean, user-facing reason even
    // when the backend's error body is missing or unparseable.
    let message =
      response.status === 403
        ? 'Forbidden'
        : `Trace API request failed with status ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: string };
      if (errorBody?.error) message = errorBody.error;
    } catch {
      // Response body wasn't JSON — keep the status-appropriate fallback message.
    }
    if (response.status === 403) {
      throw new TraceForbiddenError(message);
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/**
 * Wraps a trace API call, converting "unconfigured" into a typed unavailable
 * result and a 403 into a typed unauthorized result — instead of throwing.
 * Genuine errors (no session, 400/404/500) still throw.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<TraceResult<T>> {
  if (!isTraceServiceAvailable()) {
    return { available: false, reason: 'unconfigured' };
  }
  try {
    const data = await fn();
    return { available: true, data };
  } catch (err) {
    if (err instanceof TraceForbiddenError) {
      return { available: true, unauthorized: true, reason: err.message || 'Forbidden' };
    }
    throw err;
  }
}

// ---- Public API ----

export const traceService = {
  isAvailable: isTraceServiceAvailable,

  /** Ownership-gated: 200 when the caller's org owns the execution (or caller is admin), 403 otherwise. */
  async getByExecution(
    executionId: string,
    from?: string,
    to?: string,
  ): Promise<TraceResult<TraceWaterfallResponse>> {
    return guarded(() =>
      request<TraceWaterfallResponse>(
        `/traces/by-execution/${encodeURIComponent(executionId)}${buildQueryString({ from, to })}`,
      ),
    );
  },

  /** Ownership-gated (conversation → project → org): 200 when the caller's org owns the conversation (or caller is admin), 403 otherwise. */
  async getByConversation(
    conversationId: string,
    from?: string,
    to?: string,
  ): Promise<TraceResult<TraceWaterfallResponse>> {
    return guarded(() =>
      request<TraceWaterfallResponse>(
        `/traces/by-conversation/${encodeURIComponent(conversationId)}${buildQueryString({ from, to })}`,
      ),
    );
  },

  /** Admin-only (no org entry key exists for a raw trace id): always 403 for non-admins. */
  async getByTraceId(
    traceId: string,
    from?: string,
    to?: string,
  ): Promise<TraceResult<TraceWaterfallResponse>> {
    return guarded(() =>
      request<TraceWaterfallResponse>(
        `/traces/${encodeURIComponent(traceId)}${buildQueryString({ from, to })}`,
      ),
    );
  },
};

export default traceService;
