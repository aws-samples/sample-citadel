/**
 * Tests for spans-waterfall.ts — Logs Insights `aws/spans` rows ->
 * `TraceEntry[]`/`TraceSpan[]` shaping (design §2 "aws/spans -> TraceEntry/
 * TraceSpan mapping", §8 "spans-waterfall.test.ts").
 *
 * SCHEMA VERIFIED (evidence report, finding a3d8a2ea): fixtures below are
 * built from the VERBATIM real span/subsegment events captured against
 * `aws/spans` (2026-08-03 archived sample + 2026-08-14 fresh samples),
 * already flattened the way spans-query.ts's flatten() would produce from
 * the real nested JSON `@message` body. Structure is kept intact; PII
 * (user-agent/IP) is [REDACTED]. See spans-waterfall.ts's module header
 * for the field-name corrections this fixture set encodes.
 */
import { shapeSpanRows, type SpanQueryRowLike } from "../spans-waterfall";

function row(fields: Partial<SpanQueryRowLike>): SpanQueryRowLike {
  return fields as SpanQueryRowLike;
}

describe("shapeSpanRows — tree building", () => {
  test("root segment with one subsegment child -> nested children[], same TraceEntry/TraceSpan shape as xray-waterfall", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "6a700e664c404f251827e0c81544e084",
        spanId: "edcde8a7f824252d",
        name: "citadel-document-ingest-poller-dev/LambdaExecutionEnvironment",
        startTimeUnixNano: "1785728614687603968",
        endTimeUnixNano: "1785728614718127104",
        "status.code": "UNSET",
        "_aws.xray.name": "citadel-document-ingest-poller-dev",
        "_aws.xray.type": "segment",
      }),
      row({
        traceId: "6a700e664c404f251827e0c81544e084",
        spanId: "144ee6e12cda94ee",
        parentSpanId: "edcde8a7f824252d",
        name: "",
        startTimeUnixNano: "1785728614690000000",
        endTimeUnixNano: "1785728614710000000",
        "status.code": "UNSET",
        "_aws.xray.name": "Attempt #1",
        "_aws.xray.type": "subsegment",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces).toHaveLength(1);
    const entry = shaped.traces[0];
    expect(entry.traceId).toBe("6a700e664c404f251827e0c81544e084");
    expect(entry.spans).toHaveLength(1);
    expect(entry.spans[0].id).toBe("edcde8a7f824252d");
    expect(entry.spans[0].parentId).toBeNull();
    expect(entry.spans[0].children).toHaveLength(1);
    expect(entry.spans[0].children[0].id).toBe("144ee6e12cda94ee");
    expect(entry.spans[0].children[0].parentId).toBe("edcde8a7f824252d");
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

describe("shapeSpanRows — dedup of in-progress snapshot vs completed event (finding a3d8a2ea #5)", () => {
  test("same spanId as in-progress snapshot (no endTimeUnixNano, aws.xray.inprogress) and completed event -> completed wins, no duplicate tree node", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "6a7e5de027c150316d0ff197004e14b1",
        spanId: "021348f2ab124f06",
        name: "PopObservability-dev-CanaryFnEAA4AF84-rA1uxPLOe98U/LambdaService",
        startTimeUnixNano: "1786666464924999936",
        // in-progress snapshot: no endTimeUnixNano
        "attributes.aws.xray.inprogress": "true",
        "status.code": "UNSET",
        "_aws.xray.name": "PopObservability-dev-CanaryFnEAA4AF84-rA1uxPLOe98U",
        "_aws.xray.type": "segment",
      }),
      row({
        traceId: "6a7e5de027c150316d0ff197004e14b1",
        spanId: "021348f2ab124f06",
        name: "PopObservability-dev-CanaryFnEAA4AF84-rA1uxPLOe98U/LambdaService",
        startTimeUnixNano: "1786666464924999936",
        endTimeUnixNano: "1786666467263000064",
        "status.code": "UNSET",
        "_aws.xray.name": "PopObservability-dev-CanaryFnEAA4AF84-rA1uxPLOe98U",
        "_aws.xray.type": "segment",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces).toHaveLength(1);
    expect(shaped.traces[0].spans).toHaveLength(1);
    const span = shaped.traces[0].spans[0];
    expect(span.id).toBe("021348f2ab124f06");
    expect(span.inProgress).toBe(false);
    expect(span.endTime).not.toBeNull();
  });

  test("two in-progress snapshots of the same spanId, no completed event yet -> keeps the latest snapshot, still one tree node", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-dup",
        spanId: "span-dup",
        name: "snapshot-1",
        startTimeUnixNano: "1000000000000",
        "attributes.aws.xray.inprogress": "true",
      }),
      row({
        traceId: "trace-dup",
        spanId: "span-dup",
        name: "snapshot-2",
        startTimeUnixNano: "1000000000000",
        "attributes.aws.xray.inprogress": "true",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans).toHaveLength(1);
    expect(shaped.traces[0].spans[0].name).toBe("snapshot-2");
    expect(shaped.traces[0].spans[0].inProgress).toBe(true);
  });

  test("dedup applies across parent+child pairs without breaking tree assembly", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-tree-dedup",
        spanId: "root-1",
        name: "root",
        startTimeUnixNano: "1000000000000",
        "attributes.aws.xray.inprogress": "true",
      }),
      row({
        traceId: "trace-tree-dedup",
        spanId: "root-1",
        name: "root",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1005000000000",
      }),
      row({
        traceId: "trace-tree-dedup",
        spanId: "child-1",
        parentSpanId: "root-1",
        name: "",
        startTimeUnixNano: "1001000000000",
        endTimeUnixNano: "1002000000000",
        "_aws.xray.name": "Attempt #1",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans).toHaveLength(1);
    expect(shaped.traces[0].spans[0].children).toHaveLength(1);
    expect(shaped.traces[0].spans[0].inProgress).toBe(false);
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

  test("http status mapped from attributes.http.response.status_code, fallback attributes.http.status_code (attributes-prefixed, finding a3d8a2ea #7/#8)", () => {
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
        // fallback key is attributes-prefixed, per the real subsegment
        // sample (attributes.http.status_code), NOT bare http.status_code
        "attributes.http.status_code": "429",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].http).toEqual({ status: 500 });
    expect(shaped.traces[1].spans[0].http).toEqual({ status: 429 });
  });

  test("a bare (non-attributes-prefixed) http.status_code fallback key is NOT honored (negative case for #7)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-bare-http",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "http.status_code": "429",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].http).toBeNull();
  });

  test("subsegment name falls back to _aws.xray.name when top-level name is empty (finding a3d8a2ea #6)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-subseg-name",
        spanId: "s1",
        name: "",
        startTimeUnixNano: "1786666464967000064",
        endTimeUnixNano: "1786666467263000064",
        "_aws.xray.name": "Attempt #1",
        "_aws.xray.type": "subsegment",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].name).toBe("Attempt #1");
  });

  test("namespace mapped from _aws.xray.namespace, not attributes.namespace (finding a3d8a2ea #6/#11)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-ns",
        spanId: "s1",
        name: "partner-offering-api-dev",
        startTimeUnixNano: "1786666467044000000",
        endTimeUnixNano: "1786666467046999808",
        "_aws.xray.namespace": "aws",
        "attributes.namespace": "should-be-ignored",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].namespace).toBe("aws");
  });

  test("annotations extracted from attributes.<key> enumerated by attributes.aws.xray.annotation_keys, not an annotation. prefix (finding a3d8a2ea #7)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "trace-1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "attributes.aws.xray.annotation_keys": JSON.stringify([
          "correlation_id",
          "run_id",
        ]),
        "attributes.correlation_id": "exec-1",
        "attributes.run_id": "run-1",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].annotations.correlation_id).toBe("exec-1");
    expect(shaped.traces[0].annotations.run_id).toBe("run-1");
  });

  test("real AppSync annotation_keys sample (request_id) extracts via the array, an annotation.* prefixed field is ignored (negative case)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "6a7e5de3482f491c1277d50434df3636",
        spanId: "5a075ffebf0c12fe",
        name: "POST /graphql",
        startTimeUnixNano: "1786666467044000000",
        endTimeUnixNano: "1786666467046999808",
        "attributes.aws.xray.annotation_keys": JSON.stringify(["request_id"]),
        "attributes.request_id": "d1edb09a-360f-4075-9876-d1ffbcbbec97",
        // Should NOT be picked up — annotation. prefix does not exist on
        // the real schema and must not be treated as a source.
        "annotation.request_id": "wrong-shape-should-be-ignored",
      }),
    ];

    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].annotations.request_id).toBe(
      "d1edb09a-360f-4075-9876-d1ffbcbbec97",
    );
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
  test("status.code=ERROR + http>=500 -> fault", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "status.code": "ERROR",
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

  test("real ERROR AppSync 401 sample: status.code=ERROR, http=401 -> error (not fault, not ok) — finding a3d8a2ea #5", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "6a7e5de3482f491c1277d50434df3636",
        spanId: "5a075ffebf0c12fe",
        name: "POST /graphql",
        startTimeUnixNano: "1786666467044000000",
        endTimeUnixNano: "1786666467046999808",
        "status.code": "ERROR",
        "attributes.http.response.status_code": "401",
        "attributes.aws.xray.error": "true",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].status).toBe("error");
    expect(shaped.traces[0].hasError).toBe(true);
    expect(shaped.traces[0].hasFault).toBe(false);
  });

  test("a bare (non-flattened) statusCode:'ERROR' field is NOT honored — must be status.code (negative case for #4)", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t-bare-status",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        statusCode: "ERROR",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].status).toBe("ok");
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

describe("shapeSpanRows — error/exception message (finding a3d8a2ea #8)", () => {
  test("_aws.xray.cause.message fallback surfaces the real ERROR span's cause text when attributes.exception.* is absent", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "6a7e5de3482f491c1277d50434df3636",
        spanId: "5a075ffebf0c12fe",
        name: "POST /graphql",
        startTimeUnixNano: "1786666467044000000",
        endTimeUnixNano: "1786666467046999808",
        "status.code": "ERROR",
        "_aws.xray.cause.message": "Valid authorization header not provided.",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].error).toEqual({
      type: "Error",
      message: "Valid authorization header not provided.",
    });
  });

  test("attributes.exception.message still takes priority over _aws.xray.cause.message when both are present", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "attributes.exception.message": "otel exception message",
        "attributes.exception.type": "CustomError",
        "_aws.xray.cause.message": "xray cause message",
      }),
    ];
    const shaped = shapeSpanRows(rows, { includeMetadata: false });
    expect(shaped.traces[0].spans[0].error).toEqual({
      type: "CustomError",
      message: "otel exception message",
    });
  });

  test("neither key present -> error null", () => {
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
    expect(shaped.traces[0].spans[0].error).toBeNull();
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

  test("a row with a malformed attributes.aws.xray.annotation_keys value (not JSON array) is skipped for annotation extraction, never throws", () => {
    const rows: SpanQueryRowLike[] = [
      row({
        traceId: "t1",
        spanId: "s1",
        name: "op",
        startTimeUnixNano: "1000000000000",
        endTimeUnixNano: "1001000000000",
        "attributes.aws.xray.annotation_keys": "{not valid json",
      }),
    ];
    expect(() => shapeSpanRows(rows, { includeMetadata: false })).not.toThrow();
    expect(
      shapeSpanRows(rows, { includeMetadata: false }).traces[0].annotations,
    ).toEqual({});
  });

  test("empty rows array -> empty traces, never throws", () => {
    expect(() => shapeSpanRows([], { includeMetadata: false })).not.toThrow();
    expect(shapeSpanRows([], { includeMetadata: false }).traces).toHaveLength(
      0,
    );
  });
});
