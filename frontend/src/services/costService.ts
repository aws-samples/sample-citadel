/**
 * Cost Service
 *
 * Client for the cost query HTTP API (TelemetryStack `costHttpApi`, pass 1):
 *   GET /cost/summary?groupBy=app|agent|model|project&from&to
 *   GET /cost/series?dimension=org|app|agent|model|project&id?&bucket=hour|day&from&to
 *   GET /budgets[?orgId=]
 *   PUT /budgets/{scope}
 *
 * Unlike appApiService (AppSync/GraphQL, where Amplify attaches the
 * Cognito token implicitly), this is a raw HTTP API behind a Cognito JWT
 * authorizer — the Bearer idToken must be attached explicitly on every
 * call, per the architect design (`fetchAuthSession()` → `tokens.idToken`).
 *
 * Graceful degradation: when `costApiUrl` is not configured (local dev,
 * or a deployment that hasn't threaded it through yet), every method
 * resolves to an "unavailable" result instead of throwing or fetching a
 * placeholder origin. Callers (dashboard panels) check `available` and
 * hide the cost UI rather than rendering an error state.
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import serverService from './server';

// ---- Types (mirror backend/src/lambda/cost-query-handler.ts response shapes) ----

export type CostSummaryGroupBy = 'app' | 'agent' | 'model' | 'project';
export type CostSeriesDimension = 'org' | 'app' | 'agent' | 'model' | 'project';
export type CostSeriesBucket = 'hour' | 'day';
export type BudgetPeriodType = 'monthly' | 'daily';
export type BudgetScope = 'org' | `app:${string}`;

export interface CostSummaryBucket {
  key: string;
  label: string;
  costMicros: number;
  tokenCost: number;
  totalTokens: number;
  rows: number;
  unpricedRows: number;
}

export interface CostSummaryResponse {
  groupBy: CostSummaryGroupBy;
  from: string;
  to: string;
  currency: string | null;
  currencyMixed: boolean;
  totalCostMicros: number;
  pricedRows: number;
  unpricedRows: number;
  estimate: true;
  truncated: boolean;
  buckets: CostSummaryBucket[];
}

export interface CostSeriesPoint {
  t: string;
  costMicros: number;
  totalTokens: number;
  rows: number;
  unpricedRows: number;
}

export interface CostSeriesResponse {
  dimension: CostSeriesDimension;
  id?: string;
  bucket: CostSeriesBucket;
  from: string;
  to: string;
  currency: string | null;
  estimate: true;
  truncated: boolean;
  unpricedCount: number;
  points: CostSeriesPoint[];
}

export interface Budget {
  scope: BudgetScope;
  orgId: string;
  appId?: string;
  periodType: BudgetPeriodType;
  limitMicros: number;
  thresholds: number[];
  currency: string;
  updatedAt: string;
}

export interface ListBudgetsResponse {
  budgets: Budget[];
}

export interface PutBudgetRequest {
  periodType: BudgetPeriodType;
  limitMicros: number;
  thresholds: number[];
  currency: string;
}

/** Discriminated result wrapper so callers can distinguish "cost API not configured" from a network/HTTP error. */
export type CostResult<T> =
  | { available: true; data: T }
  | { available: false; reason: 'unconfigured' };

class CostServiceUnavailableError extends Error {
  constructor() {
    super('Cost API is not configured (costApiUrl missing)');
    this.name = 'CostServiceUnavailableError';
  }
}

function getBaseUrl(): string | undefined {
  const configured = serverService.getConfig()?.costApiUrl;
  return configured && configured.length > 0 ? configured : undefined;
}

/** True when the cost query surface is configured for this deployment. UI code should call this to decide whether to render cost panels at all. */
export function isCostServiceAvailable(): boolean {
  return getBaseUrl() !== undefined;
}

async function getBearerToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('No authenticated session — cannot call cost API');
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

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new CostServiceUnavailableError();
  }

  const idToken = await getBearerToken();
  const response = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    let message = `Cost API request failed with status ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: string };
      if (errorBody?.error) message = errorBody.error;
    } catch {
      // Response body wasn't JSON — keep the generic status message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/** Wraps a cost API call, converting "unconfigured" into a typed unavailable result instead of throwing. Genuine errors (auth failure, 4xx/5xx) still throw. */
async function guarded<T>(fn: () => Promise<T>): Promise<CostResult<T>> {
  if (!isCostServiceAvailable()) {
    return { available: false, reason: 'unconfigured' };
  }
  const data = await fn();
  return { available: true, data };
}

// ---- Public API ----

export const costService = {
  isAvailable: isCostServiceAvailable,

  async getSummary(
    groupBy: CostSummaryGroupBy,
    from?: string,
    to?: string,
  ): Promise<CostResult<CostSummaryResponse>> {
    return guarded(() =>
      request<CostSummaryResponse>(
        `/cost/summary${buildQueryString({ groupBy, from, to })}`,
      ),
    );
  },

  async getSeries(
    dimension: CostSeriesDimension,
    id: string | undefined,
    bucket: CostSeriesBucket,
    from?: string,
    to?: string,
  ): Promise<CostResult<CostSeriesResponse>> {
    return guarded(() =>
      request<CostSeriesResponse>(
        `/cost/series${buildQueryString({ dimension, id, bucket, from, to })}`,
      ),
    );
  },

  async listBudgets(orgId?: string): Promise<CostResult<ListBudgetsResponse>> {
    return guarded(() =>
      request<ListBudgetsResponse>(`/budgets${buildQueryString({ orgId })}`),
    );
  },

  async putBudget(
    scope: BudgetScope,
    body: PutBudgetRequest,
  ): Promise<CostResult<Budget>> {
    return guarded(() =>
      request<Budget>(`/budgets/${encodeURIComponent(scope)}`, {
        method: 'PUT',
        body,
      }),
    );
  },
};

export default costService;
