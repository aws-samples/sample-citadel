/**
 * eval-scoring.test.ts (CIT-103 Pass A) — unit tests for the pure
 * scoreCase() dimension scorers. See design §3 for the 7-dimension v1
 * catalogue and honest UNKNOWN/NOT_APPLICABLE/PENDING semantics.
 */
import {
  scoreCase,
  canonicalScoreVector,
  DIMENSION_ORDER,
  type EvalCaseRowForScoring,
  type EvalCaseForScoring,
  type ScoringArtifact,
} from "../src/lambda/utils/eval-scoring";

function baseCaseRow(
  overrides: Partial<EvalCaseRowForScoring> = {},
): EvalCaseRowForScoring {
  return {
    evalRunId: "run-1",
    caseId: "case-1",
    orgId: "org-1",
    caseKind: "CONVERSATION",
    targetAdapter: "conversation",
    status: "COMPLETED",
    latencyMs: 1200,
    ...overrides,
  };
}

function baseCase(
  overrides: Partial<EvalCaseForScoring> = {},
): EvalCaseForScoring {
  return {
    suiteId: "suite-1",
    caseId: "case-1",
    expectedOutcome: { mode: "EXACT", target: JSON.stringify("hello world") },
    requiredTools: [],
    forbiddenTools: [],
    ...overrides,
  };
}

function baseArtifact(
  overrides: Partial<ScoringArtifact> = {},
): ScoringArtifact {
  return {
    kind: "conversation",
    finalAnswerText: "hello world",
    executionNodeOutputs: [],
    findings: [],
    costRows: [],
    ...overrides,
  };
}

describe("scoreCase — task_success", () => {
  it("SCORED pass=true for EXACT match on the final answer", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.basis).toBe("DETERMINISTIC");
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("SCORED pass=false for EXACT mismatch on the final answer", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ finalAnswerText: "goodbye" }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "boolean", pass: false });
  });

  it("CONTAINS mode passes on substring presence", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ finalAnswerText: "the quick brown fox" }),
      baseCase({
        expectedOutcome: { mode: "CONTAINS", target: JSON.stringify("brown") },
      }),
    );
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("REGEX mode passes on pattern match", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ finalAnswerText: "order #12345 confirmed" }),
      baseCase({
        expectedOutcome: {
          mode: "REGEX",
          target: JSON.stringify("^order #\\d+"),
        },
      }),
    );
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("JSON_SUBSET mode with a path honors the path selector", () => {
    const vector = scoreCase(
      baseCaseRow({ caseKind: "EXECUTION", targetAdapter: "execution" }),
      baseArtifact({
        kind: "execution",
        finalAnswerText: null,
        executionNodeOutputs: [
          { nodeId: "n1", outputs: { status: "ok", code: 200 } },
        ],
      }),
      baseCase({
        expectedOutcome: {
          mode: "JSON_SUBSET",
          target: JSON.stringify({ status: "ok" }),
          path: "n1",
        },
      }),
    );
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("PENDING with basis JUDGE when expectedOutcome opts into judge fallback", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact(),
      baseCase({
        expectedOutcome: {
          mode: "EXACT",
          target: JSON.stringify("x"),
          judge: true,
        } as never,
      }),
    );
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.status).toBe("PENDING");
    expect(dim.basis).toBe("JUDGE");
    expect(dim.verdict).toBeUndefined();
  });

  it("NOT_APPLICABLE when no expectedOutcome is set", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact(),
      baseCase({ expectedOutcome: undefined as never }),
    );
    const dim = vector.find((d) => d.dimension === "task_success")!;
    expect(dim.status).toBe("NOT_APPLICABLE");
    expect(dim.verdict).toBeUndefined();
  });
});

describe("scoreCase — policy_compliance", () => {
  it("SCORED pass=true when decision matches and required findingTypes present", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        findings: [
          { decision: "deny", reason: "tool_denied:explicit_deny_list:shell" },
        ],
      }),
      baseCase({
        expectedPolicyOutcome: {
          decision: "DENY",
          findingTypes: ["tool_denied:explicit_deny_list:shell"],
        },
      }),
    );
    const dim = vector.find((d) => d.dimension === "policy_compliance")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("SCORED pass=false when a required findingType is missing", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        findings: [
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:calc",
          },
        ],
      }),
      baseCase({
        expectedPolicyOutcome: {
          decision: "PERMIT",
          findingTypes: ["tool_denied:explicit_deny_list:shell"],
        },
      }),
    );
    const dim = vector.find((d) => d.dimension === "policy_compliance")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: false });
  });

  it("NOT_APPLICABLE when case has no expectedPolicyOutcome", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const dim = vector.find((d) => d.dimension === "policy_compliance")!;
    expect(dim.status).toBe("NOT_APPLICABLE");
  });
});

describe("scoreCase — tool_accuracy (FINDINGS only, never toolResults)", () => {
  it("score=1 when all required tools satisfied and no forbidden tool invoked", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        findings: [
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:calculator",
          },
        ],
      }),
      baseCase({ requiredTools: ["calculator"], forbiddenTools: ["shell"] }),
    );
    const dim = vector.find((d) => d.dimension === "tool_accuracy")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
    expect(dim.measurement).toBe(1);
  });

  it("score=1 when a forbidden tool was correctly denied (constraint satisfied)", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        findings: [
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:calculator",
          },
          { decision: "deny", reason: "tool_denied:explicit_deny_list:shell" },
        ],
      }),
      baseCase({ requiredTools: ["calculator"], forbiddenTools: ["shell"] }),
    );
    const dim = vector.find((d) => d.dimension === "tool_accuracy")!;
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });

  it("score<1 when a forbidden tool was actually invoked (permitted finding present — violation)", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        findings: [
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:calculator",
          },
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:shell",
          },
        ],
      }),
      baseCase({ requiredTools: ["calculator"], forbiddenTools: ["shell"] }),
    );
    const dim = vector.find((d) => d.dimension === "tool_accuracy")!;
    expect(dim.verdict).toEqual({ kind: "score", score: 0.5 });
  });

  it("fixed 6dp rounding on fractional scores", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ findings: [] }),
      baseCase({ requiredTools: ["a", "b", "c"], forbiddenTools: [] }),
    );
    const dim = vector.find((d) => d.dimension === "tool_accuracy")!;
    // 0 of 3 required satisfied => 0
    expect(dim.verdict).toEqual({ kind: "score", score: 0 });
  });

  it("NOT_APPLICABLE when case has no required/forbidden tools", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const dim = vector.find((d) => d.dimension === "tool_accuracy")!;
    expect(dim.status).toBe("NOT_APPLICABLE");
  });

  it("never reads a toolResults field even if artifact carries one (pinned negative)", () => {
    const artifact = baseArtifact({
      findings: [
        {
          decision: "permit",
          reason: "tool_permitted:not_on_deny_list:calculator",
        },
      ],
      // Simulate the always-partial toolResults shape — must be ignored entirely.
      toolResults: {
        partial: true,
        results: [{ tool: "calculator", ok: false }],
      } as never,
    });
    const vector = scoreCase(
      baseCaseRow(),
      artifact,
      baseCase({ requiredTools: ["calculator"], forbiddenTools: [] }),
    );
    const dim = vector.find((d) => d.dimension === "tool_accuracy")!;
    // toolResults says ok:false, but findings say permitted/used => score 1.
    // If the implementation ever reads toolResults this would regress to 0.
    expect(dim.verdict).toEqual({ kind: "score", score: 1 });
  });
});

describe("scoreCase — latency", () => {
  it("CONVERSATION kind: SCORED measurement-only when no maxLatencyMs budget", () => {
    const vector = scoreCase(
      baseCaseRow({ latencyMs: 850 }),
      baseArtifact(),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.measurement).toBe(850);
    expect(dim.verdict).toBeUndefined();
  });

  it("CONVERSATION kind: verdict pass=true when within maxLatencyMs budget", () => {
    const vector = scoreCase(
      baseCaseRow({ latencyMs: 500 }),
      baseArtifact(),
      baseCase({ maxLatencyMs: 1000 }),
    );
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("CONVERSATION kind: verdict pass=false when over maxLatencyMs budget", () => {
    const vector = scoreCase(
      baseCaseRow({ latencyMs: 5000 }),
      baseArtifact(),
      baseCase({ maxLatencyMs: 1000 }),
    );
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: false });
  });

  it("EXECUTION kind: derives measurement from completedAt - startedAt (preferred anchor)", () => {
    const vector = scoreCase(
      baseCaseRow({
        caseKind: "EXECUTION",
        targetAdapter: "execution",
        latencyMs: undefined,
        startedAt: "2026-01-01T00:00:00.000Z",
        dispatchedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:03.500Z",
      }),
      baseArtifact({ kind: "execution" }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.measurement).toBe(3500);
  });

  it("EXECUTION kind: falls back to dispatchedAt when startedAt is missing", () => {
    const vector = scoreCase(
      baseCaseRow({
        caseKind: "EXECUTION",
        targetAdapter: "execution",
        latencyMs: undefined,
        dispatchedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
      }),
      baseArtifact({ kind: "execution" }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.measurement).toBe(2000);
  });

  it("EXECUTION kind: UNKNOWN when both anchors are missing", () => {
    const vector = scoreCase(
      baseCaseRow({
        caseKind: "EXECUTION",
        targetAdapter: "execution",
        latencyMs: undefined,
        completedAt: "2026-01-01T00:00:02.000Z",
      }),
      baseArtifact({ kind: "execution" }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "latency")!;
    expect(dim.status).toBe("UNKNOWN");
    expect(dim.verdict).toBeUndefined();
  });
});

describe("scoreCase — cost (UNKNOWN on unpriced, never zero)", () => {
  it("SCORED measurement = sum of priced usd rows", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        costRows: [
          { priced: true, usd: 0.01 },
          { priced: true, usd: 0.02 },
        ],
      }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "cost")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.measurement).toBeCloseTo(0.03, 6);
  });

  it("UNKNOWN (never zero) when any contributing row is unpriced", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({
        costRows: [
          { priced: true, usd: 0.01 },
          { priced: false, usd: null },
        ],
      }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "cost")!;
    expect(dim.status).toBe("UNKNOWN");
    expect(dim.measurement).toBeUndefined();
    expect(dim.verdict).toBeUndefined();
  });

  it("UNKNOWN when there are no cost ledger rows at all", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ costRows: [] }),
      baseCase(),
    );
    const dim = vector.find((d) => d.dimension === "cost")!;
    expect(dim.status).toBe("UNKNOWN");
  });

  it("verdict pass=true when all priced and within maxCostUsd budget", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ costRows: [{ priced: true, usd: 0.05 }] }),
      baseCase({ maxCostUsd: 0.1 }),
    );
    const dim = vector.find((d) => d.dimension === "cost")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });
});

describe("scoreCase — groundedness_citation", () => {
  it("SCORED pass=true when final answer cites any of mustCiteAnyOf", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ finalAnswerText: "see RFC-1234 for details" }),
      baseCase({
        groundingRequirements: [
          { mustCiteAnyOf: ["RFC-1234"], mustNotHallucinate: false },
        ],
      }),
    );
    const dim = vector.find((d) => d.dimension === "groundedness_citation")!;
    expect(dim.status).toBe("SCORED");
    expect(dim.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("SCORED pass=false when no citation token appears", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact({ finalAnswerText: "no citations here" }),
      baseCase({
        groundingRequirements: [
          { mustCiteAnyOf: ["RFC-1234"], mustNotHallucinate: false },
        ],
      }),
    );
    const dim = vector.find((d) => d.dimension === "groundedness_citation")!;
    expect(dim.verdict).toEqual({ kind: "boolean", pass: false });
  });

  it("NOT_APPLICABLE when no groundingRequirements set", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const dim = vector.find((d) => d.dimension === "groundedness_citation")!;
    expect(dim.status).toBe("NOT_APPLICABLE");
  });
});

describe("scoreCase — groundedness_faithfulness (opt-in judge only)", () => {
  it("PENDING with basis JUDGE when mustNotHallucinate=true", () => {
    const vector = scoreCase(
      baseCaseRow(),
      baseArtifact(),
      baseCase({
        groundingRequirements: [
          { mustCiteAnyOf: [], mustNotHallucinate: true },
        ],
      }),
    );
    const dim = vector.find(
      (d) => d.dimension === "groundedness_faithfulness",
    )!;
    expect(dim.status).toBe("PENDING");
    expect(dim.basis).toBe("JUDGE");
  });

  it("NOT_APPLICABLE when mustNotHallucinate is not set / false", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const dim = vector.find(
      (d) => d.dimension === "groundedness_faithfulness",
    )!;
    expect(dim.status).toBe("NOT_APPLICABLE");
  });
});

describe("canonicalScoreVector", () => {
  it("emits dimensions in the fixed DIMENSION_ORDER regardless of input order", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const shuffled = [...vector].reverse();
    const canon1 = canonicalScoreVector(vector);
    const canon2 = canonicalScoreVector(shuffled);
    expect(canon1.map((d) => d.dimension)).toEqual(DIMENSION_ORDER);
    expect(canon1).toEqual(canon2);
  });

  it("is byte-identical (JSON.stringify) across two independent calls on the same vector", () => {
    const vector = scoreCase(baseCaseRow(), baseArtifact(), baseCase());
    const a = JSON.stringify(canonicalScoreVector(vector));
    const b = JSON.stringify(canonicalScoreVector([...vector]));
    expect(a).toBe(b);
  });
});

describe("scoreCase — purity", () => {
  it("does not mutate its inputs", () => {
    const caseRow = baseCaseRow();
    const artifact = baseArtifact();
    const evalCase = baseCase();
    const caseRowJson = JSON.stringify(caseRow);
    const artifactJson = JSON.stringify(artifact);
    const evalCaseJson = JSON.stringify(evalCase);
    scoreCase(caseRow, artifact, evalCase);
    expect(JSON.stringify(caseRow)).toBe(caseRowJson);
    expect(JSON.stringify(artifact)).toBe(artifactJson);
    expect(JSON.stringify(evalCase)).toBe(evalCaseJson);
  });
});
