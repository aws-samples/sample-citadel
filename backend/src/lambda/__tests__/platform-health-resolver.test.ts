/**
 * Unit tests for platform-health-resolver.ts (Query.getPlatformAlarms).
 *
 * Admin-only, read-only resolver backed by cloudwatch:DescribeAlarms only
 * (AlarmNamePrefix=ALARM_NAME_PREFIX). Fails closed: a non-admin caller
 * throws rather than receiving an empty/filtered list. `configured:false`
 * (distinct from an empty `alarms` list) when ALARM_NAME_PREFIX is unset or
 * DescribeAlarms is denied. queueName/queueDepth are derived from the
 * alarm's own Dimensions + StateReasonData — no sqs:GetQueueAttributes call
 * is ever made (verified by asserting no SQS client is mocked/invoked).
 */
import * as fs from "fs";
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";

const cwMock = mockClient(CloudWatchClient);

import { handler } from "../platform-health-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

function adminEvent(): Record<string, unknown> {
  return { identity: { "cognito:groups": ["admin"] } };
}

function nonAdminEvent(): Record<string, unknown> {
  return { identity: { "cognito:groups": ["developer"] } };
}

function dlqAlarm(overrides: Record<string, unknown> = {}) {
  return {
    AlarmName: "citadel-dlq-not-empty-dev",
    StateValue: "ALARM",
    StateReason:
      "Threshold Crossed: 1 datapoint [3.0] was greater than the threshold (0.0).",
    StateReasonData: JSON.stringify({
      version: "1.0",
      queryDate: "2026-11-24T00:00:00.000Z",
      startDate: "2026-11-24T00:00:00.000Z",
      statistic: "Maximum",
      period: 300,
      recentDatapoints: [3.0],
      threshold: 0.0,
    }),
    StateUpdatedTimestamp: new Date("2026-11-24T00:00:00.000Z"),
    Dimensions: [{ Name: "QueueName", Value: "citadel-dlq-dev" }],
    ...overrides,
  };
}

function okAlarm(overrides: Record<string, unknown> = {}) {
  return {
    AlarmName: "citadel-dlq-not-empty-shared-dev",
    StateValue: "OK",
    StateReason: "Threshold Crossed: no datapoints were breaching",
    StateReasonData: JSON.stringify({ recentDatapoints: [0] }),
    StateUpdatedTimestamp: new Date("2026-11-24T00:00:00.000Z"),
    Dimensions: [{ Name: "QueueName", Value: "citadel-dlq-shared-dev" }],
    ...overrides,
  };
}

describe("platform-health-resolver — getPlatformAlarms", () => {
  beforeEach(() => {
    cwMock.reset();
    process.env.ALARM_NAME_PREFIX = "citadel-";
    process.env.ENVIRONMENT = "test";
  });

  afterEach(() => {
    delete process.env.ALARM_NAME_PREFIX;
    delete process.env.ENVIRONMENT;
  });

  async function invoke(event: Record<string, unknown>) {
    return handler(event as unknown as HandlerEvent);
  }

  test("non-admin caller is refused — throws rather than returning an empty or filtered list", async () => {
    cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [dlqAlarm()] });
    await expect(invoke(nonAdminEvent())).rejects.toThrow();
  });

  test("admin caller with no identity at all is also refused (fail closed, not just 'non-admin group')", async () => {
    cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });
    await expect(invoke({})).rejects.toThrow();
  });

  test("admin caller sees ALARM state mapped with queueName/queueDepth derived from the alarm payload", async () => {
    cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [dlqAlarm()] });

    const result = await invoke(adminEvent());

    expect(result.configured).toBe(true);
    expect(result.alarms).toHaveLength(1);
    const alarm = result.alarms[0];
    expect(alarm.alarmName).toBe("citadel-dlq-not-empty-dev");
    expect(alarm.state).toBe("ALARM");
    expect(alarm.queueName).toBe("citadel-dlq-dev");
    expect(alarm.queueDepth).toBe(3);
  });

  test("ALARM-state dlq alarms get a redriveHint; OK-state alarms do not", async () => {
    cwMock
      .on(DescribeAlarmsCommand)
      .resolves({ MetricAlarms: [dlqAlarm(), okAlarm()] });

    const result = await invoke(adminEvent());

    const alarmState = result.alarms.find((a) => a.state === "ALARM");
    const okState = result.alarms.find((a) => a.state === "OK");
    expect(alarmState?.redriveHint).toBeTruthy();
    expect(okState?.redriveHint).toBeFalsy();
  });

  test("DescribeAlarms is called with AlarmNamePrefix scoped to ALARM_NAME_PREFIX", async () => {
    cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });

    await invoke(adminEvent());

    const calls = cwMock.commandCalls(DescribeAlarmsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      AlarmNamePrefix: "citadel-",
    });
  });

  test("configured:false (not an empty list) when ALARM_NAME_PREFIX is unset", async () => {
    delete process.env.ALARM_NAME_PREFIX;
    cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [dlqAlarm()] });

    const result = await invoke(adminEvent());

    expect(result.configured).toBe(false);
    expect(result.alarms).toEqual([]);
  });

  test("configured:false when DescribeAlarms is denied — error is swallowed, not rethrown to the admin caller", async () => {
    cwMock.on(DescribeAlarmsCommand).rejects(new Error("AccessDenied"));

    const result = await invoke(adminEvent());

    expect(result.configured).toBe(false);
    expect(result.alarms).toEqual([]);
  });

  test("INSUFFICIENT_DATA state maps through without a redriveHint", async () => {
    cwMock.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [dlqAlarm({ StateValue: "INSUFFICIENT_DATA" })],
    });

    const result = await invoke(adminEvent());

    expect(result.alarms[0].state).toBe("INSUFFICIENT_DATA");
    expect(result.alarms[0].redriveHint).toBeFalsy();
  });

  test("never calls any SQS SDK command — queueDepth comes from the alarm payload only", async () => {
    cwMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [dlqAlarm()] });

    // No SQS client is mocked at all; if the resolver tried to construct one
    // and call a real AWS SDK command, it would hang on credential
    // resolution and this test would time out rather than failing fast —
    // the absence of a hang/timeout here is itself part of the proof,
    // backed by source-level confirmation there is no sqs import.
    const source = fs.readFileSync(
      require.resolve("../platform-health-resolver"),
      "utf-8",
    );
    expect(source).not.toMatch(/client-sqs/);

    await invoke(adminEvent());
  });
});
