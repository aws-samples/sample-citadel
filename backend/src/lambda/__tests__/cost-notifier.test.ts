/**
 * Tests for cost-notifier.ts — sanitize + PutEvents for cost.budget.*
 * events on the shared agentEventBus, source citadel.telemetry.
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

import { emitBudgetEvent, __resetCostNotifierForTest } from "../cost-notifier";

const ebMock = mockClient(EventBridgeClient);

beforeEach(() => {
  ebMock.reset();
  __resetCostNotifierForTest();
  process.env.EVENT_BUS_NAME = "test-bus";
});

afterEach(() => {
  delete process.env.EVENT_BUS_NAME;
});

describe("emitBudgetEvent", () => {
  test("publishes cost.budget.threshold.crossed with source citadel.telemetry", async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await emitBudgetEvent("cost.budget.threshold.crossed", {
      orgId: "org-1",
      scope: "org",
      periodKey: "2026-07",
      threshold: 0.8,
      spentMicros: 800_000,
      limitMicros: 1_000_000,
      currency: "USD",
    });

    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls).toHaveLength(1);
    const entry = calls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe("citadel.telemetry");
    expect(entry.DetailType).toBe("cost.budget.threshold.crossed");
    expect(entry.EventBusName).toBe("test-bus");
    const detail = JSON.parse(entry.Detail!);
    expect(detail.orgId).toBe("org-1");
    expect(detail.threshold).toBe(0.8);
    expect(typeof detail.timestamp).toBe("string");
  });

  test("publishes cost.budget.breached for the hard threshold", async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await emitBudgetEvent("cost.budget.breached", {
      orgId: "org-1",
      scope: "app:app-1",
      periodKey: "2026-07",
      threshold: 1.0,
      spentMicros: 1_200_000,
      limitMicros: 1_000_000,
      currency: "USD",
    });

    const entry =
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0];
    expect(entry.DetailType).toBe("cost.budget.breached");
  });

  test("sanitizes dangerous tag content out of string fields before publish", async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await emitBudgetEvent("cost.budget.threshold.crossed", {
      orgId: "org-1<script>alert(1)</script>",
      scope: "org",
      periodKey: "2026-07",
      threshold: 0.8,
      spentMicros: 1,
      limitMicros: 1,
      currency: "USD",
    });

    const entry =
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0];
    const detail = JSON.parse(entry.Detail!);
    expect(detail.orgId).toBe("org-1");
    expect(detail.orgId).not.toContain("<script>");
  });

  test("propagates a PutEvents failure to the caller (evaluator must handle it without corrupting budget rows)", async () => {
    ebMock.on(PutEventsCommand).rejects(new Error("EventBridge unavailable"));

    await expect(
      emitBudgetEvent("cost.budget.threshold.crossed", {
        orgId: "org-1",
        scope: "org",
        periodKey: "2026-07",
        threshold: 0.8,
        spentMicros: 1,
        limitMicros: 1,
        currency: "USD",
      }),
    ).rejects.toThrow("EventBridge unavailable");
  });
});
