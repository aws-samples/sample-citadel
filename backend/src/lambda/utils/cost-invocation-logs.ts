/**
 * Cost Invocation Logs — Tier B CloudWatch Bedrock model-invocation log
 * parsing + fetch.
 *
 * Tier B source = CloudWatch Bedrock model-invocation logging (opt-in,
 * account-level setting). Query mechanism = `FilterLogEvents`, deliberately
 * NOT Logs Insights `StartQuery`: the reconciliation window is a bounded
 * hour, `FilterLogEvents` is synchronous (no async start/poll dance), it
 * avoids the extra `logs:StartQuery`/`logs:GetQueryResults` IAM actions and
 * the per-GB Insights scan cost, and per-window log cardinality is already
 * bounded by the hour window — a plain paginated Filter call is sufficient.
 *
 * `parseInvocationLogEvent` is pure and defensive: malformed/partial log
 * lines never throw, they simply return `null` (unparseable) or coerce
 * missing token fields to 0. `fetchInvocationTokenActuals` wraps the AWS
 * call and is itself defensive — any `FilterLogEvents` failure logs and
 * returns an empty map rather than throwing, so a Tier B log-source outage
 * degrades to "no actuals this window" rather than crashing Tier A.
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const cloudwatchLogs = new CloudWatchLogsClient({});

export interface InvocationLogTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface ParsedInvocationLogEvent extends InvocationLogTokens {
  requestId: string;
}

/** Non-negative-int coercion — never throws, mirrors the writer/reconciler convention. */
function coerceNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return 0;
}

/**
 * Parses one CloudWatch Bedrock model-invocation log message into
 * `{requestId, inputTokens, outputTokens}`.
 *
 * Expected shape (Bedrock model-invocation logging, JSON log line):
 * `{"requestId": "...", "input": {"inputTokenCount": N}, "output": {"outputTokenCount": N}, ...}`.
 * Never throws: a non-JSON message, a missing/empty `requestId`, or
 * malformed nested fields all degrade gracefully — `null` when there is no
 * usable requestId to key on, otherwise token counts coerce to 0.
 */
export function parseInvocationLogEvent(
  message: string | undefined,
): ParsedInvocationLogEvent | null {
  if (typeof message !== "string" || message.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const requestId = obj.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return null;

  const input =
    typeof obj.input === "object" && obj.input !== null
      ? (obj.input as Record<string, unknown>)
      : {};
  const output =
    typeof obj.output === "object" && obj.output !== null
      ? (obj.output as Record<string, unknown>)
      : {};

  return {
    requestId,
    inputTokens: coerceNonNegativeInt(input.inputTokenCount),
    outputTokens: coerceNonNegativeInt(output.outputTokenCount),
  };
}

/**
 * Fetches Bedrock model-invocation log actuals for `[startSec, endSec)`
 * from `logGroupName`, paginating via `FilterLogEvents`'s `nextToken` until
 * exhausted or `maxEventsPerWindow` is reached (bounds worst-case cost per
 * reconciler run). Returns a `Map<requestId, {inputTokens, outputTokens}>`
 * — malformed lines are skipped via `parseInvocationLogEvent`, never
 * thrown. A `FilterLogEvents` failure (missing log group, access denied,
 * throttling) is logged and returns an empty map — Tier B degrades to "no
 * actuals this window" rather than aborting the reconciler run.
 */
export async function fetchInvocationTokenActuals(
  logGroupName: string,
  startSec: number,
  endSec: number,
  maxEventsPerWindow: number,
): Promise<Map<string, InvocationLogTokens>> {
  const result = new Map<string, InvocationLogTokens>();
  let nextToken: string | undefined;
  let eventsSeen = 0;

  try {
    do {
      const resp = await cloudwatchLogs.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime: startSec * 1000,
          endTime: endSec * 1000,
          nextToken,
        }),
      );

      for (const event of resp.events ?? []) {
        const parsedEvent = parseInvocationLogEvent(event.message);
        if (parsedEvent) {
          result.set(parsedEvent.requestId, {
            inputTokens: parsedEvent.inputTokens,
            outputTokens: parsedEvent.outputTokens,
          });
        }
        eventsSeen += 1;
        if (eventsSeen >= maxEventsPerWindow) {
          return result;
        }
      }

      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (err: unknown) {
    console.error(
      "cost-invocation-logs: FilterLogEvents failed, Tier B degrades to no actuals this window",
      {
        logGroupName,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return new Map();
  }

  return result;
}
