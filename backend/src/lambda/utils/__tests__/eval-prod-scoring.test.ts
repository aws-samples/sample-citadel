/**
 * eval-prod-scoring.ts tests (Phase 2 §2.4) — pure prod-sample scoring.
 *
 * Structural guard (per task scope: "structural guard test"): asserts by
 * REFLECTION over the exported function's declared parameter list that
 * `scoreProdSample` has no `expectedOutcome`/`evalCase` parameter at all —
 * it is impossible BY SIGNATURE to match an expected answer. This mirrors
 * eval-no-composite.guard.test.ts's own style of pinning an invariant via
 * source-text inspection rather than only behavioural assertions.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  scoreProdSample,
  type ProdObservedArtifact,
} from "../eval-prod-scoring";

describe("scoreProdSample — structural no-expected-answer guard", () => {
  it("has arity <= 2 (artifact, agentProfile?) — no case/expectation parameter", () => {
    expect(scoreProdSample.length).toBeLessThanOrEqual(2);
  });

  it("source text never references expectedOutcome/EvalCaseForScoring/matchSpec", () => {
    const src = readFileSync(
      join(__dirname, "..", "eval-prod-scoring.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/expectedOutcome/);
    expect(src).not.toMatch(/EvalCaseForScoring/);
    expect(src).not.toMatch(/MatchSpec/);
  });

  it("never emits a SCORED task_success or tool_accuracy dimension", () => {
    const artifact: ProdObservedArtifact = {
      findings: [{ decision: "deny", reason: "some-policy-reason" }],
      observedTrajectory: {
        steps: [],
        turnCount: 0,
        toolSet: [],
        toolOrder: null,
      },
      kbConsulted: false,
      citationText: "",
      latencyMs: 100,
      costRows: [],
    };
    const vector = scoreProdSample(artifact);
    for (const dim of vector) {
      if (
        dim.dimension === "task_success" ||
        dim.dimension === "tool_accuracy"
      ) {
        expect(dim.status).not.toBe("SCORED");
      }
    }
  });
});

describe("scoreProdSample — allowlisted dimensions", () => {
  const baseArtifact: ProdObservedArtifact = {
    findings: [],
    observedTrajectory: {
      steps: [],
      turnCount: 0,
      toolSet: [],
      toolOrder: null,
    },
    kbConsulted: false,
    citationText: "",
    latencyMs: 500,
    costRows: [],
  };

  it("policy_compliance SCORED pass when no deny/halt finding is present", () => {
    const vector = scoreProdSample(baseArtifact);
    const dim = vector.find((d) => d.dimension === "policy_compliance")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("policy_compliance SCORED fail when a deny finding is present", () => {
    const vector = scoreProdSample({
      ...baseArtifact,
      findings: [{ decision: "deny", reason: "explicit_deny_list:shell" }],
    });
    const dim = vector.find((d) => d.dimension === "policy_compliance")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "boolean", pass: false });
  });

  it("policy_compliance SCORED fail when a halt finding is present", () => {
    const vector = scoreProdSample({
      ...baseArtifact,
      findings: [{ decision: "halt", reason: "circuit_breaker" }],
    });
    const dim = vector.find((d) => d.dimension === "policy_compliance")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: false });
  });

  it("groundedness_citation is NOT_APPLICABLE when no KB tool ran", () => {
    const vector = scoreProdSample(baseArtifact);
    const dim = vector.find((d) => d.dimension === "groundedness_citation")!;
    expect(dim.status).toBe("NOT_APPLICABLE");
  });

  it("groundedness_citation is SCORED when a KB tool ran", () => {
    const vector = scoreProdSample({ ...baseArtifact, kbConsulted: true });
    const dim = vector.find((d) => d.dimension === "groundedness_citation")!;
    expect(dim.status).toBe("SCORED");
  });

  it("groundedness_faithfulness is always PENDING/JUDGE (generic rubric, always opted in for prod samples)", () => {
    const vector = scoreProdSample(baseArtifact);
    const dim = vector.find(
      (d) => d.dimension === "groundedness_faithfulness",
    )!;
    expect(dim.status).toBe("PENDING");
    expect(dim.basis).toBe("JUDGE");
  });

  it("trajectory SCORED via generic noLoop/maxSteps/noRedundantCalls heuristics only", () => {
    const vector = scoreProdSample({
      ...baseArtifact,
      observedTrajectory: {
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "SUCCESS" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "SUCCESS" },
        ],
        turnCount: 0,
        toolSet: [],
        toolOrder: null,
      },
    });
    const dim = vector.find((d) => d.dimension === "trajectory")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.detail).not.toMatch(/dagPath/);
    expect(dim.detail).not.toMatch(/toolSeq/);
  });

  it("trajectory respects an optional agentProfile.maxSteps budget", () => {
    const manySteps = Array.from({ length: 5 }, (_, i) => ({
      stepIndex: i,
      nodeId: `n${i}`,
      agentId: "a1",
      status: "SUCCESS",
    }));
    const vector = scoreProdSample(
      {
        ...baseArtifact,
        observedTrajectory: {
          steps: manySteps,
          turnCount: 0,
          toolSet: [],
          toolOrder: null,
        },
      },
      { maxSteps: 3 },
    );
    const dim = vector.find((d) => d.dimension === "trajectory")!;
    expect(dim.detail).toMatch(/maxSteps:fail/);
  });

  it("latency is measurement-scored from latencyMs", () => {
    const vector = scoreProdSample(baseArtifact);
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.measurement).toBe(500);
  });

  it("cost is UNKNOWN when no cost rows are present", () => {
    const vector = scoreProdSample(baseArtifact);
    const dim = vector.find((d) => d.dimension === "cost")!;
    expect(dim.status).toBe("UNKNOWN");
  });

  it("cost is SCORED from priced cost rows", () => {
    const vector = scoreProdSample({
      ...baseArtifact,
      costRows: [{ priced: true, usd: 0.05 }],
    });
    const dim = vector.find((d) => d.dimension === "cost")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.measurement).toBe(0.05);
  });

  it("is deterministic (pure): identical input yields byte-identical output across repeated calls", () => {
    const a = JSON.stringify(scoreProdSample(baseArtifact));
    const b = JSON.stringify(scoreProdSample(baseArtifact));
    expect(a).toBe(b);
  });
});
