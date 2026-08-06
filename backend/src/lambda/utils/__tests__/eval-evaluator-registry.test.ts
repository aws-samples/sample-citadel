/**
 * eval-evaluator-registry.ts tests (CIT-107) — pluggable evaluator
 * interface + registry. Mirrors the AgentSourceAdapterRegistry precedent
 * (backend/src/adapters/agent-source/registry-factory.ts + base.ts):
 * register/resolve/has, throwing a typed error on an unknown id.
 */
import {
  EvaluatorRegistry,
  UnknownEvaluatorError,
  type Evaluator,
} from "../eval-evaluator-registry";
import type {
  EvalCaseForScoring,
  EvalCaseRowForScoring,
  ScoringArtifact,
} from "../eval-scoring";

function makeCaseRow(): EvalCaseRowForScoring {
  return {
    evalRunId: "run-1",
    caseId: "case-1",
    orgId: "org-1",
    caseKind: "CONVERSATION",
    targetAdapter: "conversation",
    status: "COMPLETED",
  };
}

function makeArtifact(): ScoringArtifact {
  return {
    kind: "conversation",
    finalAnswerText: "hello",
    executionNodeOutputs: [],
    findings: [],
    costRows: [],
  };
}

function makeEvalCase(): EvalCaseForScoring {
  return {
    suiteId: "suite-1",
    caseId: "case-1",
    requiredTools: [],
    forbiddenTools: [],
  };
}

describe("EvaluatorRegistry", () => {
  it("registers an evaluator and resolves it by id", () => {
    const registry = new EvaluatorRegistry();
    const evaluator: Evaluator = {
      id: "custom.tone",
      dimensions: ["custom.tone"],
      score: () => [],
    };
    registry.register(evaluator);
    expect(registry.resolve("custom.tone")).toBe(evaluator);
  });

  it("has() reflects registration state", () => {
    const registry = new EvaluatorRegistry();
    expect(registry.has("custom.tone")).toBe(false);
    registry.register({ id: "custom.tone", dimensions: [], score: () => [] });
    expect(registry.has("custom.tone")).toBe(true);
  });

  it("throws UnknownEvaluatorError when resolving an unregistered id", () => {
    const registry = new EvaluatorRegistry();
    expect(() => registry.resolve("nope")).toThrow(UnknownEvaluatorError);
  });

  it("list() returns all registered evaluators", () => {
    const registry = new EvaluatorRegistry();
    const a: Evaluator = { id: "a", dimensions: [], score: () => [] };
    const b: Evaluator = { id: "b", dimensions: [], score: () => [] };
    registry.register(a);
    registry.register(b);
    expect(registry.list()).toEqual([a, b]);
  });

  it("register() replaces an existing evaluator registered under the same id", () => {
    const registry = new EvaluatorRegistry();
    const first: Evaluator = { id: "dup", dimensions: [], score: () => [] };
    const second: Evaluator = { id: "dup", dimensions: [], score: () => [] };
    registry.register(first);
    registry.register(second);
    expect(registry.resolve("dup")).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });

  it("runAll() calls every registered evaluator's score() and flattens the results", async () => {
    const registry = new EvaluatorRegistry();
    registry.register({
      id: "one",
      dimensions: ["custom.one"],
      score: () => [
        {
          dimension: "custom.one" as never,
          status: "SCORED",
          basis: "DETERMINISTIC",
          verdict: { kind: "score", score: 0.5 },
          detail: "d",
        },
      ],
    });
    registry.register({
      id: "two",
      dimensions: ["custom.two"],
      score: async () => [
        {
          dimension: "custom.two" as never,
          status: "SCORED",
          basis: "DETERMINISTIC",
          verdict: { kind: "boolean", pass: true },
          detail: "d",
        },
      ],
    });

    const results = await registry.runAll(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    const dims = results.map((r) => r.dimension).sort();
    expect(dims).toEqual(["custom.one", "custom.two"]);
  });

  it("runAll() isolates a throwing evaluator: other evaluators' results still return, error is reported", async () => {
    const registry = new EvaluatorRegistry();
    registry.register({
      id: "bad",
      dimensions: ["custom.bad"],
      score: () => {
        throw new Error("boom");
      },
    });
    registry.register({
      id: "good",
      dimensions: ["custom.good"],
      score: () => [
        {
          dimension: "custom.good" as never,
          status: "SCORED",
          basis: "DETERMINISTIC",
          verdict: { kind: "boolean", pass: true },
          detail: "d",
        },
      ],
    });

    const results = await registry.runAll(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results.map((r) => r.dimension)).toEqual(["custom.good"]);
  });
});
