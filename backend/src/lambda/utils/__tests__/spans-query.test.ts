/**
 * Tests for spans-query.ts — CloudWatchLogsClient StartQuery/bounded-poll/
 * GetQueryResults wrapper (design §1 "Absorbing async polling in a sync
 * 30s Lambda", §8 "spans-query.test.ts").
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { runSpanQuery } from "../spans-query";

const logsMock = mockClient(CloudWatchLogsClient);

beforeEach(() => {
  logsMock.reset();
});

describe("runSpanQuery — happy path", () => {
  test("Complete with rows -> queryStatus:complete, @message JSON parsed+flattened into row fields", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-1" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [
        [
          {
            field: "@message",
            value: JSON.stringify({
              traceId: "6a7e5de027c150316d0ff197004e14b1",
              spanId: "021348f2ab124f06",
              name: "PopObservability-dev-CanaryFnEAA4AF84-rA1uxPLOe98U/LambdaService",
              startTimeUnixNano: 1786666464924999936,
              status: { code: "UNSET" },
            }),
          },
        ],
      ],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
    });

    expect(result.queryStatus).toBe("complete");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].spanId).toBe("021348f2ab124f06");
    expect(result.rows[0].traceId).toBe("6a7e5de027c150316d0ff197004e14b1");
    expect(result.rows[0]["status.code"]).toBe("UNSET");
  });

  test("a malformed @message value is skipped without throwing, no fields surface for that row", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-1b" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [[{ field: "@message", value: "{not valid json" }]],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
    });

    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0])).toHaveLength(0);
  });

  test("passes logGroupName/startTime/endTime/queryString/limit through to StartQuery, including the @message fields projection", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-2" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.run_id` = "run-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 50,
    });

    const startCall = logsMock
      .calls()
      .find((c) => c.args[0] instanceof StartQueryCommand);
    expect(startCall).toBeDefined();
    const input = (startCall!.args[0] as StartQueryCommand).input;
    expect(input.logGroupName).toBe("aws/spans");
    expect(input.startTime).toBe(1000);
    expect(input.endTime).toBe(2000);
    expect(input.queryString).toContain("filter `attributes.run_id`");
    expect(input.queryString).toContain("| fields @message");
    expect(input.queryString).toContain("limit 50");
    // The fields projection must precede the limit clause.
    expect(input.queryString!.indexOf("fields @message")).toBeLessThan(
      input.queryString!.indexOf("limit 50"),
    );
  });
});

describe("runSpanQuery — bounded poll", () => {
  test("Running then Complete -> polls until complete, returns rows", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-3" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolvesOnce({ status: "Running", results: [] })
      .resolvesOnce({ status: "Running", results: [] })
      .resolves({
        status: "Complete",
        results: [
          [{ field: "@message", value: JSON.stringify({ spanId: "span-2" }) }],
        ],
      });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
      pollIntervalMs: 1,
      maxPollAttempts: 10,
    });

    expect(result.queryStatus).toBe("complete");
    expect(result.rows).toHaveLength(1);
  });

  test("poll budget exhausted (still Running) -> queryStatus:incomplete, StopQuery issued", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-4" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Running", results: [] });
    logsMock.on(StopQueryCommand).resolves({ success: true });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
    });

    expect(result.queryStatus).toBe("incomplete");
    expect(result.rows).toHaveLength(0);
    const stopCall = logsMock
      .calls()
      .find((c) => c.args[0] instanceof StopQueryCommand);
    expect(stopCall).toBeDefined();
    expect((stopCall!.args[0] as StopQueryCommand).input.queryId).toBe("q-4");
  });

  test("Scheduled status is treated the same as Running (still polling)", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-5" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolvesOnce({ status: "Scheduled", results: [] })
      .resolves({ status: "Complete", results: [] });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
      pollIntervalMs: 1,
      maxPollAttempts: 10,
    });

    expect(result.queryStatus).toBe("complete");
  });
});

describe("runSpanQuery — failure statuses", () => {
  test("Failed status -> queryStatus:failed, empty rows, never throws", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-6" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Failed", results: [] });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
    });

    expect(result.queryStatus).toBe("failed");
    expect(result.rows).toHaveLength(0);
  });

  test("Cancelled status -> queryStatus:failed", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-7" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Cancelled", results: [] });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
    });

    expect(result.queryStatus).toBe("failed");
  });

  test("StartQuery throw propagates (handler's catch-all maps it to 500)", async () => {
    logsMock.on(StartQueryCommand).rejects(new Error("Throttling"));

    await expect(
      runSpanQuery({
        logGroupName: "aws/spans",
        queryString: 'filter `attributes.correlation_id` = "exec-1"',
        startTimeSec: 1000,
        endTimeSec: 2000,
        limit: 100,
      }),
    ).rejects.toThrow("Throttling");
  });

  test("GetQueryResults throw propagates", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-8" });
    logsMock
      .on(GetQueryResultsCommand)
      .rejects(new Error("LimitExceededException"));

    await expect(
      runSpanQuery({
        logGroupName: "aws/spans",
        queryString: 'filter `attributes.correlation_id` = "exec-1"',
        startTimeSec: 1000,
        endTimeSec: 2000,
        limit: 100,
        pollIntervalMs: 1,
        maxPollAttempts: 3,
      }),
    ).rejects.toThrow("LimitExceededException");
  });
});

describe("runSpanQuery — row shape / malformed rows never throw", () => {
  test("an @message cell whose JSON body omits a field leaves that field undefined, never throws", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-9" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [
        [{ field: "@message", value: JSON.stringify({ traceId: "trace-9" }) }],
      ],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].traceId).toBe("trace-9");
    expect(result.rows[0].spanId).toBeUndefined();
  });

  test("truncated:true when rowcount equals the configured limit", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-10" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [
        [{ field: "@message", value: JSON.stringify({ spanId: "s1" }) }],
        [{ field: "@message", value: JSON.stringify({ spanId: "s2" }) }],
      ],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `attributes.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 2,
    });

    expect(result.truncated).toBe(true);
  });
});
