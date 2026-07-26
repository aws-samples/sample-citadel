/**
 * Handler tests for the cost-ledger reconciler (Tier A aggregate drift +
 * Tier B inactive-by-default gate).
 *
 * Mocks DynamoDBDocumentClient (aws-sdk-client-mock, same convention as
 * cost-ledger-writer.test.ts) and CloudWatchClient. No real AWS calls.
 */

import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";

process.env.COST_LEDGER_TABLE = "citadel-cost-ledger-test";
process.env.ENVIRONMENT = "test";
process.env.SETTLE_LAG_MINUTES = "15";
process.env.MAX_WINDOWS_PER_RUN = "6";
process.env.METRIC_NAMESPACE = "Citadel/CostReconciler";
process.env.COST_RECONCILER_TIER_B_ENABLED = "false";

import {
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  PutCommandInput,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  GetMetricDataCommand,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { handler, tierBReconcile } from "../cost-ledger-reconciler";
import type { LedgerWindowMarkerRow } from "../utils/cost-reconciler-types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const cwMock = mockClient(CloudWatchClient);

/**
 * Builds a fixed "now" so windows are deterministic across test runs.
 * Intentionally NOT hour-aligned: with SETTLE_LAG_MINUTES=15,
 * targetEnd = alignToHour(14:20 - 15min) = alignToHour(14:05) = 14:00,
 * and the cold-start default watermark = alignToHour(14:20) - 1h = 13:00,
 * so exactly one window [13:00, 14:00) is pending on cold start.
 */
function fixedNowMs(): number {
  return Date.parse("2026-07-25T14:20:00.000Z");
}

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: "ORG#org-1",
    SK: "2026-07-25T12:30:00.000Z#evt:0",
    modelKey: "claude-sonnet",
    modelId: "anthropic.claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

describe("cost-ledger-reconciler handler", () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    ddbMock.reset();
    cwMock.reset();
    nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNowMs());
    // Default: no watermark row (cold start) unless a test overrides it.
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    cwMock.on(PutMetricDataCommand).resolves({});
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  test("cold start: no watermark row reconciles exactly the single most-recent closed window", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    // Exactly one window marker written on cold start.
    const markerPuts = putCalls.filter((c) =>
      String(c.args[0].input.Item?.SK).startsWith("WINDOW#"),
    );
    expect(markerPuts).toHaveLength(1);
  });

  test("happy path: one window, matched model => marker, drift metric emitted, rows annotated, watermark advanced", async () => {
    const rows = [ledgerRow()];
    ddbMock.on(ScanCommand).resolves({ Items: rows });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "input_0", Values: [90] },
        { Id: "output_0", Values: [45] },
      ],
    });

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const markerPut = putCalls.find((c) =>
      String(c.args[0].input.Item?.SK).startsWith("WINDOW#"),
    );
    expect(markerPut).toBeDefined();
    const marker = markerPut!.args[0].input.Item as LedgerWindowMarkerRow;
    expect(marker.tier).toBe("A");
    expect(marker.models[0].match).toBe("matched");
    expect(marker.models[0].driftPct).not.toBeNull();

    const emittedMetrics = cwMock.commandCalls(PutMetricDataCommand);
    expect(emittedMetrics.length).toBeGreaterThan(0);
    const driftDatum = emittedMetrics
      .flatMap((c) => c.args[0].input.MetricData ?? [])
      .find((d) => d.MetricName === "EstimateDriftPct");
    expect(driftDatum).toBeDefined();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const annotation = updateCalls.find(
      (c) => c.args[0].input.Key?.SK === rows[0].SK,
    );
    expect(annotation).toBeDefined();
    expect(String(annotation!.args[0].input.UpdateExpression)).toContain(
      "driftCheckedAt",
    );
    // annotateRows must touch ONLY driftCheckedAt — never flip/write `estimate`.
    expect(String(annotation!.args[0].input.UpdateExpression)).not.toContain(
      "estimate",
    );

    const watermarkUpdate = updateCalls.find(
      (c) => c.args[0].input.Key?.SK === "WATERMARK",
    );
    expect(watermarkUpdate).toBeDefined();
  });

  test("IDEMPOTENCY: second run of the same window is a strict no-op (marker PutItem CCF)", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [ledgerRow()] });
    ddbMock.on(PutCommand).callsFake((input: PutCommandInput) => {
      if (String(input.Item?.SK).startsWith("WINDOW#")) {
        const err = new Error("ConditionalCheckFailedException");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });
    ddbMock.on(UpdateCommand).resolves({});
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "input_0", Values: [90] },
        { Id: "output_0", Values: [45] },
      ],
    });

    await handler();

    // No metric emit, no row annotation, no watermark advance — CCF means
    // this exact window was already reconciled.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  test("unmatched model (no CloudWatch datapoints): marker records metricsMissing/null, no fabricated drift, no EstimateDriftPct datum", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [ledgerRow()] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "input_0", Values: [] },
        { Id: "output_0", Values: [] },
      ],
    });

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const markerPut = putCalls.find((c) =>
      String(c.args[0].input.Item?.SK).startsWith("WINDOW#"),
    );
    const marker = markerPut!.args[0].input.Item as LedgerWindowMarkerRow;
    expect(marker.models[0].match).toBe("metricsMissing");
    expect(marker.models[0].driftPct).toBeNull();
    expect(marker.unmatchedModelCount).toBe(1);

    const driftDatum = cwMock
      .commandCalls(PutMetricDataCommand)
      .flatMap((c) => c.args[0].input.MetricData ?? [])
      .find((d) => d.MetricName === "EstimateDriftPct");
    expect(driftDatum).toBeUndefined();
  });

  test("empty window (no ledger rows): marker still created, watermark still advances", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const markerPut = putCalls.find((c) =>
      String(c.args[0].input.Item?.SK).startsWith("WINDOW#"),
    );
    expect(markerPut).toBeDefined();
    expect(
      (markerPut!.args[0].input.Item as LedgerWindowMarkerRow).ledgerRowCount,
    ).toBe(0);

    const watermarkUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.Key?.SK === "WATERMARK");
    expect(watermarkUpdate).toBeDefined();
  });

  test("MAX_WINDOWS_PER_RUN cap is honored on cold-start catch-up, windows processed ascending", async () => {
    process.env.MAX_WINDOWS_PER_RUN = "2";
    ddbMock.on(GetCommand).resolves({
      // Watermark far in the past to force multi-window catch-up.
      Item: { PK: "RECON#COST", SK: "WATERMARK", watermarkEpochSec: 0 },
    });
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await handler();

    const markerPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => String(c.args[0].input.Item?.SK).startsWith("WINDOW#"));
    expect(markerPuts).toHaveLength(2);
    const starts = markerPuts.map(
      (c) =>
        (c.args[0].input.Item as LedgerWindowMarkerRow).windowStartEpochSec,
    );
    expect(starts[0]).toBeLessThan(starts[1]);

    process.env.MAX_WINDOWS_PER_RUN = "6";
  });

  test("annotation resilience: UpdateItem on a vanished row is swallowed as a logged no-op, sweep continues", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [ledgerRow()] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).callsFake((input: UpdateCommandInput) => {
      if (input.Key?.SK === "WATERMARK") return {};
      const err = new Error("ConditionalCheckFailedException");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "input_0", Values: [90] },
        { Id: "output_0", Values: [45] },
      ],
    });

    await expect(handler()).resolves.not.toThrow();
    const watermarkUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.Key?.SK === "WATERMARK");
    expect(watermarkUpdate).toBeDefined();
  });

  test("PutMetricData failure is logged and does not throw — window still counts as reconciled", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [ledgerRow()] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "input_0", Values: [90] },
        { Id: "output_0", Values: [45] },
      ],
    });
    cwMock.on(PutMetricDataCommand).rejects(new Error("throttled"));

    await expect(handler()).resolves.not.toThrow();
    const watermarkUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.Key?.SK === "WATERMARK");
    expect(watermarkUpdate).toBeDefined();
  });

  test("per-window error isolation: a Scan failure on one window does not abort the sweep", async () => {
    process.env.MAX_WINDOWS_PER_RUN = "2";
    ddbMock.on(GetCommand).resolves({
      Item: { PK: "RECON#COST", SK: "WATERMARK", watermarkEpochSec: 0 },
    });
    let call = 0;
    ddbMock.on(ScanCommand).callsFake(() => {
      call += 1;
      if (call === 1) throw new Error("transient scan failure");
      return { Items: [] };
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await expect(handler()).resolves.not.toThrow();
    const markerPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => String(c.args[0].input.Item?.SK).startsWith("WINDOW#"));
    // Second window still got its marker despite the first window's failure.
    expect(markerPuts).toHaveLength(1);

    process.env.MAX_WINDOWS_PER_RUN = "6";
  });
});

describe("tierBReconcile — feature gate (skeleton only)", () => {
  test("returns inactive/disabled when COST_RECONCILER_TIER_B_ENABLED is unset/false, mutates no ledger row", async () => {
    process.env.COST_RECONCILER_TIER_B_ENABLED = "false";
    const result = await tierBReconcile(
      { startSec: 0, endSec: 3600 },
      new Map(),
    );
    expect(result).toEqual({ active: false, reason: "disabled" });
  });

  test("returns inactive/missing_requestId when flag is true but ledger rows lack bedrockRequestId", async () => {
    process.env.COST_RECONCILER_TIER_B_ENABLED = "true";
    const result = await tierBReconcile(
      { startSec: 0, endSec: 3600 },
      new Map([
        [
          "claude-sonnet",
          {
            modelId: "anthropic.claude-sonnet-5",
            inputTokens: 10,
            outputTokens: 5,
            rowKeys: [{ PK: "ORG#a", SK: "s1" }],
          },
        ],
      ]),
    );
    expect(result).toEqual({ active: false, reason: "missing_requestId" });
    process.env.COST_RECONCILER_TIER_B_ENABLED = "false";
  });
});
