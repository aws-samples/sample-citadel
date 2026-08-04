/**
 * eval-scoring.determinism.property.test.ts (CIT-103 Pass A) — fast-check
 * property: DETERMINISTIC-basis dimensions are byte-equal across repeated
 * scoreCase() calls on identical inputs, and across two independently
 * constructed but structurally-identical inputs (design §5's "same
 * (suite,agent,judge) => byte-equal" acceptance, restricted to the
 * deterministic-basis partition — JUDGE-basis dims are explicitly
 * excluded from equality but asserted to carry the reproducibility
 * stamp fields when they have landed as SCORED).
 */
import fc from "fast-check";
import {
  scoreCase,
  canonicalScoreVector,
  type EvalCaseRowForScoring,
  type EvalCaseForScoring,
  type ScoringArtifact,
  type ScoringFinding,
  type ScoringCostRow,
  type ScoreVector,
} from "../src/lambda/utils/eval-scoring";

function canonicalJSON(vector: ScoreVector): string {
  return JSON.stringify(canonicalScoreVector(vector));
}

function deterministicOnly(vector: ScoreVector): ScoreVector {
  return vector.filter((d) => d.basis === "DETERMINISTIC");
}

const findingArb: fc.Arbitrary<ScoringFinding> = fc.record({
  decision: fc.constantFrom("permit", "deny", "escalate"),
  reason: fc.constantFrom(
    "tool_permitted:not_on_deny_list:calculator",
    "tool_denied:explicit_deny_list:shell",
    "tool_permitted:not_on_deny_list:query_knowledge_base",
    "some_other_reason",
  ),
});

const costRowArb: fc.Arbitrary<ScoringCostRow> = fc.oneof(
  fc.record({
    priced: fc.constant(true),
    usd: fc.float({ min: 0, max: 10, noNaN: true }),
  }),
  fc.record({ priced: fc.constant(false), usd: fc.constant(null) }),
);

const caseRowArb: fc.Arbitrary<EvalCaseRowForScoring> = fc.record({
  evalRunId: fc.constant("run-prop"),
  caseId: fc.constant("case-prop"),
  orgId: fc.constant("org-prop"),
  caseKind: fc.constant("CONVERSATION" as const),
  targetAdapter: fc.constant("conversation" as const),
  status: fc.constant("COMPLETED"),
  latencyMs: fc.integer({ min: 0, max: 60_000 }),
});

const evalCaseArb: fc.Arbitrary<EvalCaseForScoring> = fc.record({
  suiteId: fc.constant("suite-prop"),
  caseId: fc.constant("case-prop"),
  expectedOutcome: fc.record({
    mode: fc.constant("EXACT" as const),
    target: fc.constant(JSON.stringify("expected text")),
  }),
  requiredTools: fc.constant(["calculator"]),
  forbiddenTools: fc.constant(["shell"]),
  maxLatencyMs: fc.integer({ min: 100, max: 60_000 }),
  maxCostUsd: fc.float({ min: 0, max: 10, noNaN: true }),
});

const artifactArb: fc.Arbitrary<ScoringArtifact> = fc.record({
  kind: fc.constant("conversation" as const),
  finalAnswerText: fc.constantFrom("expected text", "something else"),
  executionNodeOutputs: fc.constant([]),
  findings: fc.array(findingArb, { maxLength: 5 }),
  costRows: fc.array(costRowArb, { maxLength: 5 }),
});

describe("scoreCase — determinism property (fast-check)", () => {
  it("self-idempotence: two calls on the SAME input object produce byte-equal deterministic dims", () => {
    fc.assert(
      fc.property(
        caseRowArb,
        artifactArb,
        evalCaseArb,
        (caseRow, artifact, evalCase) => {
          const v1 = scoreCase(caseRow, artifact, evalCase);
          const v2 = scoreCase(caseRow, artifact, evalCase);
          expect(canonicalJSON(deterministicOnly(v1))).toBe(
            canonicalJSON(deterministicOnly(v2)),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("cross-construction: two independently-built but structurally-identical inputs produce byte-equal deterministic dims", () => {
    fc.assert(
      fc.property(
        caseRowArb,
        artifactArb,
        evalCaseArb,
        (caseRow, artifact, evalCase) => {
          // Independent deep clones — simulates two separate reads of the
          // same persisted artifact (e.g. a re-score, design §6).
          const caseRowClone = JSON.parse(JSON.stringify(caseRow));
          const artifactClone = JSON.parse(JSON.stringify(artifact));
          const evalCaseClone = JSON.parse(JSON.stringify(evalCase));

          const v1 = scoreCase(caseRow, artifact, evalCase);
          const v2 = scoreCase(caseRowClone, artifactClone, evalCaseClone);
          expect(canonicalJSON(deterministicOnly(v1))).toBe(
            canonicalJSON(deterministicOnly(v2)),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("negative bite-proof: mutating one artifact field changes at least one deterministic dimension", () => {
    const caseRow: EvalCaseRowForScoring = {
      evalRunId: "run-x",
      caseId: "case-x",
      orgId: "org-x",
      caseKind: "CONVERSATION",
      targetAdapter: "conversation",
      status: "COMPLETED",
      latencyMs: 500,
    };
    const evalCase: EvalCaseForScoring = {
      suiteId: "suite-x",
      caseId: "case-x",
      expectedOutcome: { mode: "EXACT", target: JSON.stringify("hello") },
      requiredTools: [],
      forbiddenTools: [],
    };
    const artifactA: ScoringArtifact = {
      kind: "conversation",
      finalAnswerText: "hello",
      executionNodeOutputs: [],
      findings: [],
      costRows: [],
    };
    const artifactB: ScoringArtifact = {
      ...artifactA,
      finalAnswerText: "goodbye",
    };

    const vA = canonicalJSON(
      deterministicOnly(scoreCase(caseRow, artifactA, evalCase)),
    );
    const vB = canonicalJSON(
      deterministicOnly(scoreCase(caseRow, artifactB, evalCase)),
    );
    expect(vA).not.toBe(vB);
  });

  it("judge-basis dimensions carry the reproducibility stamp whenever landed as SCORED", () => {
    fc.assert(
      fc.property(
        caseRowArb,
        artifactArb,
        evalCaseArb,
        (caseRow, artifact, evalCase) => {
          const vector = scoreCase(caseRow, artifact, evalCase);
          for (const dim of vector.filter((d) => d.basis === "JUDGE")) {
            if (dim.status === "SCORED") {
              expect(dim.judgeModelId).toBeTruthy();
              expect(dim.judgeModelVersion).toBeTruthy();
              expect(dim.judgePromptHash).toBeTruthy();
            }
            // PENDING judge dims never carry stamps yet — no judge response landed.
            if (dim.status === "PENDING") {
              expect(dim.judgeModelId).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
