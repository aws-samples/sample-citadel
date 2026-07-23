/**
 * Unit tests for the hand-rolled CloudWatch EMF emitter (backend/src/utils/emf.ts).
 *
 * Wave 0 intake instrumentation — OBSERVABILITY ONLY. The emitter writes one
 * structured-JSON line per flush to stdout via console.log; Lambda ships stdout
 * to CloudWatch Logs where the `_aws.CloudWatchMetrics` envelope becomes
 * metrics automatically. The emitter must NEVER throw: a metrics failure must
 * never break the message handler.
 */

const ORIGINAL_ENV = process.env.ENVIRONMENT;

import { emitMetrics } from "../emf";

describe("emitMetrics — EMF envelope", () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.ENVIRONMENT = "test";
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ENVIRONMENT;
    } else {
      process.env.ENVIRONMENT = ORIGINAL_ENV;
    }
  });

  /** Parse the single emitted line as JSON. */
  const emitted = (): Record<string, unknown> => {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(typeof line).toBe("string");
    return JSON.parse(line) as Record<string, unknown>;
  };

  type EmfEnvelope = {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };

  test("emits exactly one console.log line per flush that parses as JSON", () => {
    emitMetrics({
      metrics: [{ name: "TimeToFirstToken_ms", value: 123 }],
      properties: { sessionId: "s-1" },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(logSpy.mock.calls[0][0] as string)).not.toThrow();
  });

  test("envelope has Namespace Citadel/Intake, Environment dimension, and metric names/units", () => {
    emitMetrics({
      metrics: [
        { name: "TimeToFirstToken_ms", value: 123.4 },
        { name: "AgentTurnTotal_ms", value: 4567 },
      ],
    });
    const blob = emitted();
    const aws = blob._aws as EmfEnvelope;
    expect(aws).toBeDefined();
    expect(typeof aws.Timestamp).toBe("number");
    expect(Math.abs(Date.now() - aws.Timestamp)).toBeLessThan(5000);
    expect(aws.CloudWatchMetrics).toHaveLength(1);
    const directive = aws.CloudWatchMetrics[0];
    expect(directive.Namespace).toBe("Citadel/Intake");
    expect(directive.Dimensions).toEqual([["Environment"]]);
    expect(directive.Metrics).toEqual([
      { Name: "TimeToFirstToken_ms", Unit: "Milliseconds" },
      { Name: "AgentTurnTotal_ms", Unit: "Milliseconds" },
    ]);
  });

  test("metric values, dimension value, and properties land at the top level", () => {
    emitMetrics({
      metrics: [{ name: "HandlerOverhead_ms", value: 42 }],
      properties: { sessionId: "proj-1", requestId: "req-9" },
    });
    const blob = emitted();
    expect(blob.HandlerOverhead_ms).toBe(42);
    expect(blob.Environment).toBe("test");
    expect(blob.sessionId).toBe("proj-1");
    expect(blob.requestId).toBe("req-9");
  });

  test("defaults the Environment dimension to dev when ENVIRONMENT is unset", () => {
    delete process.env.ENVIRONMENT;
    emitMetrics({ metrics: [{ name: "M", value: 1 }] });
    expect(emitted().Environment).toBe("dev");
  });

  test("honours a custom unit", () => {
    emitMetrics({ metrics: [{ name: "ToolCalls", value: 3, unit: "Count" }] });
    const aws = emitted()._aws as EmfEnvelope;
    expect(aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: "ToolCalls", Unit: "Count" },
    ]);
  });

  test("drops non-finite metric values from directive and top level", () => {
    emitMetrics({
      metrics: [
        { name: "Good_ms", value: 10 },
        { name: "Bad_ms", value: Number.NaN },
        { name: "AlsoBad_ms", value: Number.POSITIVE_INFINITY },
      ],
    });
    const blob = emitted();
    const aws = blob._aws as EmfEnvelope;
    expect(aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: "Good_ms", Unit: "Milliseconds" },
    ]);
    expect(blob.Good_ms).toBe(10);
    expect(blob).not.toHaveProperty("Bad_ms");
    expect(blob).not.toHaveProperty("AlsoBad_ms");
  });

  test("emits nothing when no valid metrics remain", () => {
    emitMetrics({ metrics: [{ name: "Bad_ms", value: Number.NaN }] });
    emitMetrics({ metrics: [] });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("never throws on completely invalid input", () => {
    expect(() =>
      emitMetrics(undefined as unknown as Parameters<typeof emitMetrics>[0]),
    ).not.toThrow();
    expect(() =>
      emitMetrics(null as unknown as Parameters<typeof emitMetrics>[0]),
    ).not.toThrow();
    expect(() =>
      emitMetrics({ metrics: "nope" as unknown as [] }),
    ).not.toThrow();
  });

  test("never throws on a circular properties object and still emits the metric", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      emitMetrics({
        metrics: [{ name: "Survives_ms", value: 7 }],
        properties: { sessionId: "s-1", weird: circular },
      }),
    ).not.toThrow();
    // Fallback line without the unserialisable properties still carries the metric.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const blob = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(blob.Survives_ms).toBe(7);
    expect(blob).not.toHaveProperty("weird");
  });

  test("properties cannot clobber the _aws envelope or dimension value", () => {
    emitMetrics({
      metrics: [{ name: "M", value: 1 }],
      properties: { _aws: "evil", Environment: "evil", M: "evil" },
    });
    const blob = emitted();
    expect(typeof blob._aws).toBe("object");
    expect(blob.Environment).toBe("test");
    expect(blob.M).toBe(1);
  });
});
