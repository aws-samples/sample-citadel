/**
 * Governance authority graph snapshot Lambda — Wave 4.E.A.
 *
 * Triggered daily by an EventBridge schedule (03:00 UTC; wired in
 * arbiter-stack.ts). Reads the authority-graph-history settings from
 * the SSM parameter `/citadel/governance/authority-graph-history/{env}`
 * and either skips early (`enabled: false`) or scans all four authority
 * source tables and writes a single snapshot row to
 * `governanceGraphSnapshotsTable` with TTL = `now + retentionDays * 86400`.
 *
 * Default state is OFF — operators consciously opt in via the Wave 4.E.A
 * settings card on the governance Graph page. When disabled, the Lambda
 * logs a one-line skip message and returns without scanning anything.
 *
 * Per-table read failures are isolated: a single source-table failure
 * is logged + metricised but the snapshot still goes through with the
 * remaining tables and a `partial: true` marker. Only when ALL FOUR
 * tables fail does the handler emit a failure metric and throw — that
 * surfaces to the EventBridge schedule as a failed invocation and the
 * operator runbook (alarm on `Citadel/Governance/GraphSnapshot/Count`
 * with Status=Failure) catches the case.
 */

import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
  ScanCommand as RawScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthorityGraphHistorySettingsRaw {
  enabled: boolean;
  retentionDays: number;
  captureMode: string;
}

interface SnapshotPayload {
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
}

export interface SnapshotResult {
  ok: boolean;
  snapshotId: string | null;
  reason?: string;
  partial?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PER_TABLE_SCAN_CAP = 5000;
const METRIC_NAMESPACE = 'Citadel/Governance/GraphSnapshot';
const SAFE_DEFAULTS: AuthorityGraphHistorySettingsRaw = {
  enabled: false,
  retentionDays: 30,
  captureMode: 'daily',
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const cw = new CloudWatchClient({});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidRawShape(
  candidate: unknown,
): candidate is AuthorityGraphHistorySettingsRaw {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const c = candidate as Record<string, unknown>;
  if (typeof c.enabled !== 'boolean') return false;
  if (typeof c.retentionDays !== 'number' || !Number.isFinite(c.retentionDays)) {
    return false;
  }
  if (typeof c.captureMode !== 'string' || c.captureMode.length === 0) {
    return false;
  }
  return true;
}

export async function readSettings(
  env: string,
): Promise<AuthorityGraphHistorySettingsRaw> {
  const parameterName = `/citadel/governance/authority-graph-history/${env}`;
  try {
    const resp = await ssm.send(
      new GetParameterCommand({ Name: parameterName }),
    );
    const value = resp.Parameter?.Value ?? '';
    if (value.length === 0) return { ...SAFE_DEFAULTS };
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ...SAFE_DEFAULTS };
    }
    if (!isValidRawShape(parsed)) return { ...SAFE_DEFAULTS };
    return {
      enabled: parsed.enabled,
      retentionDays: parsed.retentionDays,
      captureMode: parsed.captureMode,
    };
  } catch {
    return { ...SAFE_DEFAULTS };
  }
}

/**
 * Scan a source table with a hard 5000-row cap. Returns the items +
 * `truncated` flag indicating whether the cap kicked in. Failures
 * propagate so the caller can isolate per-table errors via
 * Promise.allSettled.
 */
export async function scanCappedTable(
  tableName: string,
): Promise<{ items: Array<Record<string, unknown>>; truncated: boolean }> {
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined = undefined;
  while (items.length < PER_TABLE_SCAN_CAP) {
    const remaining = PER_TABLE_SCAN_CAP - items.length;
    const resp: {
      Items?: Array<Record<string, unknown>>;
      LastEvaluatedKey?: Record<string, unknown>;
    } = await dynamodb.send(
      new ScanCommand({
        TableName: tableName,
        Limit: remaining,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const page = resp.Items ?? [];
    for (const it of page) {
      if (items.length >= PER_TABLE_SCAN_CAP) break;
      items.push(it);
    }
    exclusiveStartKey = resp.LastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  // We treat the cap as "truncated" when there are still more rows on
  // the next page (LastEvaluatedKey present after we hit the cap). If
  // the page exactly fills the cap with no LastEvaluatedKey, the table
  // genuinely had ≤5000 rows.
  const truncated = !!exclusiveStartKey && items.length >= PER_TABLE_SCAN_CAP;
  return { items, truncated };
}

export async function emitMetric(
  status: 'Success' | 'Failure',
  partial = false,
): Promise<void> {
  try {
    await cw.send(
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
            ],
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (err) {
    console.error('governance-graph-snapshot: metric emit failed', err);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (): Promise<SnapshotResult> => {
  const env = process.env.ENVIRONMENT || 'unknown';

  // 1. Read settings — bail out early when disabled. This is the default
  //    state and avoids ANY DDB scan / write traffic when the operator
  //    has not opted in.
  const settings = await readSettings(env);
  if (!settings.enabled) {
    console.log(
      'governance-graph-snapshot: Snapshot skipped — disabled (settings.enabled=false)',
    );
    return { ok: true, snapshotId: null, reason: 'disabled' };
  }

  // 1b. Honor captureMode. Fail-closed: any value not in
  //     {daily, both} skips this scheduled handler. The on-change
  //     handler skips on the inverse condition, so unknown values
  //     correctly cause BOTH handlers to skip rather than both run.
  if (
    settings.captureMode !== 'daily' &&
    settings.captureMode !== 'both'
  ) {
    console.log(
      `governance-graph-snapshot: skipped — captureMode='${settings.captureMode}' (daily run not configured)`,
    );
    return { ok: true, snapshotId: null, reason: 'captureMode-skipped' };
  }

  // 2. Resolve env-var inputs. Missing destination table is fatal —
  //    the Lambda has no place to write the snapshot.
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

  // 3. Scan the four source tables in parallel — isolate failures.
  const tableEntries = Object.entries(sourceTables) as Array<
    [keyof typeof sourceTables, string]
  >;
  const settled = await Promise.allSettled(
    tableEntries.map(async ([key, tableName]) => {
      if (tableName.length === 0) {
        // Treat an unset env var as a failed read so the snapshot is
        // marked partial; mirrors per-table failure semantics.
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
        `governance-graph-snapshot: source-table read failed for "${key}": ${message}`,
      );
    }
  });

  // 4. All four tables failed — emit failure metric and throw so
  //    EventBridge surfaces the failed invocation.
  if (successfulTables === 0) {
    await emitMetric('Failure');
    throw new Error(
      'governance-graph-snapshot: all 4 source-table reads failed',
    );
  }

  const partial = successfulTables < tableEntries.length;
  const nowSec = Math.floor(Date.now() / 1000);
  const snapshot: SnapshotPayload = {
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
  };

  // 5. PutItem on the snapshots table. Failure here is fatal — the
  //    EventBridge invocation is marked failed and the operator's
  //    Citadel/Governance/GraphSnapshot/Count alarm fires.
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: snapshotsTable,
        Item: snapshot,
      }),
    );
  } catch (err) {
    await emitMetric('Failure', partial);
    throw err;
  }

  await emitMetric('Success', partial);
  console.log(
    `governance-graph-snapshot: wrote snapshot ${snapshot.snapshotId} (partial=${partial}, retention=${settings.retentionDays}d)`,
  );
  return { ok: true, snapshotId: snapshot.snapshotId, partial };
};

// Re-export for unit tests so the harness can call ScanCommand types
// from `@aws-sdk/client-dynamodb` if needed (kept available without
// risking unused-import lint errors).
export { RawScanCommand };
