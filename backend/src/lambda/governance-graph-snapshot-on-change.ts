/**
 * Governance authority graph snapshot — on-change variant (Wave 4.E.A.2).
 *
 * Triggered by DynamoDB streams on the four authority source tables
 * (authorityUnits, compositionContracts, constitutionalLayers, caseLaw).
 * The stream records themselves are NOT inspected for content — they
 * are used purely as a trigger signal. Every triggered invocation
 * produces a single full snapshot (same shape as the daily scheduled
 * snapshot writer in `governance-graph-snapshot.ts`) so the existing
 * read path (`getAuthorityGraphSnapshot` / `listAuthorityGraphSnapshots`
 * resolvers) consumes both schedule-driven and change-driven rows
 * uniformly.
 *
 * Why ignore record content?
 *   1. The snapshot is whole-state — we always re-scan all four tables
 *      to produce a `kind: 'full'` row. Per-record diffing would only
 *      help a `kind: 'delta'` shape, which neither the resolver nor the
 *      Wave 4.B time scrubber knows how to consume today.
 *   2. Multiple records arriving in a single Lambda invocation
 *      (DynamoDB stream batching, configurable via batchSize on the
 *      EventSourceMapping) collapse naturally into one snapshot. This
 *      gives us write debouncing for free without an explicit window.
 *   3. Stream record decoding (unmarshall NewImage) is the most common
 *      schema-drift hazard. Skipping it removes that failure surface
 *      entirely.
 *
 * The daily scheduled handler in `governance-graph-snapshot.ts` stays
 * in place as a completeness backstop: if the stream ever drops a
 * record (24h DynamoDB stream retention vs. operator-configurable
 * snapshot retentionDays) the next scheduled run still captures full
 * state. The two handlers are operationally distinguishable in
 * CloudWatch by the `Trigger` dimension on
 * `Citadel/Governance/GraphSnapshot/Count` (Schedule vs OnChange).
 *
 * Default state is OFF — same opt-in path as the scheduled handler.
 * When `settings.enabled` is false we log a one-line skip and return
 * without scanning anything, so adding streams to the four source
 * tables does NOT cause traffic until an operator opts in.
 */

import { randomUUID } from 'crypto';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

import {
  readSettings,
  scanCappedTable,
} from './governance-graph-snapshot';

// ---------------------------------------------------------------------------
// Types — kept in lockstep with SnapshotPayload in governance-graph-snapshot.ts
// ---------------------------------------------------------------------------

interface OnChangeSnapshotPayload {
  snapshotId: string;
  kind: 'full';
  timestamp: number;
  expiresAt: number;
  env: string;
  authorityUnits: Array<Record<string, unknown>>;
  compositionContracts: Array<Record<string, unknown>>;
  constitutionalLayers: Array<Record<string, unknown>>;
  caseLaw: Array<Record<string, unknown>>;
  truncated: {
    authorityUnits: boolean;
    compositionContracts: boolean;
    constitutionalLayers: boolean;
    caseLaw: boolean;
  };
  partial?: boolean;
  trigger: 'OnChange';
}

export interface OnChangeSnapshotResult {
  ok: boolean;
  snapshotId: string | null;
  reason?: string;
  partial?: boolean;
  recordCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METRIC_NAMESPACE = 'Citadel/Governance/GraphSnapshot';

// ---------------------------------------------------------------------------
// Clients (lazy-instantiated so unit tests can mock the constructors before
// first use without racing module load)
// ---------------------------------------------------------------------------

let _doc: DynamoDBDocumentClient | null = null;
function docClient(): DynamoDBDocumentClient {
  if (!_doc) _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

let _cw: CloudWatchClient | null = null;
function cwClient(): CloudWatchClient {
  if (!_cw) _cw = new CloudWatchClient({});
  return _cw;
}

export function __resetClientsForTest(): void {
  _doc = null;
  _cw = null;
}

// ---------------------------------------------------------------------------
// Metric emit — local copy so we can add the `Trigger=OnChange` dimension
// without touching the scheduled handler's emit signature.
// ---------------------------------------------------------------------------

async function emitOnChangeMetric(
  status: 'Success' | 'Failure',
  partial = false,
): Promise<void> {
  try {
    await cwClient().send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: 'Count',
            Value: 1,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Status', Value: status },
              { Name: 'Partial', Value: partial ? 'true' : 'false' },
              { Name: 'Trigger', Value: 'OnChange' },
            ],
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (err) {
    console.error(
      'governance-graph-snapshot-on-change: metric emit failed',
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<OnChangeSnapshotResult> => {
  const recordCount = event.Records?.length ?? 0;
  const env = process.env.ENVIRONMENT || 'unknown';

  // 0. Empty batch — return early. The EventSourceMapping shouldn't
  //    invoke us with zero records but be defensive.
  if (recordCount === 0) {
    return { ok: true, snapshotId: null, reason: 'empty', recordCount: 0 };
  }

  // 1. Read settings. Default OFF — operators opt in via the same SSM
  //    parameter the scheduled handler reads, so toggling the feature
  //    affects both triggers identically.
  const settings = await readSettings(env);
  if (!settings.enabled) {
    console.log(
      `governance-graph-snapshot-on-change: skipped — disabled (recordCount=${recordCount})`,
    );
    return {
      ok: true,
      snapshotId: null,
      reason: 'disabled',
      recordCount,
    };
  }

  // 1b. Honor captureMode. Fail-closed: any value not in
  //     {on-change, both} skips this stream-driven handler. The
  //     scheduled handler skips on the inverse condition, so unknown
  //     values correctly cause BOTH handlers to skip rather than both
  //     run.
  if (
    settings.captureMode !== 'on-change' &&
    settings.captureMode !== 'both'
  ) {
    console.log(
      `governance-graph-snapshot-on-change: skipped — captureMode='${settings.captureMode}' (recordCount=${recordCount})`,
    );
    return {
      ok: true,
      snapshotId: null,
      reason: 'captureMode-skipped',
      recordCount,
    };
  }

  // 2. Resolve env-var inputs. Missing destination is fatal.
  const snapshotsTable = process.env.GRAPH_SNAPSHOTS_TABLE;
  if (!snapshotsTable) {
    throw new Error('GRAPH_SNAPSHOTS_TABLE env var is not set');
  }
  const sourceTables = {
    authorityUnits: process.env.AUTHORITY_UNITS_TABLE ?? '',
    compositionContracts: process.env.COMPOSITION_CONTRACTS_TABLE ?? '',
    constitutionalLayers: process.env.CONSTITUTIONAL_LAYERS_TABLE ?? '',
    caseLaw: process.env.CASE_LAW_TABLE ?? '',
  };

  // 3. Scan all 4 source tables in parallel. Failures are isolated
  //    per-table — same semantics as the scheduled handler.
  const tableEntries = Object.entries(sourceTables) as Array<
    [keyof typeof sourceTables, string]
  >;
  const settled = await Promise.allSettled(
    tableEntries.map(async ([key, tableName]) => {
      if (tableName.length === 0) {
        throw new Error(`source table env var unset for ${key}`);
      }
      return scanCappedTable(tableName);
    }),
  );

  const rows: Record<keyof typeof sourceTables, Array<Record<string, unknown>>> = {
    authorityUnits: [],
    compositionContracts: [],
    constitutionalLayers: [],
    caseLaw: [],
  };
  const truncated: Record<keyof typeof sourceTables, boolean> = {
    authorityUnits: false,
    compositionContracts: false,
    constitutionalLayers: false,
    caseLaw: false,
  };
  let successfulTables = 0;
  settled.forEach((outcome, idx) => {
    const [key] = tableEntries[idx];
    if (outcome.status === 'fulfilled') {
      rows[key] = outcome.value.items;
      truncated[key] = outcome.value.truncated;
      successfulTables += 1;
    } else {
      const reason = outcome.reason;
      const message =
        reason instanceof Error ? reason.message : String(reason);
      console.error(
        `governance-graph-snapshot-on-change: source-table read failed for "${key}": ${message}`,
      );
    }
  });

  // 4. All four tables failed — emit failure metric and throw so the
  //    EventSourceMapping retry+DLQ path catches it.
  if (successfulTables === 0) {
    await emitOnChangeMetric('Failure');
    throw new Error(
      'governance-graph-snapshot-on-change: all 4 source-table reads failed',
    );
  }

  const partial = successfulTables < tableEntries.length;
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshot: OnChangeSnapshotPayload = {
    snapshotId: randomUUID(),
    kind: 'full',
    timestamp: nowSec,
    expiresAt: nowSec + Math.max(0, Math.trunc(settings.retentionDays)) * 86400,
    env,
    authorityUnits: rows.authorityUnits,
    compositionContracts: rows.compositionContracts,
    constitutionalLayers: rows.constitutionalLayers,
    caseLaw: rows.caseLaw,
    truncated,
    ...(partial ? { partial: true } : {}),
    trigger: 'OnChange',
  };

  // 5. Write the snapshot. Failure here is fatal — the EventSourceMapping
  //    retries with batch isolation, then routes to the DLQ wired in
  //    arbiter-stack.ts.
  try {
    await docClient().send(
      new PutCommand({
        TableName: snapshotsTable,
        Item: snapshot,
      }),
    );
  } catch (err) {
    await emitOnChangeMetric('Failure', partial);
    throw err;
  }

  await emitOnChangeMetric('Success', partial);
  console.log(
    `governance-graph-snapshot-on-change: wrote snapshot ${snapshot.snapshotId} (partial=${partial}, recordCount=${recordCount}, retention=${settings.retentionDays}d)`,
  );
  return {
    ok: true,
    snapshotId: snapshot.snapshotId,
    partial,
    recordCount,
  };
};
