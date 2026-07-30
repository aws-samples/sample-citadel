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
  test("Complete with rows -> queryStatus:complete, rows returned", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-1" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [
        [
          { field: "spanId", value: "span-1" },
          { field: "traceId", value: "trace-1" },
        ],
      ],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 100,
    });

    expect(result.queryStatus).toBe("complete");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].spanId).toBe("span-1");
    expect(result.rows[0].traceId).toBe("trace-1");
  });

  test("passes logGroupName/startTime/endTime/queryString/limit through to StartQuery", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-2" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `annotation.run_id` = "run-1"',
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
    expect(input.queryString).toContain("filter `annotation.run_id`");
    expect(input.queryString).toContain("limit 50");
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
        results: [[{ field: "spanId", value: "span-2" }]],
      });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
        queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
        queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
  test("a row missing a value field is skipped for that field, never throws", async () => {
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-9" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [[{ field: "spanId" }, { field: "traceId", value: "trace-9" }]],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
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
        [{ field: "spanId", value: "s1" }],
        [{ field: "spanId", value: "s2" }],
      ],
    });

    const result = await runSpanQuery({
      logGroupName: "aws/spans",
      queryString: 'filter `annotation.correlation_id` = "exec-1"',
      startTimeSec: 1000,
      endTimeSec: 2000,
      limit: 2,
    });

    expect(result.truncated).toBe(true);
  });
});
