/**
 * eval-trajectory.test.ts (CIT-103 Phase 1) — unit tests for the pure
 * scoreTrajectory() dimension scorer. See design §1 (trajectory as an
 * 8th DETERMINISTIC dimension) — sub-assertions from `trajectorySpec`
 * (toolSequence SET/SUBSEQUENCE/STRICT, dagPath, maxSteps, noLoop,
 * noRedundantCalls) are each evaluated against a reconstructed
 * ObservedTrajectory. Ordered assertions (SUBSEQUENCE/STRICT
 * toolSequence) MUST degrade to UNKNOWN (not counted evaluable, never
 * guessed) whenever `toolOrder` is unavailable — this is the honest-gap
 * discipline pinned throughout eval-scoring.ts.
 */
import {
  scoreTrajectory,
  type ObservedTrajectory,
  type TrajectorySpecForScoring,
} from "../src/lambda/utils/eval-trajectory";

function baseObserved(
  overrides: Partial<ObservedTrajectory> = {},
): ObservedTrajectory {
  return {
    steps: [],
    turnCount: 0,
    toolSet: [],
    toolOrder: null,
    ...overrides,
  };
}

describe("scoreTrajectory — NOT_APPLICABLE", () => {
  it("NOT_APPLICABLE when the case has no trajectorySpec", () => {
    const dim = scoreTrajectory(baseObserved(), undefined);
    expect(dim.dimension).toBe("trajectory");
    expect(dim.status).toBe("NOT_APPLICABLE");
    expect(dim.basis).toBe("DETERMINISTIC");
    expect(dim.verdict).toBeUndefined();
  });
});

describe("scoreTrajectory — maxSteps", () => {
  it("SCORED score=1 when steps.length is within maxSteps", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { maxSteps: 3 },
    );
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });

  it("SCORED score=0 (evaluable) when steps.length exceeds maxSteps", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 2, nodeId: "n3", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { maxSteps: 2 },
    );
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
    expect(dim.detail).toContain("maxSteps:fail");
  });

  it("CONVERSATION-derived turnCount is used as the step count for maxSteps", () => {
    const dim = scoreTrajectory(baseObserved({ turnCount: 4 }), {
      maxSteps: 4,
    });
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });

  it("EXECUTION-kind exact boundary: steps.length === maxSteps passes (<=, not <)", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { maxSteps: 2 },
    );
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });
});

describe("scoreTrajectory — noLoop", () => {
  it("pass when no nodeId repeats across steps", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { noLoop: true },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
    expect(dim.detail).toContain("noLoop:pass");
  });

  it("fail when a nodeId repeats across steps (a loop occurred)", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 2, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { noLoop: true },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
    expect(dim.detail).toContain("noLoop:fail");
  });
});

describe("scoreTrajectory — noRedundantCalls", () => {
  it("pass when no two consecutive steps share (nodeId, agentId)", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n1", agentId: "a2", status: "COMPLETED" },
        ],
      }),
      { noRedundantCalls: true },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });

  it("fail when two consecutive steps share the same (nodeId, agentId)", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { noRedundantCalls: true },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
    expect(dim.detail).toContain("noRedundantCalls:fail");
  });

  it("pass on NON-consecutive repeats of the same (nodeId, agentId) — only adjacency is redundant", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 2, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { noRedundantCalls: true },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
    expect(dim.detail).toContain("noRedundantCalls:pass");
  });
});

describe("scoreTrajectory — dagPath", () => {
  it("pass when the observed ordered nodeId sequence equals the expected dagPath", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { dagPath: ["n1", "n2"] },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
    expect(dim.detail).toContain("dagPath:pass");
  });

  it("fail when the observed ordered nodeId sequence diverges from dagPath", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { dagPath: ["n1", "n2"] },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
    expect(dim.detail).toContain("dagPath:fail");
  });

  it("NOT_APPLICABLE contribution (not counted evaluable) for CONVERSATION kind (no steps, only turnCount)", () => {
    const dim = scoreTrajectory(baseObserved({ turnCount: 2, steps: [] }), {
      dagPath: ["n1", "n2"],
      maxSteps: 2,
    });
    // dagPath is not evaluable without a DAG (steps empty + turnCount>0
    // signals CONVERSATION kind) — only maxSteps contributes.
    expect(dim.status).toBe("SCORED");
    expect(dim.detail).toContain("dagPath:na");
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });
});

describe("scoreTrajectory — toolSequence SET mode (always evaluable)", () => {
  it("pass when observed toolSet is a superset-equal match of spec.tools (set membership)", () => {
    const dim = scoreTrajectory(
      baseObserved({ toolSet: ["calculator", "query_knowledge_base"] }),
      { toolSequence: { mode: "SET", tools: ["calculator"] } },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });

  it("fail when a required tool in the SET is absent from the observed toolSet", () => {
    const dim = scoreTrajectory(baseObserved({ toolSet: ["calculator"] }), {
      toolSequence: { mode: "SET", tools: ["calculator", "shell"] },
    });
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
  });
});

describe("scoreTrajectory — toolSequence SUBSEQUENCE/STRICT degrade to UNKNOWN when unordered", () => {
  it("SUBSEQUENCE mode contributes UNKNOWN (not counted evaluable) when toolOrder is null", () => {
    const dim = scoreTrajectory(
      baseObserved({ toolOrder: null, toolSet: ["calculator", "shell"] }),
      { toolSequence: { mode: "SUBSEQUENCE", tools: ["calculator", "shell"] } },
    );
    // No other sub-assertion present and the only one is unordered+unknown
    // => overall UNKNOWN (never fabricated as score=0).
    expect(dim.status).toBe("UNKNOWN");
    expect(dim.verdict).toBeUndefined();
    expect(dim.detail).toContain("toolSeq:unknown");
  });

  it("STRICT mode contributes UNKNOWN when toolOrder is null", () => {
    const dim = scoreTrajectory(baseObserved({ toolOrder: null }), {
      toolSequence: { mode: "STRICT", tools: ["calculator", "shell"] },
    });
    expect(dim.status).toBe("UNKNOWN");
    expect(dim.verdict).toBeUndefined();
  });

  it("SUBSEQUENCE mode is evaluable and can pass when toolOrder IS available", () => {
    const dim = scoreTrajectory(
      baseObserved({ toolOrder: ["calculator", "query_kb", "shell"] }),
      { toolSequence: { mode: "SUBSEQUENCE", tools: ["calculator", "shell"] } },
    );
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });

  it("STRICT mode fails when toolOrder is available but not exactly equal", () => {
    const dim = scoreTrajectory(
      baseObserved({ toolOrder: ["calculator", "shell"] }),
      { toolSequence: { mode: "STRICT", tools: ["shell", "calculator"] } },
    );
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
  });

  it("STRICT mode passes when toolOrder exactly equals the spec order", () => {
    const dim = scoreTrajectory(
      baseObserved({ toolOrder: ["calculator", "shell"] }),
      { toolSequence: { mode: "STRICT", tools: ["calculator", "shell"] } },
    );
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });
});

describe("scoreTrajectory — overall UNKNOWN when every sub-assertion is unevaluable", () => {
  it("UNKNOWN when spec only requests ordered toolSequence and no ordering signal exists", () => {
    const dim = scoreTrajectory(baseObserved({ toolOrder: null }), {
      toolSequence: { mode: "STRICT", tools: ["a", "b"] },
    });
    expect(dim.status).toBe("UNKNOWN");
    expect(dim.verdict).toBeUndefined();
    expect(dim.basis).toBe("DETERMINISTIC");
  });
});

describe("scoreTrajectory — multi-subcheck aggregation", () => {
  it("combines multiple evaluable sub-assertions into a fractional score", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
        ],
        toolSet: ["calculator"],
      }),
      {
        maxSteps: 2, // pass
        noLoop: true, // pass
        dagPath: ["n1", "n3"], // fail
        toolSequence: { mode: "SET", tools: ["calculator"] }, // pass
      },
    );
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 0.75 });
    expect(dim.detail).toContain("evaluable=3/4");
  });

  it("detail is bounded, sorted, and timestamp-free (byte-stable)", () => {
    const dim = scoreTrajectory(
      baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
        ],
      }),
      { maxSteps: 1, noLoop: true },
    );
    expect(dim.detail.length).toBeLessThanOrEqual(1024);
    expect(dim.detail).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamps
  });
});

describe("scoreTrajectory — purity", () => {
  it("does not mutate its inputs and is deterministic across repeated calls", () => {
    const observed = baseObserved({
      steps: [
        { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
        { stepIndex: 1, nodeId: "n2", agentId: "a1", status: "COMPLETED" },
      ],
      toolSet: ["calculator"],
    });
    const spec: TrajectorySpecForScoring = {
      maxSteps: 2,
      noLoop: true,
      dagPath: ["n1", "n2"],
      toolSequence: { mode: "SET", tools: ["calculator"] },
    };
    const observedJson = JSON.stringify(observed);
    const specJson = JSON.stringify(spec);
    const d1 = scoreTrajectory(observed, spec);
    const d2 = scoreTrajectory(observed, spec);
    expect(JSON.stringify(observed)).toBe(observedJson);
    expect(JSON.stringify(spec)).toBe(specJson);
    expect(d1).toEqual(d2);
  });

  it("cross-construction determinism: independently-built structurally-identical inputs → byte-equal verdict", () => {
    const build = () => ({
      observed: baseObserved({
        steps: [
          { stepIndex: 0, nodeId: "n1", agentId: "a1", status: "COMPLETED" },
          { stepIndex: 1, nodeId: "n2", agentId: "a2", status: "COMPLETED" },
        ],
        toolSet: ["calculator", "shell"],
        toolOrder: ["calculator", "shell"],
      }),
      spec: {
        maxSteps: 3,
        noLoop: true,
        noRedundantCalls: true,
        dagPath: ["n1", "n2"],
        toolSequence: { mode: "STRICT", tools: ["calculator", "shell"] },
      } as TrajectorySpecForScoring,
    });
    const a = build();
    const b = build(); // fresh objects, no shared references
    const d1 = scoreTrajectory(a.observed, a.spec);
    const d2 = scoreTrajectory(b.observed, b.spec);
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
  });
});
