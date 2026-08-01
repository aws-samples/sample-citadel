/**
 * Tests for spans-waterfall.ts — Logs Insights `aws/spans` rows ->
 * `TraceEntry[]`/`TraceSpan[]` shaping (design §2 "aws/spans -> TraceEntry/
 * TraceSpan mapping", §8 "spans-waterfall.test.ts").
 *
 * SCHEMA-VERIFICATION GATE (design §2, HIGH risk #1): the exact aws/spans
 * field names used below are a captured Red-phase FIXTURE, not a verified
 * real-account sample — spans-waterfall.ts itself carries the same
 * unverified-schema comment at every field-name assumption. This fixture
 * exists so the shaping/tree-building/allowlist LOGIC has test coverage
 * now; the field names must be reconciled against a real Transaction
 * Search span the first time TRACE_BACKEND=spans is exercised against a
 * live account (see docs/TRACING_RUNBOOK.md cutover procedure).
 */
import { shapeSpanRows, type SpanQueryRowLike } from "../spans-waterfall";

function row(fields: Partial<SpanQueryRowLike>): SpanQueryRowLike {
  return fields as SpanQueryRowLike;
}

describe("shapeSpanRows — tree building", () => {
  test("root span with one child -> nested children[], same TraceEntry/TraceSpan shape as xray-waterfall", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "1-5f84c7c1-000000000000000000000001",
        spanId: "root-1",
        parentSpanId: undefined,
        name: "root-op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1002000000000",
        "annotation.correlation_id": "exec-1",
      }),
      row({
        traceId: "1-5f84c7c1-000000000000000000000001",
        spanId: "child-1",
        parentSpanId: "root-1",
        name: "child-op",
        startTimeUnixNano: "1000500000000",
        endTimeUnixNano: "1001000000000",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces).toHaveLength(1);
    const entry = shaped.traces[0];
    expect(entry.traceId).toBe("1-5f84c7c1-000000000000000000000001");
    expect(entry.spans).toHaveLength(1);
    expect(entry.spans[0].id).toBe("root-1");
    expect(entry.spans[0].parentId).toBeNull();
    expect(entry.spans[0].children).toHaveLength(1);
    expect(entry.spans[0].children[0].id).toBe("child-1");
    expect(entry.spans[0].children[0].parentId).toBe("root-1");
  });

  test("a row whose parentSpanId is not in the set is treated as a root (orphan-safe)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-orphan",
        spanId: "span-a",
        parentSpanId: "missing-parent",
        name: "op-a",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans).toHaveLength(1);
    expect(shaped.traces[0].spans[0].id).toBe("span-a");
  });

  test("multiple traceIds group into separate TraceEntry objects, sorted by startTime", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-later",
        spanId: "s1",
        startTimeUnixNano: "2000000000000",
        endTimeUnixNano: "2001000000000",
        name: "later",
      }),
      row({
        traceId: "trace-earlier",
        spanId: "s2",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        name: "earlier",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces.map((t) => t.traceId)).toEqual([
      "trace-earlier",
      "trace-later",
    ]);
  });
});

describe("shapeSpanRows — field mapping", () => {
  test("startTimeUnixNano/endTimeUnixNano map to epoch-seconds startTime/endTime, durationMs computed", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000", // 1000s
        endTimeUnixNano: "1002500000000", // 1002.5s
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    const span = shaped.traces[0].spans[0];
    expect(span.startTime).toBe(1000);
    expect(span.endTime).toBe(1002.5);
    expect(span.durationMs).toBe(2500);
  });

  test("missing endTimeUnixNano -> inProgress:true, endTime null, durationMs 0", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    const span = shaped.traces[0].spans[0];
    expect(span.inProgress).toBe(true);
    expect(span.endTime).toBeNull();
    expect(span.durationMs).toBe(0);
  });

  test("http status mapped from attributes.http.response.status_code fallback http.status_code", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "attributes.http.response.status_code": "500",
      }),
      row({
        traceId: "trace-2",
        spanId: "s2",
        name: "op2",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "http.status_code": "429",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].http).toEqual({ status: 500 });
    expect(shaped.traces[1].spans[0].http).toEqual({ status: 429 });
  });

  test("annotation.* attributes surface on TraceEntry.annotations, pinned correlation_id/run_id keys survive", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "annotation.correlation_id": "exec-1",
        "annotation.run_id": "run-1",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].annotations.correlation_id).toBe("exec-1");
    expect(shaped.traces[0].annotations.run_id).toBe("run-1");
  });

  test("metadata/aws/sql dropped by default, present only with includeMetadata:true (allowlist invariant 5)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "attributes.aws.table_name": "some-table",
      }),
    ];

    const withoutMeta = shapeSpanRows(rows, { includeMetadata: false });
    expect(withoutMeta.traces[0].spans[0].aws).toBeUndefined();

    const withMeta = shapeSpanRows(rows, { includeMetadata: true });
    expect(withMeta.traces[0].spans[0].aws).toBeDefined();
  });
});

describe("shapeSpanRows — status trichotomy (best-effort OTel -> ok|error|fault|throttle)", () => {
  test("ERROR + http>=500 -> fault", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        statusCode: "ERROR",
        "attributes.http.response.status_code": "503",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].status).toBe("fault");
    expect(shaped.traces[0].hasFault).toBe(true);
  });

  test("http==429 -> throttle", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "attributes.http.response.status_code": "429",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].status).toBe("throttle");
    expect(shaped.traces[0].hasThrottle).toBe(true);
  });

  test("ERROR without 5xx/429 -> error", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        statusCode: "ERROR",
        "attributes.http.response.status_code": "400",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].status).toBe("error");
    expect(shaped.traces[0].hasError).toBe(true);
  });

  test("no error signal -> ok", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].status).toBe("ok");
  });
});

describe("shapeSpanRows — malformed rows never throw (invariant-4 analog)", () => {
  test("a row missing spanId is skipped entirely", () => {
    const rows: SpanQueryRowLike[] = [
      row({ traceId: "t1", name: "no-span-id" }),
      row({
        traceId: "t1",
        spanId: "s-valid",
        name: "valid",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
      }),
    ];
    expect(() => shapeSpanRows(rows, { includeMetadata: false })).not.toThrow();
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans).toHaveLength(1);
    expect(shaped.traces[0].spans[0].id).toBe("s-valid");
  });

  test("a row missing traceId is skipped entirely, never throws", () => {
    const rows: SpanQueryRowLike[] = [
      row({ spanId: "orphan-no-trace", name: "x" }),
    ];
    expect(() => shapeSpanRows(rows, { includeMetadata: false })).not.toThrow();
    expect(shapeSpanRows(rows, { includeMetadata: false }).traces).toHaveLength(
      0,
    );
  });

  test("empty rows array -> empty traces, never throws", () => {
    expect(() => shapeSpanRows([], { includeMetadata: false })).not.toThrow();
    expect(shapeSpanRows([], { includeMetadata: false }).traces).toHaveLength(
      0,
    );
  });
});
