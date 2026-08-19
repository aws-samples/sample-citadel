/**
 * Tests for rollback-metrics-reader.ts — per-candidate-arm cost + latency
 * from the cost ledger window (decision D3). Only candidate-arm rows for
 * the given release count; eval-context rows are excluded; unattributed
 * metrics return null (never trigger).
 */
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  percentile,
  readCandidateArmMetrics,
} from "../rollback-metrics-reader";

const ddbMock = mockClient(DynamoDBDocumentClient);

function row(overrides: Record<string, unknown> = {}) {
  return {
    PK: "ORG#org-1",
    releaseId: "rel-candidate",
    releaseArm: "candidate",
    priced: true,
    costMicros: 1000,
    latencyMs: 200,
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  process.env.COST_LEDGER_TABLE = "test-ledger";
});
afterEach(() => {
  delete process.env.COST_LEDGER_TABLE;
});

describe("percentile", () => {
  it("returns nearest-rank p95", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 95)).toBe(95);
  });
  it("returns null for an empty set (never fabricate)", () => {
    expect(percentile([], 95)).toBeNull();
  });
});

describe("readCandidateArmMetrics", () => {
  it("computes cost-per-invocation + p95 latency over candidate-arm rows only", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        row({ costMicros: 1000, latencyMs: 100 }),
        row({ costMicros: 3000, latencyMs: 500 }),
        // stable arm + other release rows are ignored:
        row({ releaseArm: "stable", costMicros: 999999 }),
        row({ releaseId: "rel-other", costMicros: 999999 }),
      ],
    });
    const m = await readCandidateArmMetrics("org-1", "rel-candidate", "a", "b");
    expect(m.sampleCount).toBe(2);
    expect(m.costPerInvocationMicros).toBe(2000); // (1000+3000)/2
    expect(m.modelCallLatencyP95Ms).toBe(500);
  });

  it("excludes eval-context rows (an eval run must never trip a rollback)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        row({ evalContext: true, costMicros: 999999 }),
        row({ costContext: "eval", costMicros: 999999 }),
      ],
    });
    const m = await readCandidateArmMetrics("org-1", "rel-candidate", "a", "b");
    expect(m.sampleCount).toBe(0);
    expect(m.costPerInvocationMicros).toBeNull();
  });

  it("returns null for every unattributed metric (D3/D7/D9)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row()] });
    const m = await readCandidateArmMetrics("org-1", "rel-candidate", "a", "b");
    expect(m.errorRate).toBeNull();
    expect(m.policyViolationFindingRate).toBeNull();
    expect(m.driftScore).toBeNull();
  });
});
