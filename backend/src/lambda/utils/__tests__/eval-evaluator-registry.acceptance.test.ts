/**
 * eval-evaluator-registry.acceptance.test.ts (CIT-107) — end-to-end
 * acceptance test for the pluggable evaluator interface story:
 *
 *  - a custom evaluator registers and contributes a dimension to run
 *    reports WITHOUT any change to core scoring/aggregation code
 *    (eval-scoring.ts, eval-score-aggregate.ts are imported UNCHANGED
 *    and their outputs are asserted to be untouched by registering a
 *    custom evaluator);
 *  - a malformed external evaluator's response is rejected and never
 *    poisons the score vector — the run report still contains the
 *    built-in dimensions, scored correctly, with zero contribution from
 *    the malformed evaluator.
 */
import { EvaluatorRegistry } from "../eval-evaluator-registry";
import { builtinEvaluator } from "../eval-builtin-evaluator";
import { createExternalEvaluator } from "../eval-external-evaluator-adapter";
import { composeScoreVector } from "../eval-evaluator-compose";
import { aggregateCustomDimensions } from "../eval-evaluator-aggregate";
import { scoreCase, DIMENSION_ORDER } from "../eval-scoring";
import { aggregateScoreVectors } from "../eval-score-aggregate";
import type {
  EvalCaseForScoring,
  EvalCaseRowForScoring,
  ScoringArtifact,
} from "../eval-scoring";
import type { CommandSender } from "../../../adapters/agent-source/invoke-support";

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

describe("CIT-107 acceptance: custom evaluator contributes a dimension without core changes", () => {
  it("a registered custom in-process evaluator's dimension appears in the composed report; core scorer output is unchanged", async () => {
    const registry = new EvaluatorRegistry();
    registry.register(builtinEvaluator);
    registry.register({
      id: "org.acme.tone",
      dimensions: ["org.acme.tone"],
      score: () => [
        {
          dimension: "org.acme.tone",
          status: "SCORED",
          basis: "DETERMINISTIC",
          verdict: { kind: "boolean", pass: true },
          detail: "friendly tone detected",
        },
      ],
    });

    const caseRow = makeCaseRow();
    const artifact = makeArtifact();
    const evalCase = makeEvalCase();

    const combined = await registry.runAll(caseRow, artifact, evalCase);
    const composed = composeScoreVector(combined);

    // Core, unmodified scoreCase() output is reproduced byte-for-byte
    // inside the composed report — proof that adding the custom
    // evaluator never altered the built-in dimensions' computation.
    const coreOnly = scoreCase(caseRow, artifact, evalCase);
    const composedCanonicalOnly = composed.filter((d) =>
      (DIMENSION_ORDER as readonly string[]).includes(d.dimension),
    );
    expect(composedCanonicalOnly).toEqual(coreOnly);

    // The custom dimension is present, appended after the canonical set.
    expect(composed[composed.length - 1]).toMatchObject({
      dimension: "org.acme.tone",
      status: "SCORED",
    });
    expect(composed).toHaveLength(coreOnly.length + 1);
  });

  it("aggregateScoreVectors (unmodified) plus aggregateCustomDimensions together report both canonical and custom dimensions for a run", async () => {
    const registry = new EvaluatorRegistry();
    registry.register(builtinEvaluator);
    registry.register({
      id: "org.acme.tone",
      dimensions: ["org.acme.tone"],
      score: () => [
        {
          dimension: "org.acme.tone",
          status: "SCORED",
          basis: "DETERMINISTIC",
          verdict: { kind: "boolean", pass: true },
          detail: "d",
        },
      ],
    });

    const caseRow = makeCaseRow();
    const artifact = makeArtifact();
    const evalCase = makeEvalCase();
    const combined = await registry.runAll(caseRow, artifact, evalCase);
    const composed = composeScoreVector(combined);

    const canonicalAgg = aggregateScoreVectors([
      { caseId: "case-1", scoreVector: composed as never },
    ]);
    const customAgg = aggregateCustomDimensions([
      { caseId: "case-1", scores: composed },
    ]);

    expect(canonicalAgg.map((a) => a.dimension)).toEqual([...DIMENSION_ORDER]);
    expect(customAgg).toEqual([
      expect.objectContaining({ dimension: "org.acme.tone", passRate: 1 }),
    ]);
  });
});

describe("CIT-107 acceptance: malformed external evaluator never poisons the score vector", () => {
  it("a malformed Lambda-backed external evaluator contributes nothing; built-in dimensions score normally", async () => {
    const registry = new EvaluatorRegistry();
    registry.register(builtinEvaluator);

    const malformedSender: CommandSender = {
      send: jest.fn().mockResolvedValue({
        Payload: new TextEncoder().encode(
          JSON.stringify([
            {
              dimension: "task_success", // reserved name — must be rejected
              status: "SCORED",
              basis: "DETERMINISTIC",
              verdict: { kind: "boolean", pass: false },
              detail: "trying to overwrite the canonical dimension",
            },
            {
              dimension: "org.acme.hallucinated-score",
              status: "SCORED",
              basis: "DETERMINISTIC",
              verdict: { kind: "score", score: 42 }, // out of [0,1] range
              detail: "malformed",
            },
          ]),
        ),
      }),
    };

    registry.register(
      createExternalEvaluator({
        id: "org.acme.malformed",
        dimensions: ["org.acme.hallucinated-score"],
        invocation: {
          protocol: "LAMBDA_INVOKE",
          target:
            "arn:aws:lambda:ap-southeast-2:111111111111:function:malformed-eval",
          auth: { mode: "NONE" },
          mode: "sync",
        },
        lambdaSender: malformedSender,
      }),
    );

    const caseRow = makeCaseRow();
    const artifact = makeArtifact();
    const evalCase = makeEvalCase();

    const combined = await registry.runAll(caseRow, artifact, evalCase);
    const composed = composeScoreVector(combined);

    // Nothing from the malformed evaluator survived.
    expect(
      composed.find((d) => d.dimension === "org.acme.hallucinated-score"),
    ).toBeUndefined();

    // The canonical task_success entry is the BUILT-IN one (pass:true from
    // the CONTAINS match), never overwritten by the malformed attempt.
    const taskSuccess = composed.find((d) => d.dimension === "task_success");
    expect(taskSuccess?.verdict).toEqual({ kind: "boolean", pass: true });

    // The composed report is otherwise identical to running the core
    // scorer alone — proof the malformed evaluator's rejection was total.
    const coreOnly = scoreCase(caseRow, artifact, evalCase);
    expect(composed).toEqual(coreOnly);
  });

  it("a well-formed score for an undeclared dimension from an external evaluator is dropped, never reaching the composed vector", async () => {
    const registry = new EvaluatorRegistry();
    registry.register(builtinEvaluator);

    const smugglingSender: CommandSender = {
      send: jest.fn().mockResolvedValue({
        Payload: new TextEncoder().encode(
          JSON.stringify([
            {
              dimension: "org.acme.tone", // declared — accepted
              status: "SCORED",
              basis: "DETERMINISTIC",
              verdict: { kind: "score", score: 0.9 },
              detail: "friendly tone",
            },
            {
              dimension: "org.evil.smuggled", // NOT declared — must be dropped
              status: "SCORED",
              basis: "DETERMINISTIC",
              verdict: { kind: "score", score: 0.5 },
              detail: "well-formed but undeclared",
            },
          ]),
        ),
      }),
    };

    registry.register(
      createExternalEvaluator({
        id: "org.acme.tone",
        dimensions: ["org.acme.tone"],
        invocation: {
          protocol: "LAMBDA_INVOKE",
          target:
            "arn:aws:lambda:ap-southeast-2:111111111111:function:tone-eval",
          auth: { mode: "NONE" },
          mode: "sync",
        },
        lambdaSender: smugglingSender,
      }),
    );

    const caseRow = makeCaseRow();
    const artifact = makeArtifact();
    const evalCase = makeEvalCase();

    const combined = await registry.runAll(caseRow, artifact, evalCase);
    const composed = composeScoreVector(combined);

    // The declared dimension is present.
    expect(composed.find((d) => d.dimension === "org.acme.tone")).toMatchObject(
      {
        dimension: "org.acme.tone",
        status: "SCORED",
      },
    );

    // The undeclared, smuggled dimension never reaches the composed vector.
    expect(
      composed.find((d) => d.dimension === "org.evil.smuggled"),
    ).toBeUndefined();
  });
});
