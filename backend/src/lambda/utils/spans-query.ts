/**
 * Spans Query — CloudWatch Logs Insights `StartQuery` → bounded poll on
 * `GetQueryResults` → `StopQuery`-on-early-exit wrapper for the
 * Transaction Search (`aws/spans`) span-query path (design §1 "Query
 * mechanism", §8 "spans-query.test.ts").
 *
 * Polling is internal to this single async call — the calling Lambda
 * invocation still returns ONE synchronous JSON response to the frontend
 * (design §1 "Absorbing async polling in a sync 30s Lambda"); this module
 * owns the poll loop so trace-query-handler.ts stays a plain
 * `await runSpanQuery(...)` call site.
 *
 * Query-incomplete (poll budget exhausted while still `Running`/
 * `Scheduled`) maps to `queryStatus: "incomplete"` — NOT a thrown error —
 * so the handler can map it to the existing `indexing` status (design §1
 * "New case — poll budget exhausted"). A genuine SDK throw
 * (Throttling/LimitExceeded) is NOT caught here; it propagates to the
 * handler's existing catch-all -> 500, preserving today's error posture.
 */
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const cloudwatchLogs = new CloudWatchLogsClient({});

/** Query `Complete` with rows, or `Complete` with zero rows — the caller
 * maps `complete` + rowcount onto ready/indexing/empty (design §1).
 * `incomplete` = poll budget exhausted while still Running/Scheduled ->
 * caller maps to indexing (retryable). `failed` = Failed/Cancelled/Timeout
 * -> caller falls back to the freshness-window mapping. */
export type SpanQueryStatus = "complete" | "incomplete" | "failed";

export type SpanQueryRow = Record<string, string | undefined>;

export interface SpanQueryResult {
  queryStatus: SpanQueryStatus;
  rows: SpanQueryRow[];
  truncated: boolean;
}

export interface RunSpanQueryOptions {
  logGroupName: string;
  /** A `filter ...` clause (or `filter A | filter B`) — the `| limit N`
   * suffix is appended internally so callers never have to remember it. */
  queryString: string;
  startTimeSec: number;
  endTimeSec: number;
  limit: number;
  /** Poll cadence — defaults to 500ms (design §1). Overridable for tests. */
  pollIntervalMs?: number;
  /** Poll cap — defaults to 40 attempts (~20s at 500ms), leaving headroom
   * under the 30s Lambda timeout (design §1). Overridable for tests. */
  maxPollAttempts?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_POLL_ATTEMPTS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Statuses that mean "still working, keep polling" per the Logs Insights
 * API (`Scheduled` -> `Running` -> terminal). Treated identically here. */
const IN_PROGRESS_STATUSES = new Set(["Scheduled", "Running"]);
/** Terminal-but-not-Complete statuses -> `failed` (design §1: "Failed/
 * Cancelled/Timeout status: log + fall back to window mapping"). */
const FAILED_STATUSES = new Set(["Failed", "Cancelled", "Timeout"]);

/** Flattens a nested JSON value into dot-notation string keys (e.g.
 * `{status:{code:"ERROR"}}` -> `{"status.code":"ERROR"}`), matching the
 * flattened-field naming Logs Insights itself uses when a field is
 * projected directly (e.g. `status.code`, `_aws.xray.name`). Arrays are
 * kept as JSON-stringified leaves (e.g. `aws.xray.annotation_keys`)
 * rather than flattened by index, since callers consume them as whole
 * lists, not per-element fields. */
function flatten(value: unknown, prefix: string, out: SpanQueryRow): void {
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      flatten(child, prefix.length > 0 ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (value === null || value === undefined) return;
  out[prefix] = typeof value === "string" ? value : String(value);
}

/**
 * Row shape once `| fields @message` is projected (see runSpanQuery
 * below): each result row carries exactly one cell, `@message`, holding
 * the full JSON document for that span event (verified: probe A showed
 * an unprojected query returns only `@timestamp`/`@message`/`@ptr`, and
 * `row.spanId`/`row.traceId` were undefined — evidence report finding
 * a3d8a2ea). Parsing + flattening `@message` here recovers the nested
 * `status.code`, `_aws.xray.*`, and `attributes.*` field names the rest
 * of the spans pipeline (trace-span-query.ts/spans-waterfall.ts) expects,
 * without changing the flat `SpanQueryRow` contract downstream.
 */
function rowToObject(
  row: Array<{ field?: string; value?: string }> | undefined,
): SpanQueryRow {
  const obj: SpanQueryRow = {};
  for (const cell of row ?? []) {
    if (typeof cell?.field !== "string" || typeof cell.value !== "string") {
      continue;
    }
    if (cell.field === "@message") {
      try {
        const parsed = JSON.parse(cell.value) as unknown;
        flatten(parsed, "", obj);
      } catch (err: unknown) {
        console.error("spans-query: failed to JSON.parse @message row", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    obj[cell.field] = cell.value;
  }
  return obj;
}

/**
 * Runs one bounded Logs Insights query: `StartQuery` then poll
 * `GetQueryResults` until `Complete`/a failed terminal status/the poll
 * budget is exhausted, issuing `StopQuery` on early exit (poll-exhausted
 * only — a terminal status needs no explicit stop). Never throws on a
 * query-incomplete or query-failed outcome (mapped to `queryStatus`
 * instead); a genuine SDK error (network/throttling/auth) propagates to
 * the caller unchanged.
 */
export async function runSpanQuery(
  options: RunSpanQueryOptions,
): Promise<SpanQueryResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

  const startResult = await cloudwatchLogs.send(
    new StartQueryCommand({
      logGroupName: options.logGroupName,
      startTime: options.startTimeSec,
      endTime: options.endTimeSec,
      queryString: `${options.queryString} | fields @message | limit ${options.limit}`,
    }),
  );

  const queryId = startResult.queryId;
  if (typeof queryId !== "string" || queryId.length === 0) {
    // Defensive — StartQuery is documented to always return a queryId on
    // success; treat an unexpected shape as incomplete rather than
    // throwing, mirroring the poll-exhausted mapping.
    return { queryStatus: "incomplete", rows: [], truncated: false };
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const getResult = await cloudwatchLogs.send(
      new GetQueryResultsCommand({ queryId }),
    );
    const status = getResult.status;

    if (status === "Complete") {
      const rows = (getResult.results ?? []).map(rowToObject);
      return {
        queryStatus: "complete",
        rows,
        truncated: rows.length >= options.limit,
      };
    }

    if (typeof status === "string" && FAILED_STATUSES.has(status)) {
      console.error(
        "spans-query: query ended in a non-Complete terminal status",
        { queryId, status },
      );
      return { queryStatus: "failed", rows: [], truncated: false };
    }

    if (typeof status === "string" && IN_PROGRESS_STATUSES.has(status)) {
      if (attempt < maxPollAttempts - 1) {
        await sleep(pollIntervalMs);
      }
      continue;
    }

    // Unrecognized status string — treat as still-in-progress rather than
    // guessing; the poll budget bounds worst case either way.
    if (attempt < maxPollAttempts - 1) {
      await sleep(pollIntervalMs);
    }
  }

  // Poll budget exhausted while still Running/Scheduled (or unrecognized)
  // -> incomplete (design §1: caller maps this to "indexing", never
  // "empty" and never a 5xx). Best-effort StopQuery so the async query
  // does not keep consuming quota after we give up on it.
  try {
    await cloudwatchLogs.send(new StopQueryCommand({ queryId }));
  } catch (err: unknown) {
    console.error("spans-query: StopQuery failed on poll-exhausted exit", {
      queryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { queryStatus: "incomplete", rows: [], truncated: false };
}
