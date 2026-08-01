/**
 * Red-first tests for runId propagation in the trace-context helpers
 * (Pass 1, decision f1cbd5ef, design §2 "Carried trace context" row).
 *
 * `trace-context.ts` had ZERO runId references (verify-p1 NEEDS_CHANGES
 * item 4). This adds the additive, optional `runId` field to
 * `TraceContext`, propagation through `extractCarried`, and a `run_id`
 * X-Ray annotation in `annotateFromCarried`, mirroring the existing
 * `correlationId` -> `correlation_id` handling.
 */
import * as AWSXRay from "aws-xray-sdk-core";
import {
  extractCarried,
  annotateFromCarried,
  TraceContext,
} from "../trace-context";

jest.mock("aws-xray-sdk-core");

describe("extractCarried — runId pass-through", () => {
  it("preserves a runId present on the carried traceContext", () => {
    const detail = { traceContext: { traceId: "1-abc", runId: "run-123" } };
    const carried = extractCarried(detail);
    expect(carried).toBeDefined();
    expect((carried as TraceContext & { runId?: string }).runId).toBe(
      "run-123",
    );
  });

  it("leaves runId absent when not present on the carried traceContext", () => {
    const detail = { traceContext: { traceId: "1-abc" } };
    const carried = extractCarried(detail);
    expect(carried).toBeDefined();
    expect(
      (carried as TraceContext & { runId?: string }).runId,
    ).toBeUndefined();
  });
});

describe("annotateFromCarried — runId annotation", () => {
  const mockGetSegment = AWSXRay.getSegment as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stamps a run_id annotation when runId is present", () => {
    const addAnnotation = jest.fn();
    const addMetadata = jest.fn();
    mockGetSegment.mockReturnValue({ addAnnotation, addMetadata });

    annotateFromCarried({ runId: "run-456" } as TraceContext & {
      runId?: string;
    });

    expect(addAnnotation).toHaveBeenCalledWith("run_id", "run-456");
  });

  it("does not stamp a run_id annotation when runId is absent", () => {
    const addAnnotation = jest.fn();
    const addMetadata = jest.fn();
    mockGetSegment.mockReturnValue({ addAnnotation, addMetadata });

    annotateFromCarried({ correlationId: "corr-1" });

    expect(addAnnotation).not.toHaveBeenCalledWith("run_id", expect.anything());
  });

  it("is no-op-safe with no active segment even when runId is present", () => {
    mockGetSegment.mockReturnValue(undefined);

    expect(() =>
      annotateFromCarried({ runId: "run-789" } as TraceContext & {
        runId?: string;
      }),
    ).not.toThrow();
  });
});
