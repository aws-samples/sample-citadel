/**
 * Replay Service
 *
 * Client for the CIT-026 execution replay package routes (TelemetryStack
 * `costHttpApi`, reusing traceService's/costService's zero-new-config
 * convention — same JWT authorizer, same CORS/access-log stage):
 *
 *   GET /replay/by-execution/{executionId}       (ownership-gated, all org members)
 *   GET /replay/by-conversation/{conversationId} (ownership-gated)
 *
 * Graceful degradation mirrors traceService: when `costApiUrl` is not
 * configured, every method resolves to `{ available: false }` with ZERO
 * fetches — never a thrown error.
 *
 * Honest gate-refusal handling (design's binding invariant: "graceful
 * handling when the gate refuses — 5xx -> honest UI message, no crash"):
 * a 5xx response is NEVER thrown as a generic error and never crashes the
 * caller. It resolves to `{ available: true, gateRefused: true, reason }`
 * so the UI can render an explicit, honest message. The backend's pattern
 * IDs (log-safe, never raw secret values) are available on the raw
 * response body but this client does not surface them to the end user by
 * default — only the human-readable `error` message.
 *
 * Honest 403 handling mirrors traceService: a 403 is the ownership gate
 * legitimately denying a non-owning org — surfaced as
 * `{ available: true, unauthorized: true, reason }`, never a generic throw.
 *
 * All other non-2xx responses (400/404) still throw, same as traceService.
 */
import { fetchAuthSession } from 'aws-amplify/auth';
import serverService from './server';

export interface ReplayPackageResponse {
  query: { kind: string; id: string; correlationId?: string | null };
  url: string;
  expiresInSeconds: number;
  schemaVersion: string;
}

export type ReplayResult<T> =
  | { available: false; reason: 'unconfigured' }
  | { available: true; unauthorized: true; gateRefused?: false; reason: string }
  | { available: true; unauthorized?: false; gateRefused: true; reason: string }
  | { available: true; unauthorized?: false; gateRefused?: false; data: T };

class ReplayServiceUnavailableError extends Error {
  constructor() {
    super('Replay API is not configured (costApiUrl missing)');
    this.name = 'ReplayServiceUnavailableError';
  }
}

/** Thrown internally to signal a 403; caught by `guarded` and converted to the typed unauthorized result. */
class ReplayForbiddenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReplayForbiddenError';
  }
}

/** Thrown internally to signal a fail-closed gate refusal (5xx from the
 * sanitisation gate); caught by `guarded` and converted to the typed
 * gateRefused result rather than propagating as a generic crash. */
class ReplayGateRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReplayGateRefusedError';
  }
}

function getBaseUrl(): string | undefined {
  // Reuse the SAME config key as costService/traceService — zero new
  // frontend config for the replay routes.
  const configured = serverService.getConfig()?.costApiUrl;
  return configured && configured.length > 0 ? configured : undefined;
}

/** True when the replay package surface is configured for this deployment. */
export function isReplayServiceAvailable(): boolean {
  return getBaseUrl() !== undefined;
}

async function getBearerToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('No authenticated session — cannot call replay API');
  }
  return idToken;
}

async function request<T>(path: string): Promise<T> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new ReplayServiceUnavailableError();
  }

  const idToken = await getBearerToken();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });

  if (!response.ok) {
    if (response.status === 403) {
      let message = 'Forbidden';
      try {
        const errorBody = (await response.json()) as { error?: string };
        if (errorBody?.error) message = errorBody.error;
      } catch {
        // Response body wasn't JSON — keep the fallback message.
      }
      throw new ReplayForbiddenError(message);
    }

    if (response.status >= 500) {
      // Fail-closed gate refusal (or any other server error) — never a
      // generic crash. Fall back to a fixed honest message when the body
      // is missing/unparseable so the UI never shows raw error internals.
      let message = 'Replay package could not be produced.';
      try {
        const errorBody = (await response.json()) as { error?: string };
        if (errorBody?.error) message = errorBody.error;
      } catch {
        // Keep the fallback message.
      }
      throw new ReplayGateRefusedError(message);
    }

    let message = `Replay API request failed with status ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: string };
      if (errorBody?.error) message = errorBody.error;
    } catch {
      // Keep the fallback message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/**
 * Wraps a replay API call, converting "unconfigured" into a typed
 * unavailable result, a 403 into a typed unauthorized result, and a 5xx
 * gate refusal into a typed gateRefused result — instead of throwing for
 * any of those three cases. Genuine errors (no session, 400/404) still
 * throw.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<ReplayResult<T>> {
  if (!isReplayServiceAvailable()) {
    return { available: false, reason: 'unconfigured' };
  }
  try {
    const data = await fn();
    return { available: true, data };
  } catch (err) {
    if (err instanceof ReplayForbiddenError) {
      return { available: true, unauthorized: true, reason: err.message || 'Forbidden' };
    }
    if (err instanceof ReplayGateRefusedError) {
      return {
        available: true,
        gateRefused: true,
        reason: err.message || 'Replay package could not be produced.',
      };
    }
    throw err;
  }
}

// ---- Public API ----

export const replayService = {
  isAvailable: isReplayServiceAvailable,

  /** Ownership-gated for ALL org members: 200 with a presigned download url when the caller's org owns the execution, 403 otherwise. */
  async getByExecution(executionId: string): Promise<ReplayResult<ReplayPackageResponse>> {
    return guarded(() =>
      request<ReplayPackageResponse>(`/replay/by-execution/${encodeURIComponent(executionId)}`),
    );
  },

  /** Ownership-gated (conversation → project → org): 200 with a presigned download url when the caller's org owns the conversation, 403 otherwise. */
  async getByConversation(conversationId: string): Promise<ReplayResult<ReplayPackageResponse>> {
    return guarded(() =>
      request<ReplayPackageResponse>(
        `/replay/by-conversation/${encodeURIComponent(conversationId)}`,
      ),
    );
  },

  /**
   * Triggers the browser download of a presigned replay-package URL. Opens
   * in a new tab rather than fetching the URL itself — the URL already
   * carries its own short-lived (<=5min) auth via the presigned signature,
   * and letting the browser handle the GET avoids buffering a
   * potentially-large JSON artifact through this tab's JS heap.
   */
  downloadReplayPackage(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};

export default replayService;
