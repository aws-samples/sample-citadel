/**
 * Property-based tests for metrics aggregation correctness (Property 13)
 *
 * **Validates: Requirements 6.2, 6.3, 6.7**
 *
 * For any set of access log entries:
 * - totalRequests equals count of entries
 * - successCount equals count of 2xx entries
 * - clientErrorCount equals count of 4xx entries
 * - serverErrorCount equals count of 5xx entries
 * - successCount + clientErrorCount + serverErrorCount <= totalRequests
 * - Processing same entries twice produces same result (idempotence)
 */
import * as fc from 'fast-check';
import {
  computeMetrics,
  parseAccessLogEntries,
  groupByAppAndHour,
  type AccessLogEntry,
} from '../app-metrics-handler';

// ── Generators ──────────────────────────────────────────────

/** Generates a valid HTTP status code */
const statusCodeArb = fc.oneof(
  fc.integer({ min: 200, max: 299 }), // 2xx
  fc.integer({ min: 300, max: 399 }), // 3xx
  fc.integer({ min: 400, max: 499 }), // 4xx
  fc.integer({ min: 500, max: 599 }), // 5xx
);

/** Generates a valid latency in ms (0 to 30000) */
const latencyArb = fc.integer({ min: 0, max: 30000 });

/** Generates a valid ISO 8601 timestamp within a reasonable range */
const timestampArb = fc.integer({ min: 1700000000000, max: 1750000000000 })
  .map(ms => new Date(ms).toISOString());

/** Generates a valid appId */
const appIdArb = fc.stringMatching(/^app-[a-z0-9]{3,10}$/);

/** Generates a single valid access log entry */
const accessLogEntryArb: fc.Arbitrary<AccessLogEntry> = fc.record({
  requestId: fc.uuid(),
  appId: appIdArb,
  apiKeyId: fc.uuid(),
  status: statusCodeArb,
  latency: latencyArb,
  timestamp: timestampArb,
});

/** Generates a list of access log entries (1 to 50) */
const accessLogEntriesArb = fc.array(accessLogEntryArb, { minLength: 1, maxLength: 50 });

// ── Property 13 Tests ───────────────────────────────────────

describe('Property 13: Metrics aggregation correctness', () => {

  /**
   * **Validates: Requirements 6.2**
   *
   * For any set of access log entries, totalRequests equals the count of entries.
   */
  it('totalRequests equals count of entries', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const metrics = computeMetrics(entries);
          expect(metrics.totalRequests).toBe(entries.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2, 6.3**
   *
   * For any set of access log entries, successCount equals the count of 2xx entries.
   */
  it('successCount equals count of 2xx status entries', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const metrics = computeMetrics(entries);
          const expected = entries.filter(e => e.status >= 200 && e.status < 300).length;
          expect(metrics.successCount).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2, 6.3**
   *
   * For any set of access log entries, clientErrorCount equals the count of 4xx entries.
   */
  it('clientErrorCount equals count of 4xx status entries', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const metrics = computeMetrics(entries);
          const expected = entries.filter(e => e.status >= 400 && e.status < 500).length;
          expect(metrics.clientErrorCount).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2, 6.3**
   *
   * For any set of access log entries, serverErrorCount equals the count of 5xx entries.
   */
  it('serverErrorCount equals count of 5xx status entries', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const metrics = computeMetrics(entries);
          const expected = entries.filter(e => e.status >= 500 && e.status < 600).length;
          expect(metrics.serverErrorCount).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2, 6.3**
   *
   * For any set of access log entries,
   * successCount + clientErrorCount + serverErrorCount <= totalRequests.
   * (3xx and 1xx codes are not counted in any category)
   */
  it('successCount + clientErrorCount + serverErrorCount <= totalRequests', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const metrics = computeMetrics(entries);
          expect(
            metrics.successCount + metrics.clientErrorCount + metrics.serverErrorCount,
          ).toBeLessThanOrEqual(metrics.totalRequests);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.7**
   *
   * Processing the same entries twice produces the same aggregated result (idempotence).
   */
  it('processing same entries twice produces identical metrics', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const first = computeMetrics(entries);
          const second = computeMetrics(entries);
          expect(first).toEqual(second);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * Latency percentiles are non-negative and p50 <= p95 <= p99.
   */
  it('latency percentiles are ordered: p50 <= p95 <= p99', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const metrics = computeMetrics(entries);
          expect(metrics.p50Latency).toBeGreaterThanOrEqual(0);
          expect(metrics.p95Latency).toBeGreaterThanOrEqual(metrics.p50Latency);
          expect(metrics.p99Latency).toBeGreaterThanOrEqual(metrics.p95Latency);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * parseAccessLogEntries round-trips: valid entries serialized to JSON and
   * parsed back produce the same entries.
   */
  it('parseAccessLogEntries correctly round-trips valid entries', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const messages = entries.map(e => JSON.stringify(e));
          const parsed = parseAccessLogEntries(messages);
          expect(parsed.length).toBe(entries.length);
          for (let i = 0; i < entries.length; i++) {
            expect(parsed[i].requestId).toBe(entries[i].requestId);
            expect(parsed[i].appId).toBe(entries[i].appId);
            expect(parsed[i].status).toBe(entries[i].status);
            expect(parsed[i].latency).toBe(entries[i].latency);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * groupByAppAndHour preserves all entries — total count across groups equals input count.
   */
  it('groupByAppAndHour preserves all entries across groups', () => {
    fc.assert(
      fc.property(
        accessLogEntriesArb,
        (entries) => {
          const groups = groupByAppAndHour(entries);
          const totalInGroups = Object.values(groups).reduce((sum, g) => sum + g.length, 0);
          expect(totalInGroups).toBe(entries.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
