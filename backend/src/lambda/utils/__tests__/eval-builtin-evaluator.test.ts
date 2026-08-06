/**
 * eval-builtin-evaluator.ts tests (CIT-107) — adapts the existing
 * scoreCase() pure function (eval-scoring.ts) to the Evaluator interface
 * WITHOUT reimplementing any dimension logic.
 */
import { builtinEvaluator } from "../eval-builtin-evaluator";
import { DIMENSION_ORDER, scoreCase } from "../eval-scoring";
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
    finalAnswerText: "hello world",
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
    expectedOutcome: { mode: "CONTAINS", target: "hello" },
  };
}

describe("builtinEvaluator", () => {
  it("has a stable id", () => {
    expect(builtinEvaluator.id).toBe("builtin.core");
  });

  it("declares all 8 DIMENSION_ORDER dimensions", () => {
    expect(builtinEvaluator.dimensions).toEqual([...DIMENSION_ORDER]);
  });

  it("score() delegates to scoreCase() and returns byte-identical results", () => {
    const caseRow = makeCaseRow();
    const artifact = makeArtifact();
    const evalCase = makeEvalCase();

    const result = builtinEvaluator.score(caseRow, artifact, evalCase);

    const taskSuccess = result.find((d) => d.dimension === "task_success");
    expect(taskSuccess?.status).toBe("SCORED");
    expect(taskSuccess?.verdict).toEqual({ kind: "boolean", pass: true });
  });

  it("score() output matches scoreCase() output exactly for the same inputs", () => {
    const caseRow = makeCaseRow();
    const artifact = makeArtifact();
    const evalCase = makeEvalCase();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const direct = scoreCase(caseRow, artifact, evalCase);
    const viaEvaluator = builtinEvaluator.score(caseRow, artifact, evalCase);

    expect(viaEvaluator).toEqual(direct);
  });
});
