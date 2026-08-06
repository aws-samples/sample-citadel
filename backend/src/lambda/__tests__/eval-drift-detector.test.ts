/**
 * eval-drift-detector.test.ts (Phase 3 §3.2) — scheduled Lambda that
 * queries EvalProdSamples.AgentDimTimeIndex for current-vs-baseline
 * windows per (agent, dimension), emits EMF, and on a breach emits
 * governance.eval.drift.detected.
 *
 * Jest + aws-sdk-client-mock (established convention, see
 * eval-sample-scorer.test.ts). `emitMetrics` is jest.mock'd since it is
 * independently tested by emf.test.ts — here we assert on the call
 * arguments (namespace/dimensions/metrics), not the console.log
 * serialisation. `emitGovernanceEvent` is jest.mock'd too (independently
 * tested).
 *
 * Window math: `now` is fixed at 2026-08-04T12:00:00Z. With
 * `currentWindowHours=24` the current window is
 * [2026-08-03T12, 2026-08-04T12]. With `baselineLagHours=48` and
 * `baselineWindowHours=24` the baseline window is
 * [2026-08-01T12, 2026-08-02T12]. The two windows never overlap.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

process.env.EVAL_PROD_SAMPLES_TABLE = "eval-prod-samples-test";
process.env.ENVIRONMENT = "test";

jest.mock("../../utils/emf", () => ({
  emitMetrics: jest.fn(),
}));
jest.mock("../../utils/notifier-base", () => ({
  emitGovernanceEvent: jest.fn(),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

import { emitMetrics } from "../../utils/emf";
import { emitGovernanceEvent } from "../../utils/notifier-base";
import { runDriftDetection } from "../eval-drift-detector";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const WINDOW_OPTS = {
  now: NOW,
  currentWindowHours: 24,
  baselineLagHours: 48,
  baselineWindowHours: 24,
};

function prodSampleRow(opts: {
  agentId: string;
  capturedAt: string;
  sampleId: string;
  scoreVector: Array<{
    dimension: string;
    status: string;
    verdict?:
      { kind: "boolean"; pass: boolean } | { kind: "score"; score: number };
  }>;
}) {
  return {
    PK: `ORG#org1`,
    SK: `${opts.capturedAt}#${opts.sampleId}`,
    orgId: "org1",
    agentId: opts.agentId,
    runId: `run-${opts.sampleId}`,
    kind: "execution",
    scoreVector: JSON.stringify(opts.scoreVector),
    capturedAt: opts.capturedAt,
    GSI1PK: `AGENT#${opts.agentId}`,
    GSI1SK: `${opts.capturedAt.slice(0, 13)}#${opts.sampleId}`,
  };
}

/** Baseline rows sit at 2026-08-01T12..21 (inside [08-01T12,08-02T12)),
 * current rows sit at 2026-08-03T12..21 (inside [08-03T12,08-04T12)). */
function makeRows(
  agentId: string,
  day: "baseline" | "current",
  passPredicate: (i: number) => boolean,
) {
  const datePrefix = day === "baseline" ? "2026-08-01" : "2026-08-03";
  return Array.from({ length: 10 }, (_, i) =>
    prodSampleRow({
      agentId,
      capturedAt: `${datePrefix}T1${i}:00:00.000Z`,
      sampleId: `${day}-${i}`,
      scoreVector: [
        {
          dimension: "policy_compliance",
          status: "SCORED",
          verdict: { kind: "boolean", pass: passPredicate(i) },
        },
      ],
    }),
  );
}

function mockQueriesByAgent(
  rowsByAgentAndWindow: Record<
    string,
    { baseline: unknown[]; current: unknown[] }
  >,
) {
  ddbMock.on(QueryCommand).callsFake((input) => {
    const agentKey = (
      input.ExpressionAttributeValues?.[":agent"] as string
    )?.replace("AGENT#", "");
    const from = input.ExpressionAttributeValues?.[":from"] as string;
    const entry = rowsByAgentAndWindow[agentKey];
    if (!entry) return { Items: [] };
    // Baseline window starts 2026-08-01..., current window starts 2026-08-03...
    if (from.startsWith("2026-08-01")) return { Items: entry.baseline };
    return { Items: entry.current };
  });
}

describe("runDriftDetection", () => {
  beforeEach(() => {
    ddbMock.reset();
    jest.clearAllMocks();
  });

  it("emits EMF for every (agent, dimension) pair queried and no drift.detected when within threshold", async () => {
    mockQueriesByAgent({
      "agent-1": {
        baseline: makeRows("agent-1", "baseline", () => true),
        current: makeRows("agent-1", "current", () => true),
      },
    });

    await runDriftDetection({
      agentIds: ["agent-1"],
      dimensions: ["policy_compliance"],
      ...WINDOW_OPTS,
    });

    expect(emitMetrics).toHaveBeenCalled();
    const call = (emitMetrics as jest.Mock).mock.calls[0][0];
    expect(call.namespace).toBe("Citadel/EvalDrift");
    expect(call.dimensions).toEqual({
      Environment: "test",
      AgentId: "agent-1",
      Dimension: "policy_compliance",
    });
    expect(emitGovernanceEvent).not.toHaveBeenCalled();
  });

  it("emits governance.eval.drift.detected within one cycle when current regresses past threshold", async () => {
    mockQueriesByAgent({
      "agent-1": {
        // Baseline: all 10 pass (passRate=1.0). Current: only 2/10 pass
        // (passRate=0.2) — a 0.8 regression, well past the 0.15 default.
        baseline: makeRows("agent-1", "baseline", () => true),
        current: makeRows("agent-1", "current", (i) => i < 2),
      },
    });

    await runDriftDetection({
      agentIds: ["agent-1"],
      dimensions: ["policy_compliance"],
      ...WINDOW_OPTS,
    });

    expect(emitGovernanceEvent).toHaveBeenCalledWith(
      "governance.eval.drift.detected",
      expect.objectContaining({
        agentId: "agent-1",
        dimension: "policy_compliance",
      }),
    );
  });

  it("emits the pinned metric NAMES on a breach cycle — including DriftDelta, the name EvalDriftAlarm consumes", async () => {
    mockQueriesByAgent({
      "agent-1": {
        baseline: makeRows("agent-1", "baseline", () => true),
        current: makeRows("agent-1", "current", (i) => i < 2),
      },
    });

    await runDriftDetection({
      agentIds: ["agent-1"],
      dimensions: ["policy_compliance"],
      ...WINDOW_OPTS,
    });

    const call = (emitMetrics as jest.Mock).mock.calls[0][0];
    const names = (call.metrics as Array<{ name: string }>).map((m) => m.name);
    // Alarm/dashboard contract: these literal names are what
    // telemetry-stack.ts's EvalDriftAlarm and any dashboard query by.
    expect(names).toContain("DriftDelta");
    expect(names).toContain("PassRate");
    expect(names).toContain("BaselinePassRate");
    expect(names).toContain("SampleCount");
  });

  it("never throws when a single agent/dimension query fails — continues with the rest (failure isolation)", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("boom"));

    await expect(
      runDriftDetection({
        agentIds: ["agent-1", "agent-2"],
        dimensions: ["policy_compliance"],
        ...WINDOW_OPTS,
      }),
    ).resolves.not.toThrow();

    expect(emitGovernanceEvent).not.toHaveBeenCalled();
  });

  it("is idempotent per cycle: running the same cycle twice with unchanged data emits the same breach decision both times (no double-counting)", async () => {
    mockQueriesByAgent({
      "agent-1": {
        baseline: makeRows("agent-1", "baseline", () => true),
        current: makeRows("agent-1", "current", (i) => i < 2),
      },
    });

    await runDriftDetection({
      agentIds: ["agent-1"],
      dimensions: ["policy_compliance"],
      ...WINDOW_OPTS,
    });
    await runDriftDetection({
      agentIds: ["agent-1"],
      dimensions: ["policy_compliance"],
      ...WINDOW_OPTS,
    });

    expect(emitGovernanceEvent).toHaveBeenCalledTimes(2);
    const firstPayload = (emitGovernanceEvent as jest.Mock).mock.calls[0][1];
    const secondPayload = (emitGovernanceEvent as jest.Mock).mock.calls[1][1];
    expect(firstPayload).toEqual(secondPayload);
  });
});
