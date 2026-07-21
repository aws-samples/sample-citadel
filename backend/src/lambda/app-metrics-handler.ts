/**
 * App Metrics Handler — Aggregates API Gateway access logs into per-app hourly metrics.
 *
 * Subscribes to CloudWatch Logs subscription filter for API Gateway access logs.
 * Parses structured JSON log entries, groups by appId + hour bucket,
 * computes counts and latency percentiles, and upserts METRICS#{yyyy-MM-dd-HH}
 * items using ADD expressions (atomic counters).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.7
 */
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { gunzipSync } from 'zlib';
import { computeCost, microUsdToUsd } from './cost-model';

// ── Types ───────────────────────────────────────────────────

export interface AccessLogEntry {
  requestId: string;
  appId: string;
  apiKeyId: string;
  status: number;
  latency: number;
  timestamp: string;
  /** LLM model id used to serve the request (optional; older logs omit it). */
  model?: string;
  /** Input/prompt tokens consumed (optional; defaults to 0 when absent). */
  inputTokens?: number;
  /** Output/completion tokens produced (optional; defaults to 0 when absent). */
  outputTokens?: number;
}

export interface AggregatedMetrics {
  totalRequests: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  /** Total input/prompt tokens across the entries. */
  totalInputTokens: number;
  /** Total output/completion tokens across the entries. */
  totalOutputTokens: number;
  /** Attributed cost in integer micro-USD (millionths of a dollar). */
  totalCostMicroUsd: number;
}

export interface MetricsDeps {
  docClient: DynamoDBDocumentClient;
  appsTable: string;
}

// ── Pure Functions ──────────────────────────────────────────

/**
 * Parses structured JSON access log messages into typed entries.
 * Skips malformed or incomplete entries gracefully.
 */
export function parseAccessLogEntries(messages: string[]): AccessLogEntry[] {
  const entries: AccessLogEntry[] = [];
  for (const msg of messages) {
    try {
      const parsed = JSON.parse(msg);
      if (
        typeof parsed.requestId === 'string' &&
        typeof parsed.appId === 'string' &&
        typeof parsed.status === 'number' &&
        typeof parsed.latency === 'number' &&
        typeof parsed.timestamp === 'string'
      ) {
        entries.push({
          requestId: parsed.requestId,
          appId: parsed.appId,
          apiKeyId: parsed.apiKeyId || 'unknown',
          status: parsed.status,
          latency: parsed.latency,
          timestamp: parsed.timestamp,
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
          inputTokens: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : undefined,
          outputTokens: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : undefined,
        });
      }
    } catch {
      // Skip malformed entries
    }
  }
  return entries;
}

/**
 * Groups access log entries by appId + hour bucket.
 * Key format: "{appId}|{yyyy-MM-dd-HH}"
 */
export function groupByAppAndHour(entries: AccessLogEntry[]): Record<string, AccessLogEntry[]> {
  const groups: Record<string, AccessLogEntry[]> = {};
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const hourBucket = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCHours()).padStart(2, '0')}`;
    const key = `${entry.appId}|${hourBucket}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(entry);
  }
  return groups;
}

/**
 * Computes a percentile value from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Computes aggregated metrics from a set of access log entries.
 * Pure function — no side effects.
 */
export function computeMetrics(entries: AccessLogEntry[]): AggregatedMetrics {
  if (entries.length === 0) {
    return {
      totalRequests: 0,
      successCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicroUsd: 0,
    };
  }

  let successCount = 0;
  let clientErrorCount = 0;
  let serverErrorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostMicroUsd = 0;
  const latencies: number[] = [];

  for (const entry of entries) {
    const statusClass = Math.floor(entry.status / 100);
    if (statusClass === 2) successCount++;
    else if (statusClass === 4) clientErrorCount++;
    else if (statusClass === 5) serverErrorCount++;
    latencies.push(entry.latency);

    const inTok = entry.inputTokens ?? 0;
    const outTok = entry.outputTokens ?? 0;
    totalInputTokens += inTok > 0 ? inTok : 0;
    totalOutputTokens += outTok > 0 ? outTok : 0;
    totalCostMicroUsd += computeCost(entry.model, inTok, outTok).costMicroUsd;
  }

  latencies.sort((a, b) => a - b);

  return {
    totalRequests: entries.length,
    successCount,
    clientErrorCount,
    serverErrorCount,
    p50Latency: percentile(latencies, 50),
    p95Latency: percentile(latencies, 95),
    p99Latency: percentile(latencies, 99),
    totalInputTokens,
    totalOutputTokens,
    totalCostMicroUsd,
  };
}

// ── DynamoDB Operations ─────────────────────────────────────

/**
 * Fetches already-processed log IDs for a given metrics bucket.
 */
async function getProcessedLogIds(
  appId: string,
  hourBucket: string,
  deps: MetricsDeps,
): Promise<Set<string>> {
  const result = await deps.docClient.send(new QueryCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid AND sortId = :sid',
    ExpressionAttributeValues: {
      ':gid': `APP#${appId}`,
      ':sid': `METRICS#${hourBucket}`,
    },
  }));

  const items = result.Items || [];
  if (items.length > 0 && Array.isArray(items[0].processedLogIds)) {
    return new Set(items[0].processedLogIds as string[]);
  }
  return new Set();
}

/**
 * Upserts a METRICS#{yyyy-MM-dd-HH} item using ADD expressions for atomic counters.
 * Appends new log IDs to processedLogIds for idempotency tracking.
 */
async function upsertMetrics(
  appId: string,
  hourBucket: string,
  metrics: AggregatedMetrics,
  newLogIds: string[],
  deps: MetricsDeps,
): Promise<void> {
  await deps.docClient.send(new UpdateCommand({
    TableName: deps.appsTable,
    Key: {
      appId: `${appId}#METRICS#${hourBucket}`,
    },
    UpdateExpression: `
      ADD totalRequests :totalRequests,
          successCount :successCount,
          clientErrorCount :clientErrorCount,
          serverErrorCount :serverErrorCount,
          totalInputTokens :totalInputTokens,
          totalOutputTokens :totalOutputTokens,
          totalCostMicroUsd :totalCostMicroUsd
      SET groupId = :groupId,
          sortId = :sortId,
          p50Latency = :p50Latency,
          p95Latency = :p95Latency,
          p99Latency = :p99Latency,
          processedLogIds = list_append(if_not_exists(processedLogIds, :emptyList), :newLogIds),
          updatedAt = :now
    `,
    ExpressionAttributeValues: {
      ':totalRequests': metrics.totalRequests,
      ':successCount': metrics.successCount,
      ':clientErrorCount': metrics.clientErrorCount,
      ':serverErrorCount': metrics.serverErrorCount,
      ':totalInputTokens': metrics.totalInputTokens,
      ':totalOutputTokens': metrics.totalOutputTokens,
      ':totalCostMicroUsd': metrics.totalCostMicroUsd,
      ':groupId': `APP#${appId}`,
      ':sortId': `METRICS#${hourBucket}`,
      ':p50Latency': metrics.p50Latency,
      ':p95Latency': metrics.p95Latency,
      ':p99Latency': metrics.p99Latency,
      ':newLogIds': newLogIds,
      ':emptyList': [],
      ':now': new Date().toISOString(),
    },
  }));
}

/**
 * Processes a batch of access log entries: groups, filters already-processed,
 * computes metrics, and upserts to DynamoDB.
 */
export async function processMetricsEvent(
  entries: AccessLogEntry[],
  deps: MetricsDeps,
): Promise<void> {
  const groups = groupByAppAndHour(entries);

  for (const [key, groupEntries] of Object.entries(groups)) {
    const [appId, hourBucket] = key.split('|');

    // Fetch already-processed log IDs for idempotency
    const processedIds = await getProcessedLogIds(appId, hourBucket, deps);

    // Filter out already-processed entries
    const newEntries = groupEntries.filter(e => !processedIds.has(e.requestId));

    if (newEntries.length === 0) continue;

    const metrics = computeMetrics(newEntries);
    const newLogIds = newEntries.map(e => e.requestId);

    await upsertMetrics(appId, hourBucket, metrics, newLogIds, deps);
  }
}

// ── Query Handler ───────────────────────────────────────────

export interface AppMetricsResult {
  totalRequests: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  /** Total input/prompt tokens over the queried range. */
  totalInputTokens: number;
  /** Total output/completion tokens over the queried range. */
  totalOutputTokens: number;
  /** Attributed cost over the queried range, in USD. */
  totalCostUsd: number;
  timeSeries: AppMetricsBucket[];
}

export interface AppMetricsBucket {
  timestamp: string;
  requestCount: number;
  errorCount: number;
  avgLatency: number;
  /** Input/prompt tokens in this bucket. */
  inputTokens: number;
  /** Output/completion tokens in this bucket. */
  outputTokens: number;
  /** Attributed cost for this bucket, in USD. */
  costUsd: number;
}

/**
 * Converts an ISO 8601 timestamp to an hour bucket string (yyyy-MM-dd-HH).
 */
function toHourBucket(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCHours()).padStart(2, '0')}`;
}

/**
 * Converts an hour bucket string (yyyy-MM-dd-HH) to an ISO 8601 timestamp.
 */
function hourBucketToTimestamp(bucket: string): string {
  const [year, month, day, hour] = bucket.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour)).toISOString();
}

/**
 * Queries METRICS# items within a time range and aggregates into AppMetrics response.
 *
 * Requirements: 6.4, 6.5, 6.6
 */
export async function getAppMetrics(
  appId: string,
  startTime: string,
  endTime: string,
  deps: MetricsDeps,
): Promise<AppMetricsResult> {
  const startBucket = toHourBucket(startTime);
  const endBucket = toHourBucket(endTime);

  const result = await deps.docClient.send(new QueryCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid AND sortId BETWEEN :startSort AND :endSort',
    ExpressionAttributeValues: {
      ':gid': `APP#${appId}`,
      ':startSort': `METRICS#${startBucket}`,
      ':endSort': `METRICS#${endBucket}`,
    },
  }));

  const items = result.Items || [];

  if (items.length === 0) {
    return {
      totalRequests: 0,
      successCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      timeSeries: [],
    };
  }

  let totalRequests = 0;
  let successCount = 0;
  let clientErrorCount = 0;
  let serverErrorCount = 0;
  let weightedP50 = 0;
  let weightedP95 = 0;
  let weightedP99 = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostMicroUsd = 0;

  const timeSeries: AppMetricsBucket[] = [];

  for (const item of items) {
    const bucketRequests = item.totalRequests || 0;
    totalRequests += bucketRequests;
    successCount += item.successCount || 0;
    clientErrorCount += item.clientErrorCount || 0;
    serverErrorCount += item.serverErrorCount || 0;
    weightedP50 += (item.p50Latency || 0) * bucketRequests;
    weightedP95 += (item.p95Latency || 0) * bucketRequests;
    weightedP99 += (item.p99Latency || 0) * bucketRequests;

    const bucketInputTokens = item.totalInputTokens || 0;
    const bucketOutputTokens = item.totalOutputTokens || 0;
    const bucketCostMicroUsd = item.totalCostMicroUsd || 0;
    totalInputTokens += bucketInputTokens;
    totalOutputTokens += bucketOutputTokens;
    totalCostMicroUsd += bucketCostMicroUsd;

    // Extract hour bucket from sortId: "METRICS#yyyy-MM-dd-HH"
    const bucket = item.sortId.replace('METRICS#', '');
    timeSeries.push({
      timestamp: hourBucketToTimestamp(bucket),
      requestCount: bucketRequests,
      errorCount: (item.clientErrorCount || 0) + (item.serverErrorCount || 0),
      avgLatency: item.p50Latency || 0,
      inputTokens: bucketInputTokens,
      outputTokens: bucketOutputTokens,
      costUsd: microUsdToUsd(bucketCostMicroUsd),
    });
  }

  return {
    totalRequests,
    successCount,
    clientErrorCount,
    serverErrorCount,
    p50Latency: totalRequests > 0 ? weightedP50 / totalRequests : 0,
    p95Latency: totalRequests > 0 ? weightedP95 / totalRequests : 0,
    p99Latency: totalRequests > 0 ? weightedP99 / totalRequests : 0,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: microUsdToUsd(totalCostMicroUsd),
    timeSeries,
  };
}

// ── Dashboard Metrics (cross-app aggregation) ───────────────

export interface DashboardMetricsResult {
  dailyActivity: Array<{ date: string; successCount: number; errorCount: number }>;
  totalRequests: number;
  successRate: number;
  avgLatency: number;
}

export async function getDashboardMetrics(
  orgId: string,
  startTime: string,
  endTime: string,
  deps: MetricsDeps,
): Promise<DashboardMetricsResult> {
  const startBucket = toHourBucket(startTime);
  const endBucket = toHourBucket(endTime);

  const result = await deps.docClient.send(new ScanCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    FilterExpression: 'begins_with(groupId, :appPrefix) AND sortId BETWEEN :startSort AND :endSort',
    ExpressionAttributeValues: {
      ':appPrefix': 'APP#',
      ':startSort': `METRICS#${startBucket}`,
      ':endSort': `METRICS#${endBucket}`,
    },
  }));

  const items = result.Items || [];

  if (items.length === 0) {
    return { dailyActivity: [], totalRequests: 0, successRate: 0, avgLatency: 0 };
  }

  const dayMap = new Map<string, { successCount: number; errorCount: number }>();
  let totalRequests = 0;
  let totalSuccess = 0;
  let weightedLatencySum = 0;

  for (const item of items) {
    const bucket = (item.sortId as string).replace('METRICS#', '');
    const day = bucket.substring(0, 10);
    const requests = (item.totalRequests as number) || 0;
    const success = (item.successCount as number) || 0;
    const errors = ((item.clientErrorCount as number) || 0) + ((item.serverErrorCount as number) || 0);
    const latency = (item.p50Latency as number) || 0;

    totalRequests += requests;
    totalSuccess += success;
    weightedLatencySum += latency * requests;

    const existing = dayMap.get(day) || { successCount: 0, errorCount: 0 };
    existing.successCount += success;
    existing.errorCount += errors;
    dayMap.set(day, existing);
  }

  const dailyActivity = Array.from(dayMap.entries())
    .map(([date, data]) => ({ date, successCount: data.successCount, errorCount: data.errorCount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    dailyActivity,
    totalRequests,
    successRate: totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 0,
    avgLatency: totalRequests > 0 ? weightedLatencySum / totalRequests : 0,
  };
}

// ── Lambda Handler ──────────────────────────────────────────

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** CloudWatch Logs subscription event shape. */
interface LogsSubscriptionEvent {
  awslogs: { data: string };
}

export const handler = async (event: LogsSubscriptionEvent): Promise<void> => {
  const appsTable = process.env.APPS_TABLE!;
  const deps: MetricsDeps = { docClient, appsTable };

  // CloudWatch Logs subscription filter delivers base64-encoded gzipped data
  const payload = Buffer.from(event.awslogs.data, 'base64');
  const decompressed = gunzipSync(payload);
  const logData = JSON.parse(decompressed.toString());

  const messages: string[] = logData.logEvents.map((e: { message: string }) => e.message);
  const entries = parseAccessLogEntries(messages);

  await processMetricsEvent(entries, deps);
};
