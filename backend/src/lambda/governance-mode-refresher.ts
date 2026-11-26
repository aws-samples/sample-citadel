/**
 * Governance mode propagation refresher — Wave 3.A.
 *
 * EventBridge-triggered Lambda. Listens for `governance.mode.transition`
 * events emitted by the `setGovernanceMode` resolver (Wave 2.E) and
 * forces every governance-aware Lambda to pick up the new mode by
 * bumping a `MODE_GENERATION` env var via UpdateFunctionConfiguration.
 *
 * The bumped env var triggers AWS Lambda to recycle existing warm
 * containers as they finish in-flight requests; new invocations after
 * UpdateFunctionConfiguration returns use the new value immediately.
 * Container recycling typically completes within 1–3 minutes under
 * traffic. See `.kiro/specs/governance-ui/waves-2-5-roadmap.md` §3.5.
 *
 * The list of governance-aware Lambdas is supplied via the
 * `GOVERNANCE_AWARE_FUNCTIONS` env var (JSON-encoded array of function
 * names). Wave 3.A wires only `governance-ui-resolver` itself; future
 * waves extend the list as more Lambdas adopt `governance-flag.ts`.
 *
 * Per-function failures are isolated via Promise.allSettled so a single
 * AccessDenied or ResourceNotFound does not crater the whole fanout.
 * Only when ALL refreshes fail does the handler throw — that signals
 * EventBridge to retry per its retry policy.
 */

import type { EventBridgeEvent } from 'aws-lambda';
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GovernanceModeTransitionDetail {
  previousMode: string;
  newMode: string;
  env: string;
  reason: string | null;
  actorSub: string;
  timestamp: string;
  effectiveAtUpdated: boolean;
}

export interface RefresherResult {
  totalAttempted: number;
  succeeded: number;
  failed: number;
  errors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const lambdaClient = new LambdaClient({});
const cwClient = new CloudWatchClient({});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METRIC_NAMESPACE = 'Citadel/Governance/Refresher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates the EventBridge event detail shape. Returns null on success
 * or a human-readable error message describing the missing/invalid field.
 */
export function validateDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') {
    return 'detail is missing or not an object';
  }
  const d = detail as Record<string, unknown>;
  if (typeof d.previousMode !== 'string' || d.previousMode.length === 0) {
    return 'detail.previousMode missing or not a non-empty string';
  }
  if (typeof d.newMode !== 'string' || d.newMode.length === 0) {
    return 'detail.newMode missing or not a non-empty string';
  }
  if (typeof d.env !== 'string' || d.env.length === 0) {
    return 'detail.env missing or not a non-empty string';
  }
  if (typeof d.timestamp !== 'string' || d.timestamp.length === 0) {
    return 'detail.timestamp missing or not a non-empty string';
  }
  return null;
}

/**
 * Reads the GOVERNANCE_AWARE_FUNCTIONS env var and returns the parsed
 * function-name array. Returns null when the env var is unset, empty,
 * or malformed (caller should treat null as no-op).
 */
export function readGovernanceAwareFunctions(): string[] | null {
  const raw = process.env.GOVERNANCE_AWARE_FUNCTIONS;
  if (!raw || raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const names = parsed.filter(
      (n): n is string => typeof n === 'string' && n.length > 0,
    );
    return names;
  } catch {
    return null;
  }
}

/**
 * Refreshes a single function: reads its current configuration to
 * preserve other env vars, merges in MODE_GENERATION=<iso>, and calls
 * UpdateFunctionConfiguration. Errors propagate to the caller (which
 * isolates them via Promise.allSettled).
 */
export async function refreshOneFunction(
  functionName: string,
  modeGeneration: string,
): Promise<void> {
  const current = await lambdaClient.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName }),
  );

  const existingVars = current.Environment?.Variables ?? {};
  const mergedVars: Record<string, string> = {
    ...existingVars,
    MODE_GENERATION: modeGeneration,
  };

  await lambdaClient.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: functionName,
      Environment: { Variables: mergedVars },
    }),
  );
}

/**
 * Best-effort CloudWatch metric emission. Failure is logged but does not
 * propagate — the primary fanout result is what callers care about.
 */
async function emitRefresherMetrics(
  totalAttempted: number,
  succeeded: number,
  failed: number,
): Promise<void> {
  try {
    const now = new Date();
    await cwClient.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: 'RefreshAttempt',
            Value: totalAttempted,
            Unit: 'Count',
            Timestamp: now,
          },
          {
            MetricName: 'RefreshSuccess',
            Value: succeeded,
            Unit: 'Count',
            Timestamp: now,
          },
          {
            MetricName: 'RefreshFailure',
            Value: failed,
            Unit: 'Count',
            Timestamp: now,
          },
        ],
      }),
    );
  } catch (err) {
    console.error('Failed to emit refresher metrics:', err);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (
  event: EventBridgeEvent<
    'governance.mode.transition',
    GovernanceModeTransitionDetail
  >,
): Promise<RefresherResult> => {
  console.log(
    'Governance mode refresher invoked:',
    JSON.stringify({
      source: event.source,
      detailType: event['detail-type'],
      detail: event.detail,
    }),
  );

  // 1. Validate detail shape — malformed events log a warning and return
  //    a zero-attempt result so EventBridge does not retry forever on
  //    a permanently bad payload.
  const detailError = validateDetail(event.detail);
  if (detailError) {
    console.warn(
      `governance-mode-refresher: malformed event detail (${detailError}), no-op`,
    );
    return { totalAttempted: 0, succeeded: 0, failed: 0, errors: {} };
  }

  // 2. Resolve the function list. Unset / malformed env var → no-op
  //    with a warning so operators can spot misconfiguration in logs.
  const functionNames = readGovernanceAwareFunctions();
  if (functionNames === null) {
    console.warn(
      'governance-mode-refresher: GOVERNANCE_AWARE_FUNCTIONS unset or invalid, no-op',
    );
    return { totalAttempted: 0, succeeded: 0, failed: 0, errors: {} };
  }
  if (functionNames.length === 0) {
    console.warn(
      'governance-mode-refresher: GOVERNANCE_AWARE_FUNCTIONS is empty, no-op',
    );
    return { totalAttempted: 0, succeeded: 0, failed: 0, errors: {} };
  }

  // 3. Compute a single MODE_GENERATION value so every refreshed Lambda
  //    in this fanout reports the same generation marker — useful for
  //    correlating dashboards across functions.
  const modeGeneration = new Date().toISOString();

  // 4. Per-function refresh in parallel; isolate failures.
  const settled = await Promise.allSettled(
    functionNames.map((name) => refreshOneFunction(name, modeGeneration)),
  );

  const errors: Record<string, string> = {};
  let succeeded = 0;
  let failed = 0;
  settled.forEach((outcome, idx) => {
    const name = functionNames[idx];
    if (outcome.status === 'fulfilled') {
      succeeded++;
    } else {
      failed++;
      const reason = outcome.reason;
      const message =
        reason instanceof Error ? reason.message : String(reason);
      errors[name] = message;
      console.error(
        `governance-mode-refresher: refresh failed for "${name}": ${message}`,
      );
    }
  });

  const totalAttempted = functionNames.length;

  // 5. Emit metrics best-effort.
  await emitRefresherMetrics(totalAttempted, succeeded, failed);

  // 6. If every refresh failed, throw so EventBridge retries the event
  //    per its retry policy. Partial failures still return success —
  //    the SSM mode is already committed and the eventual-consistency
  //    fallback (60 min container TTL) covers any straggler functions.
  if (totalAttempted > 0 && succeeded === 0) {
    throw new Error(
      `governance-mode-refresher: all ${totalAttempted} function refreshes failed`,
    );
  }

  console.log(
    `governance-mode-refresher: ${succeeded}/${totalAttempted} succeeded, ${failed} failed`,
  );

  return { totalAttempted, succeeded, failed, errors };
};
