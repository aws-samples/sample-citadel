import * as fc from "fast-check";
import * as AWSXRay from "aws-xray-sdk-core";
import {
  getActiveTraceContext,
  renderXRayHeader,
  toTraceparent,
  extractCarried,
  annotateFromCarried,
  logFields,
} from "../trace-context";

describe("trace-context helpers (no-op-safety, Jest = no active segment)", () => {
  // R1: getActiveTraceContext() returns undefined with no segment (no throw).
  it("R1: getActiveTraceContext returns undefined outside a segment", () => {
    expect(() => getActiveTraceContext()).not.toThrow();
    expect(getActiveTraceContext()).toBeUndefined();
  });

  // R2: renderXRayHeader from a mock segment.
  it("R2: renderXRayHeader formats a mock root segment + parent id as Root=...;Parent=...;Sampled=1", () => {
    const mockRootSegment = {
      trace_id: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      notTraced: false,
    } as unknown as AWSXRay.Segment;
    const header = renderXRayHeader(mockRootSegment, "cccccccccccccccc");
    expect(header).toBe(
      "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
    );
  });

  it("R2b: renderXRayHeader sets Sampled=0 when notTraced is true", () => {
    const mockRootSegment = {
      trace_id: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      notTraced: true,
    } as unknown as AWSXRay.Segment;
    const header = renderXRayHeader(mockRootSegment, "cccccccccccccccc");
    expect(header).toBe(
      "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=0",
    );
  });

  // R3: toTraceparent maps X-Ray Root -> 32-hex W3C trace-id.
  it("R3: toTraceparent converts an X-Ray Root + parent to W3C traceparent", () => {
    const result = toTraceparent(
      "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
      true,
    );
    expect(result).toBe(
      "00-aaaaaaaabbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccc-01",
    );
  });

  it("R3b: toTraceparent sets flags=00 when not sampled", () => {
    const result = toTraceparent(
      "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
      false,
    );
    expect(result.endsWith("-00")).toBe(true);
  });

  it("R3c: toTraceparent returns undefined for a malformed X-Ray trace id", () => {
    expect(
      toTraceparent("not-a-trace-id", "cccccccccccccccc", true),
    ).toBeUndefined();
  });

  // R4: extractCarried on detail without/with malformed traceContext.
  it("R4: extractCarried returns undefined when traceContext is absent", () => {
    expect(extractCarried({})).toBeUndefined();
    expect(extractCarried(undefined)).toBeUndefined();
    expect(extractCarried(null)).toBeUndefined();
  });

  it("R4b: extractCarried returns undefined for a malformed traceContext (no throw)", () => {
    expect(extractCarried({ traceContext: "not-an-object" })).toBeUndefined();
    expect(extractCarried({ traceContext: 42 })).toBeUndefined();
    expect(extractCarried({ traceContext: null })).toBeUndefined();
  });

  it("R4c: extractCarried returns the traceContext object when well-formed", () => {
    const detail = {
      traceContext: {
        xrayTraceHeader:
          "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
        traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
        parentId: "cccccccccccccccc",
      },
    };
    expect(extractCarried(detail)).toEqual(detail.traceContext);
  });

  // R5: annotateFromCarried no-op when no active segment.
  it("R5: annotateFromCarried is a no-op with no active segment and no carried context", () => {
    expect(() => annotateFromCarried(undefined)).not.toThrow();
  });

  it("R5b: annotateFromCarried is a no-op with no active segment even when carried context is present", () => {
    expect(() =>
      annotateFromCarried({
        traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
        correlationId: "exec-123",
      }),
    ).not.toThrow();
  });

  it("logFields returns an empty object with no active segment and no carried context", () => {
    expect(logFields(undefined)).toEqual({});
  });

  it("logFields surfaces source_trace_id from carried context even absent a segment", () => {
    expect(
      logFields({ traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb" }),
    ).toEqual({ source_trace_id: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb" });
  });

  // Property test: absence of traceContext must never throw across any input shape.
  it("property: extractCarried never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => extractCarried(input)).not.toThrow();
      }),
    );
  });

  it("property: annotateFromCarried never throws for arbitrary carried input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => annotateFromCarried(input as any)).not.toThrow();
      }),
    );
  });
});

describe('annotateFromCarried: annotation-key contract pinning (design §"Annotation-key contract", stable API)', () => {
  // The waterfall-viewer story consumes these exact literal key names via
  // X-Ray annotations. Without an assertion on the literal strings passed to
  // addAnnotation, a silent rename here would break that story with no test
  // failure anywhere in the suite (annotate is mocked wholesale in every
  // consumer test). These assertions pin all five keys plus the metadata
  // namespace against a mocked active segment.
  //
  // aws-xray-sdk-core exports getSegment as a non-configurable binding, so
  // jest.spyOn(AWSXRay, "getSegment") throws "Cannot redefine property" —
  // jest.doMock + resetModules + a fresh dynamic import is required instead
  // (same isolation pattern gateway-registration-handler's test uses).
  const mockSegment = {
    addAnnotation: jest.fn(),
    addMetadata: jest.fn(),
  };

  async function loadWithMockedSegment() {
    jest.resetModules();
    jest.doMock("aws-xray-sdk-core", () => ({
      getSegment: jest.fn().mockReturnValue(mockSegment),
      setContextMissingStrategy: jest.fn(),
      captureAWSv3Client: jest.fn((c: unknown) => c),
    }));
    return (await import("../trace-context")) as typeof import("../trace-context");
  }

  beforeEach(() => {
    mockSegment.addAnnotation.mockClear();
    mockSegment.addMetadata.mockClear();
  });

  afterEach(() => {
    jest.dontMock("aws-xray-sdk-core");
    jest.resetModules();
  });

  it("stamps the literal 'correlation_id' annotation key from carried.correlationId", async () => {
    const { annotateFromCarried: annotate } = await loadWithMockedSegment();
    annotate({ correlationId: "exec-abc" });
    expect(mockSegment.addAnnotation).toHaveBeenCalledWith(
      "correlation_id",
      "exec-abc",
    );
  });

  it("stamps the literal 'source_trace_id' annotation key from carried.traceId", async () => {
    const { annotateFromCarried: annotate } = await loadWithMockedSegment();
    annotate({ traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(mockSegment.addAnnotation).toHaveBeenCalledWith(
      "source_trace_id",
      "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("stamps the literal 'execution_id' annotation key from carried.executionId", async () => {
    const { annotateFromCarried: annotate } = await loadWithMockedSegment();
    annotate({ executionId: "exec-123" });
    expect(mockSegment.addAnnotation).toHaveBeenCalledWith(
      "execution_id",
      "exec-123",
    );
  });

  it("stamps the literal 'node_id' annotation key from carried.nodeId", async () => {
    const { annotateFromCarried: annotate } = await loadWithMockedSegment();
    annotate({ nodeId: "node-1" });
    expect(mockSegment.addAnnotation).toHaveBeenCalledWith("node_id", "node-1");
  });

  it("stamps the literal 'session_id' annotation key from carried.sessionId", async () => {
    const { annotateFromCarried: annotate } = await loadWithMockedSegment();
    annotate({ sessionId: "sess-1" });
    expect(mockSegment.addAnnotation).toHaveBeenCalledWith(
      "session_id",
      "sess-1",
    );
  });

  it("stamps the literal 'trace_context' metadata namespace with the raw carried object", async () => {
    const { annotateFromCarried: annotate } = await loadWithMockedSegment();
    const carried = { traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb" };
    annotate(carried);
    expect(mockSegment.addMetadata).toHaveBeenCalledWith(
      "trace_context",
      carried,
    );
  });
});
