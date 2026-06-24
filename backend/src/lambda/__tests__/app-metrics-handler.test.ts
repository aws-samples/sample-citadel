/**
 * Unit tests for metrics aggregation handler.
 *
 * Tests the pure aggregation functions extracted from the Lambda handler:
 * - parseAccessLogEntries: parses structured JSON access log entries
 * - groupByAppAndHour: groups entries by appId + hour bucket
 * - computeMetrics: computes counts and latency percentiles
 * - handler: full Lambda handler that stores metrics in DynamoDB
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.7
 */
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import {
  parseAccessLogEntries,
  groupByAppAndHour,
  computeMetrics,
  processMetricsEvent,
  type AccessLogEntry,
  type MetricsDeps,
} from '../app-metrics-handler';

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

// ── Helpers ─────────────────────────────────────────────────

const TEST_APP_ID = 'app-metrics-001';

function makeDeps(): MetricsDeps {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: 'citadel-apps-test',
  };
}

function makeLogEntry(overrides: Partial<AccessLogEntry> = {}): AccessLogEntry {
  return {
    requestId: 'req-001',
    appId: TEST_APP_ID,
    apiKeyId: 'key-001',
    status: 200,
    latency: 50,
    timestamp: '2024-06-15T10:30:00.000Z',
    ...overrides,
  };
}


// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

// ── parseAccessLogEntries Tests (Req 6.1) ───────────────────

describe('parseAccessLogEntries', () => {
  test('parses structured JSON access log entries correctly', () => {
    const messages = [
      JSON.stringify(makeLogEntry({ requestId: 'req-1', status: 200, latency: 30 })),
      JSON.stringify(makeLogEntry({ requestId: 'req-2', status: 404, latency: 15 })),
    ];

    const entries = parseAccessLogEntries(messages);

    expect(entries).toHaveLength(2);
    expect(entries[0].requestId).toBe('req-1');
    expect(entries[0].status).toBe(200);
    expect(entries[0].latency).toBe(30);
    expect(entries[1].requestId).toBe('req-2');
    expect(entries[1].status).toBe(404);
  });

  test('skips malformed log entries gracefully', () => {
    const messages = [
      JSON.stringify(makeLogEntry({ requestId: 'req-1' })),
      'not-valid-json',
      JSON.stringify(makeLogEntry({ requestId: 'req-3' })),
    ];

    const entries = parseAccessLogEntries(messages);

    expect(entries).toHaveLength(2);
    expect(entries[0].requestId).toBe('req-1');
    expect(entries[1].requestId).toBe('req-3');
  });

  test('skips entries missing required fields', () => {
    const messages = [
      JSON.stringify({ requestId: 'req-1', appId: TEST_APP_ID }), // missing status, latency, timestamp
      JSON.stringify(makeLogEntry({ requestId: 'req-2' })),
    ];

    const entries = parseAccessLogEntries(messages);

    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe('req-2');
  });
});

// ── groupByAppAndHour Tests (Req 6.1, 6.2) ─────────────────

describe('groupByAppAndHour', () => {
  test('groups entries by appId + hour bucket', () => {
    const entries: AccessLogEntry[] = [
      makeLogEntry({ appId: 'app-1', timestamp: '2024-06-15T10:15:00.000Z' }),
      makeLogEntry({ appId: 'app-1', timestamp: '2024-06-15T10:45:00.000Z' }),
      makeLogEntry({ appId: 'app-1', timestamp: '2024-06-15T11:05:00.000Z' }),
      makeLogEntry({ appId: 'app-2', timestamp: '2024-06-15T10:30:00.000Z' }),
    ];

    const groups = groupByAppAndHour(entries);

    expect(Object.keys(groups)).toHaveLength(3);
    expect(groups['app-1|2024-06-15-10']).toHaveLength(2);
    expect(groups['app-1|2024-06-15-11']).toHaveLength(1);
    expect(groups['app-2|2024-06-15-10']).toHaveLength(1);
  });

  test('handles entries from different days', () => {
    const entries: AccessLogEntry[] = [
      makeLogEntry({ appId: 'app-1', timestamp: '2024-06-15T23:30:00.000Z' }),
      makeLogEntry({ appId: 'app-1', timestamp: '2024-06-16T00:15:00.000Z' }),
    ];

    const groups = groupByAppAndHour(entries);

    expect(Object.keys(groups)).toHaveLength(2);
    expect(groups['app-1|2024-06-15-23']).toHaveLength(1);
    expect(groups['app-1|2024-06-16-00']).toHaveLength(1);
  });
});

// ── computeMetrics Tests (Req 6.2, 6.3) ────────────────────

describe('computeMetrics', () => {
  test('computes totalRequests, successCount, clientErrorCount, serverErrorCount', () => {
    const entries: AccessLogEntry[] = [
      makeLogEntry({ status: 200 }),
      makeLogEntry({ status: 201 }),
      makeLogEntry({ status: 400 }),
      makeLogEntry({ status: 404 }),
      makeLogEntry({ status: 500 }),
      makeLogEntry({ status: 302 }), // 3xx — not 2xx/4xx/5xx
    ];

    const metrics = computeMetrics(entries);

    expect(metrics.totalRequests).toBe(6);
    expect(metrics.successCount).toBe(2);
    expect(metrics.clientErrorCount).toBe(2);
    expect(metrics.serverErrorCount).toBe(1);
  });

  test('computes p50/p95/p99 latency percentiles', () => {
    // 100 entries with latencies 1..100
    const entries: AccessLogEntry[] = Array.from({ length: 100 }, (_, i) =>
      makeLogEntry({ status: 200, latency: i + 1, requestId: `req-${i}` }),
    );

    const metrics = computeMetrics(entries);

    expect(metrics.p50Latency).toBe(50);
    expect(metrics.p95Latency).toBe(95);
    expect(metrics.p99Latency).toBe(99);
  });

  test('handles single entry for percentiles', () => {
    const entries: AccessLogEntry[] = [makeLogEntry({ status: 200, latency: 42 })];

    const metrics = computeMetrics(entries);

    expect(metrics.p50Latency).toBe(42);
    expect(metrics.p95Latency).toBe(42);
    expect(metrics.p99Latency).toBe(42);
  });

  test('handles empty entries', () => {
    const metrics = computeMetrics([]);

    expect(metrics.totalRequests).toBe(0);
    expect(metrics.successCount).toBe(0);
    expect(metrics.clientErrorCount).toBe(0);
    expect(metrics.serverErrorCount).toBe(0);
    expect(metrics.p50Latency).toBe(0);
    expect(metrics.p95Latency).toBe(0);
    expect(metrics.p99Latency).toBe(0);
  });
});

// ── DynamoDB Storage Tests (Req 6.1, 6.2) ──────────────────

describe('processMetricsEvent', () => {
  test('stores as METRICS#{yyyy-MM-dd-HH} component items using ADD expressions', async () => {
    const entries: AccessLogEntry[] = [
      makeLogEntry({ appId: 'app-1', status: 200, latency: 50, timestamp: '2024-06-15T10:30:00.000Z', requestId: 'req-1' }),
      makeLogEntry({ appId: 'app-1', status: 404, latency: 20, timestamp: '2024-06-15T10:45:00.000Z', requestId: 'req-2' }),
    ];

    // No existing processed IDs
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});

    const deps = makeDeps();
    await processMetricsEvent(entries, deps);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    const call = updateCalls[0];
    const input = call.args[0].input;

    // Verify the key targets the correct METRICS# sortId
    expect(input.Key).toEqual({
      appId: 'app-1#METRICS#2024-06-15-10',
    });

    // Verify ADD expressions are used for atomic counters
    expect(input.UpdateExpression).toContain('ADD');
    expect(input.UpdateExpression).toContain('totalRequests');
  });

  test('idempotent — same log entries processed twice produce same result', async () => {
    const entries: AccessLogEntry[] = [
      makeLogEntry({ appId: 'app-1', status: 200, latency: 50, timestamp: '2024-06-15T10:30:00.000Z', requestId: 'req-1' }),
    ];

    // First call: no existing processed IDs
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});

    const deps = makeDeps();
    await processMetricsEvent(entries, deps);

    // Reset and simulate second call: req-1 already processed
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        appId: 'app-1#METRICS#2024-06-15-10',
        groupId: 'APP#app-1',
        sortId: 'METRICS#2024-06-15-10',
        processedLogIds: ['req-1'],
      }],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await processMetricsEvent(entries, deps);

    // Second call should not issue any UpdateCommands since all entries already processed
    const secondCallCount = ddbMock.commandCalls(UpdateCommand).length;
    expect(secondCallCount).toBe(0);
  });

  test('filters out already-processed log entries before aggregation', async () => {
    const entries: AccessLogEntry[] = [
      makeLogEntry({ appId: 'app-1', status: 200, latency: 50, timestamp: '2024-06-15T10:30:00.000Z', requestId: 'req-1' }),
      makeLogEntry({ appId: 'app-1', status: 500, latency: 100, timestamp: '2024-06-15T10:35:00.000Z', requestId: 'req-2' }),
    ];

    // req-1 already processed
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        appId: 'app-1#METRICS#2024-06-15-10',
        groupId: 'APP#app-1',
        sortId: 'METRICS#2024-06-15-10',
        processedLogIds: ['req-1'],
      }],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const deps = makeDeps();
    await processMetricsEvent(entries, deps);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);

    // Should only count req-2 (the new entry)
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':totalRequests']).toBe(1);
    expect(input.ExpressionAttributeValues![':serverErrorCount']).toBe(1);
  });
});

// ── getAppMetrics Query Handler Tests (Req 6.4, 6.5, 6.6) ──

import { getAppMetrics } from '../app-metrics-handler';

describe('getAppMetrics', () => {
  test('returns aggregated AppMetrics with timeSeries buckets within time range', async () => {
    const metricsItems = [
      {
        appId: 'app-1#METRICS#2024-06-15-10',
        groupId: 'APP#app-1',
        sortId: 'METRICS#2024-06-15-10',
        totalRequests: 100,
        successCount: 80,
        clientErrorCount: 15,
        serverErrorCount: 5,
        p50Latency: 30,
        p95Latency: 120,
        p99Latency: 250,
      },
      {
        appId: 'app-1#METRICS#2024-06-15-11',
        groupId: 'APP#app-1',
        sortId: 'METRICS#2024-06-15-11',
        totalRequests: 50,
        successCount: 45,
        clientErrorCount: 3,
        serverErrorCount: 2,
        p50Latency: 25,
        p95Latency: 100,
        p99Latency: 200,
      },
    ];

    ddbMock.on(QueryCommand).resolves({ Items: metricsItems });

    const deps = makeDeps();
    const result = await getAppMetrics(
      'app-1',
      '2024-06-15T10:00:00.000Z',
      '2024-06-15T12:00:00.000Z',
      deps,
    );

    // Aggregated totals
    expect(result.totalRequests).toBe(150);
    expect(result.successCount).toBe(125);
    expect(result.clientErrorCount).toBe(18);
    expect(result.serverErrorCount).toBe(7);

    // Weighted average latency percentiles
    expect(result.p50Latency).toBeCloseTo(28.33, 1);
    expect(result.p95Latency).toBeCloseTo(113.33, 1);
    expect(result.p99Latency).toBeCloseTo(233.33, 1);

    // TimeSeries buckets
    expect(result.timeSeries).toHaveLength(2);
    expect(result.timeSeries[0].timestamp).toBe('2024-06-15T10:00:00.000Z');
    expect(result.timeSeries[0].requestCount).toBe(100);
    expect(result.timeSeries[0].errorCount).toBe(20); // 15 + 5
    expect(result.timeSeries[0].avgLatency).toBe(30); // p50 as avg proxy

    expect(result.timeSeries[1].timestamp).toBe('2024-06-15T11:00:00.000Z');
    expect(result.timeSeries[1].requestCount).toBe(50);
    expect(result.timeSeries[1].errorCount).toBe(5); // 3 + 2
  });

  test('returns empty metrics when no data exists in time range', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const deps = makeDeps();
    const result = await getAppMetrics(
      'app-1',
      '2024-06-15T10:00:00.000Z',
      '2024-06-15T12:00:00.000Z',
      deps,
    );

    expect(result.totalRequests).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.clientErrorCount).toBe(0);
    expect(result.serverErrorCount).toBe(0);
    expect(result.p50Latency).toBe(0);
    expect(result.p95Latency).toBe(0);
    expect(result.p99Latency).toBe(0);
    expect(result.timeSeries).toEqual([]);
  });

  test('queries GroupIndex with correct key conditions for METRICS# range', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const deps = makeDeps();
    await getAppMetrics(
      'app-1',
      '2024-06-15T10:00:00.000Z',
      '2024-06-15T14:00:00.000Z',
      deps,
    );

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    // Find the query for METRICS# items via ExpressionAttributeValues
    const metricsQuery = queryCalls.find(c => {
      const vals = c.args[0].input.ExpressionAttributeValues;
      return vals && vals[':startSort'] && String(vals[':startSort']).startsWith('METRICS#');
    });
    expect(metricsQuery).toBeDefined();

    const input = metricsQuery!.args[0].input;
    expect(input.IndexName).toBe('GroupIndex');
    expect(input.ExpressionAttributeValues![':gid']).toBe('APP#app-1');
    expect(input.ExpressionAttributeValues![':startSort']).toBe('METRICS#2024-06-15-10');
    expect(input.ExpressionAttributeValues![':endSort']).toBe('METRICS#2024-06-15-14');
  });

  test('handles single metrics bucket correctly', async () => {
    const metricsItems = [
      {
        appId: 'app-1#METRICS#2024-06-15-10',
        groupId: 'APP#app-1',
        sortId: 'METRICS#2024-06-15-10',
        totalRequests: 42,
        successCount: 40,
        clientErrorCount: 1,
        serverErrorCount: 1,
        p50Latency: 15,
        p95Latency: 80,
        p99Latency: 150,
      },
    ];

    ddbMock.on(QueryCommand).resolves({ Items: metricsItems });

    const deps = makeDeps();
    const result = await getAppMetrics(
      'app-1',
      '2024-06-15T10:00:00.000Z',
      '2024-06-15T11:00:00.000Z',
      deps,
    );

    expect(result.totalRequests).toBe(42);
    expect(result.timeSeries).toHaveLength(1);
    expect(result.p50Latency).toBe(15);
    expect(result.p95Latency).toBe(80);
    expect(result.p99Latency).toBe(150);
  });
});
