/**
 * Tests for xray-waterfall.ts — pure Trace[] -> TraceWaterfallResponse
 * transform (design §3 "X-RAY PARSING NOTES"). No AWS SDK imports; callers
 * pass already-fetched `BatchGetTraces` `Trace[]` items in.
 *
 * Covers invariant 4 (segment-Document parsing never throws — malformed
 * segments are skipped) and invariant 5 (response is field-allowlisted;
 * raw metadata/aws/sql bags dropped unless admin+includeMetadata).
 */
import { shapeTraces, type XRayTraceLike } from "../xray-waterfall";

function seg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "1111111111111111",
    name: "citadel-stepRunner-prod",
    trace_id: "1-5f84c7c1-000000000000000000000001",
    start_time: 1785000000.0,
    end_time: 1785000000.12,
    ...overrides,
  });
}

function trace(id: string, segments: string[]): XRayTraceLike {
  return {
    Id: id,
    Duration: 2.23,
    Segments: segments.map((doc) => ({ Document: doc })),
  };
}

describe("shapeTraces — defensive segment-Document parsing (invariant 4)", () => {
  test("malformed JSON Document is skipped, never throws", () => {
    const traces = [trace("1-a", [seg(), "{not json"])];
    expect(() => shapeTraces(traces, { includeMetadata: false })).not.toThrow();
    const result = shapeTraces(traces, { includeMetadata: false });
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0].spans).toHaveLength(1);
  });

  test("missing Document field is skipped, never throws", () => {
    const traces: XRayTraceLike[] = [
      {
        Id: "1-b",
        Duration: 1,
        Segments: [{ Document: undefined }, { Document: seg() }],
      },
    ];
    expect(() => shapeTraces(traces, { includeMetadata: false })).not.toThrow();
    const result = shapeTraces(traces, { includeMetadata: false });
    expect(result.traces[0].spans).toHaveLength(1);
  });

  test("a trace with zero parseable segments still returns an entry with an empty span list", () => {
    const traces = [trace("1-c", ["not json at all"])];
    const result = shapeTraces(traces, { includeMetadata: false });
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0].spans).toEqual([]);
  });
});

describe("shapeTraces — tree building", () => {
  test("nested subsegments build a parent/children tree via parent_id", () => {
    const root = seg({
      id: "aaaaaaaaaaaaaaaa",
      start_time: 1785000000.0,
      end_time: 1785000002.0,
    });
    const child = seg({
      id: "bbbbbbbbbbbbbbbb",
      parent_id: "aaaaaaaaaaaaaaaa",
      start_time: 1785000000.5,
      end_time: 1785000001.0,
      name: "child-call",
    });
    const traces = [trace("1-d", [root, child])];
    const result = shapeTraces(traces, { includeMetadata: false });

    expect(result.traces[0].spans).toHaveLength(1);
    const rootSpan = result.traces[0].spans[0];
    expect(rootSpan.id).toBe("aaaaaaaaaaaaaaaa");
    expect(rootSpan.children).toHaveLength(1);
    expect(rootSpan.children[0].id).toBe("bbbbbbbbbbbbbbbb");
    expect(rootSpan.children[0].name).toBe("child-call");
  });

  test("startOffsetMs is computed relative to the min start time across the trace", () => {
    const root = seg({
      id: "cccccccccccccccc",
      start_time: 1785000000.0,
      end_time: 1785000002.0,
    });
    const child = seg({
      id: "dddddddddddddddd",
      parent_id: "cccccccccccccccc",
      start_time: 1785000000.5,
      end_time: 1785000001.0,
    });
    const traces = [trace("1-e", [root, child])];
    const result = shapeTraces(traces, { includeMetadata: false });

    const rootSpan = result.traces[0].spans[0];
    expect(rootSpan.startOffsetMs).toBe(0);
    expect(rootSpan.children[0].startOffsetMs).toBe(500);
  });

  test("a segment whose parent_id has no in-set match becomes a trace root itself", () => {
    const orphan = seg({
      id: "eeeeeeeeeeeeeeee",
      parent_id: "not-in-this-trace",
    });
    const traces = [trace("1-f", [orphan])];
    const result = shapeTraces(traces, { includeMetadata: false });
    expect(result.traces[0].spans).toHaveLength(1);
    expect(result.traces[0].spans[0].id).toBe("eeeeeeeeeeeeeeee");
  });
});

describe("shapeTraces — status precedence: fault > error > throttle > ok", () => {
  test("fault takes precedence over error and throttle on the same span", () => {
    const s = seg({
      id: "1111111111111112",
      error: true,
      fault: true,
      throttle: true,
    });
    const result = shapeTraces([trace("1-g", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].status).toBe("fault");
  });

  test("error takes precedence over throttle when fault is absent", () => {
    const s = seg({ id: "1111111111111113", error: true, throttle: true });
    const result = shapeTraces([trace("1-h", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].status).toBe("error");
  });

  test("throttle alone maps to throttle", () => {
    const s = seg({ id: "1111111111111114", throttle: true });
    const result = shapeTraces([trace("1-i", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].status).toBe("throttle");
  });

  test("no fault/error/throttle maps to ok", () => {
    const s = seg({ id: "1111111111111115" });
    const result = shapeTraces([trace("1-j", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].status).toBe("ok");
  });
});

describe("shapeTraces — in_progress / open bars", () => {
  test("a segment with no end_time is marked inProgress:true with an open bar", () => {
    const s = seg({ id: "1111111111111116", end_time: undefined });
    const result = shapeTraces([trace("1-k", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].inProgress).toBe(true);
  });

  test("a segment with an end_time is inProgress:false", () => {
    const s = seg({ id: "1111111111111117" });
    const result = shapeTraces([trace("1-l", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].inProgress).toBe(false);
  });
});

describe("shapeTraces — multi-trace ordering", () => {
  test("multiple traces are returned as a list sorted by startTime ascending", () => {
    const later = trace("1-later", [
      seg({ id: "aaaaaaaaaaaaaaa1", start_time: 1785000010.0 }),
    ]);
    const earlier = trace("1-earlier", [
      seg({ id: "aaaaaaaaaaaaaaa2", start_time: 1785000000.0 }),
    ]);
    const result = shapeTraces([later, earlier], { includeMetadata: false });
    expect(result.traces.map((t) => t.traceId)).toEqual([
      "1-earlier",
      "1-later",
    ]);
  });
});

describe("shapeTraces — response field-allowlist (invariant 5)", () => {
  test("metadata/aws/sql bags are dropped by default (non-admin / includeMetadata=false)", () => {
    const s = seg({
      id: "1111111111111118",
      metadata: { secretPayload: "sensitive" },
      aws: { function_arn: "arn:aws:lambda:..." },
      sql: { sanitized_query: "SELECT 1" },
      annotations: { correlation_id: "exec-1" },
    });
    const result = shapeTraces([trace("1-m", [s])], { includeMetadata: false });
    const span = result.traces[0].spans[0] as unknown as Record<
      string,
      unknown
    >;
    expect(span.metadata).toBeUndefined();
    expect(span.aws).toBeUndefined();
    expect(span.sql).toBeUndefined();
  });

  test("annotations ARE included even when includeMetadata is false (they are the stitch-key contract, not a metadata bag)", () => {
    const s = seg({
      id: "1111111111111119",
      annotations: { correlation_id: "exec-1" },
    });
    const result = shapeTraces([trace("1-n", [s])], { includeMetadata: false });
    expect(result.traces[0].annotations).toEqual({ correlation_id: "exec-1" });
  });

  test("run_id annotation surfaces on the shaped trace's annotations map when present (Pass 2, design §4 — additive, never gates the response)", () => {
    const s = seg({
      id: "1111111111111119",
      annotations: {
        correlation_id: "exec-1",
        run_id: "run-11111111-1111-1111-1111-111111111111",
      },
    });
    const result = shapeTraces([trace("1-n2", [s])], {
      includeMetadata: false,
    });
    expect(result.traces[0].annotations.run_id).toBe(
      "run-11111111-1111-1111-1111-111111111111",
    );
  });

  test("run_id annotation absent (pre-runId trace) -> annotations map omits the key, never throws, never fabricates a value", () => {
    const s = seg({
      id: "111111111111111b",
      annotations: { correlation_id: "exec-1" },
    });
    const result = shapeTraces([trace("1-n3", [s])], {
      includeMetadata: false,
    });
    expect(result.traces[0].annotations.run_id).toBeUndefined();
    expect(result.traces[0].annotations).toEqual({ correlation_id: "exec-1" });
  });

  test("includeMetadata:true (admin opt-in) surfaces the raw metadata bag on the span", () => {
    const s = seg({
      id: "111111111111111a",
      metadata: { secretPayload: "sensitive" },
    });
    const result = shapeTraces([trace("1-o", [s])], { includeMetadata: true });
    const span = result.traces[0].spans[0] as unknown as Record<
      string,
      unknown
    >;
    expect(span.metadata).toEqual({ secretPayload: "sensitive" });
  });
});

describe("shapeTraces — error extraction from cause", () => {
  test("cause.exceptions[0] is lifted into span.error {type,message}", () => {
    const s = seg({
      id: "111111111111111b",
      fault: true,
      cause: { exceptions: [{ type: "TimeoutError", message: "boom" }] },
    });
    const result = shapeTraces([trace("1-p", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].error).toEqual({
      type: "TimeoutError",
      message: "boom",
    });
  });

  test("no cause -> error is null, never throws on a missing cause field", () => {
    const s = seg({ id: "111111111111111c" });
    const result = shapeTraces([trace("1-q", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].error).toBeNull();
  });
});

describe("shapeTraces — http status lift", () => {
  test("http.response.status is lifted onto span.http.status", () => {
    const s = seg({
      id: "111111111111111d",
      http: { response: { status: 200 } },
    });
    const result = shapeTraces([trace("1-r", [s])], { includeMetadata: false });
    expect(result.traces[0].spans[0].http).toEqual({ status: 200 });
  });
});

describe("shapeTraces — empty input", () => {
  test("zero traces yields an empty traces array without throwing", () => {
    const result = shapeTraces([], { includeMetadata: false });
    expect(result.traces).toEqual([]);
    expect(result.meta.traceCount).toBe(0);
    expect(result.meta.spanCount).toBe(0);
  });
});
