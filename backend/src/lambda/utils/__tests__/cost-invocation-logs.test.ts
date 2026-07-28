/**
 * Unit tests for cost-invocation-logs.ts — Tier B CloudWatch Bedrock
 * model-invocation log parsing + fetch.
 *
 * `parseInvocationLogEvent` is pure (no AWS SDK) and is the one under
 * property-style scrutiny: it must never throw on malformed log lines and
 * must extract exactly {requestId, inputTokens, outputTokens} when present.
 *
 * `fetchInvocationTokenActuals` wraps a mocked CloudWatchLogsClient
 * FilterLogEvents call.
 */
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  parseInvocationLogEvent,
  fetchInvocationTokenActuals,
} from "../cost-invocation-logs";

const cwlMock = mockClient(CloudWatchLogsClient);

function invocationLogMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    requestId: "req-abc-123",
    input: { inputTokenCount: 100 },
    output: { outputTokenCount: 50 },
    ...overrides,
  });
}

describe("parseInvocationLogEvent", () => {
  test("extracts requestId + input/output token counts from a well-formed message", () => {
    const result = parseInvocationLogEvent(invocationLogMessage());
    expect(result).toEqual({
      requestId: "req-abc-123",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  test("returns null for a non-JSON message", () => {
    expect(parseInvocationLogEvent("not json at all")).toBeNull();
  });

  test("returns null when requestId is missing", () => {
    const msg = JSON.stringify({
      input: { inputTokenCount: 1 },
      output: { outputTokenCount: 1 },
    });
    expect(parseInvocationLogEvent(msg)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseInvocationLogEvent("")).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(parseInvocationLogEvent(undefined)).toBeNull();
  });

  test("missing token count fields coerce to 0 rather than throwing", () => {
    const msg = JSON.stringify({ requestId: "req-1", input: {}, output: {} });
    const result = parseInvocationLogEvent(msg);
    expect(result).toEqual({
      requestId: "req-1",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test("malformed nested structures never throw", () => {
    const msg = JSON.stringify({
      requestId: "req-1",
      input: "not-an-object",
      output: null,
    });
    expect(() => parseInvocationLogEvent(msg)).not.toThrow();
    expect(parseInvocationLogEvent(msg)).toEqual({
      requestId: "req-1",
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("fetchInvocationTokenActuals", () => {
  beforeEach(() => {
    cwlMock.reset();
  });

  test("returns a map keyed by requestId for matched log lines", async () => {
    cwlMock.on(FilterLogEventsCommand).resolves({
      events: [
        { message: invocationLogMessage({ requestId: "req-1" }) },
        {
          message: invocationLogMessage({
            requestId: "req-2",
            input: { inputTokenCount: 5 },
          }),
        },
      ],
    });

    const result = await fetchInvocationTokenActuals(
      "/aws/bedrock/invocation-logs",
      0,
      3600,
      1000,
    );

    expect(result.size).toBe(2);
    expect(result.get("req-1")).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.get("req-2")).toEqual({ inputTokens: 5, outputTokens: 50 });
  });

  test("paginates via nextToken until exhausted or the cap is hit", async () => {
    cwlMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({
        events: [{ message: invocationLogMessage({ requestId: "req-1" }) }],
        nextToken: "token-2",
      })
      .resolvesOnce({
        events: [{ message: invocationLogMessage({ requestId: "req-2" }) }],
      });

    const result = await fetchInvocationTokenActuals(
      "/aws/bedrock/invocation-logs",
      0,
      3600,
      1000,
    );

    expect(result.size).toBe(2);
    expect(cwlMock.calls()).toHaveLength(2);
  });

  test("respects maxEventsPerWindow cap and stops paginating", async () => {
    cwlMock.on(FilterLogEventsCommand).resolves({
      events: [
        { message: invocationLogMessage({ requestId: "req-1" }) },
        { message: invocationLogMessage({ requestId: "req-2" }) },
      ],
      nextToken: "more",
    });

    const result = await fetchInvocationTokenActuals(
      "/aws/bedrock/invocation-logs",
      0,
      3600,
      1,
    );

    expect(result.size).toBeLessThanOrEqual(2);
    // Must not infinite-loop chasing nextToken past the cap.
    expect(cwlMock.calls().length).toBeLessThan(5);
  });

  test("malformed log lines are skipped, never thrown", async () => {
    cwlMock.on(FilterLogEventsCommand).resolves({
      events: [
        { message: "garbage" },
        { message: invocationLogMessage({ requestId: "req-good" }) },
      ],
    });

    const result = await fetchInvocationTokenActuals(
      "/aws/bedrock/invocation-logs",
      0,
      3600,
      1000,
    );

    expect(result.size).toBe(1);
    expect(result.get("req-good")).toBeDefined();
  });

  test("a FilterLogEvents failure never throws, returns an empty map", async () => {
    cwlMock.on(FilterLogEventsCommand).rejects(new Error("access denied"));

    const result = await fetchInvocationTokenActuals(
      "/aws/bedrock/invocation-logs",
      0,
      3600,
      1000,
    );

    expect(result.size).toBe(0);
  });
});
