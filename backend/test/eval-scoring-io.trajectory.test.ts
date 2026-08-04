/**
 * eval-scoring-io.trajectory.test.ts (CIT-103 Phase 1) — unit tests for
 * ObservedTrajectory reconstruction in buildScoringInputs(). Design §1.3:
 * EXECUTION kind reconstructs ordered `steps` from `sections.nodes[]`
 * (ordered by the newly-added startedAt, tiebreak completedAt then
 * nodeId); CONVERSATION kind has no DAG (empty steps, turnCount from
 * assistant messages); toolSet/toolOrder are reconstructed from
 * tool-signal findings only, with toolOrder staying null (honest gap)
 * unless finding rows carry a usable order signal.
 */
import {
  buildScoringInputs,
  type EvalRunCaseRow,
  type EvalCaseRow,
} from "../src/lambda/utils/eval-scoring-io";

function baseRunCaseRow(
  overrides: Partial<EvalRunCaseRow> = {},
): EvalRunCaseRow {
  return {
    evalRunId: "run-1",
    caseId: "case-1",
    orgId: "org-1",
    caseKind: "EXECUTION",
    targetAdapter: "execution",
    status: "COMPLETED",
    suiteId: "suite-1",
    ...overrides,
  };
}

function baseCaseDef(overrides: Partial<EvalCaseRow> = {}): EvalCaseRow {
  return {
    suiteId: "suite-1",
    caseId: "case-1",
    ...overrides,
  };
}

describe("buildScoringInputs — ObservedTrajectory (EXECUTION kind)", () => {
  it("reconstructs steps ordered by startedAt, mapping nodeId/agentId/status", () => {
    const envelope = {
      kind: "execution" as const,
      sections: {
        nodes: [
          {
            nodeId: "n2",
            outputs: null,
            startedAt: "2026-01-01T00:00:02.000Z",
            completedAt: "2026-01-01T00:00:03.000Z",
            agentId: "coder",
            status: "COMPLETED",
          },
          {
            nodeId: "n1",
            outputs: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            agentId: "architect",
            status: "COMPLETED",
          },
        ],
        findings: [],
      },
    };

    const { artifact } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      envelope,
      [],
    );

    expect(artifact.observedTrajectory?.steps).toEqual([
      { stepIndex: 0, nodeId: "n1", agentId: "architect", status: "COMPLETED" },
      { stepIndex: 1, nodeId: "n2", agentId: "coder", status: "COMPLETED" },
    ]);
  });

  it("tiebreaks equal startedAt by completedAt, then by nodeId", () => {
    const envelope = {
      kind: "execution" as const,
      sections: {
        nodes: [
          {
            nodeId: "z",
            outputs: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
            agentId: null,
            status: "COMPLETED",
          },
          {
            nodeId: "a",
            outputs: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
            agentId: null,
            status: "COMPLETED",
          },
        ],
        findings: [],
      },
    };

    const { artifact } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      envelope,
      [],
    );

    expect(artifact.observedTrajectory?.steps.map((s) => s.nodeId)).toEqual([
      "a",
      "z",
    ]);
  });

  it("nodes missing startedAt sort after nodes that have it (stable, never guessed)", () => {
    const envelope = {
      kind: "execution" as const,
      sections: {
        nodes: [
          { nodeId: "no-start", outputs: null, agentId: null, status: null },
          {
            nodeId: "has-start",
            outputs: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            agentId: null,
            status: "COMPLETED",
          },
        ],
        findings: [],
      },
    };

    const { artifact } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      envelope,
      [],
    );

    expect(artifact.observedTrajectory?.steps.map((s) => s.nodeId)).toEqual([
      "has-start",
      "no-start",
    ]);
  });
});

describe("buildScoringInputs — ObservedTrajectory (CONVERSATION kind)", () => {
  it("turnCount reflects the number of assistant messages; steps is empty (no DAG)", () => {
    const envelope = {
      kind: "conversation" as const,
      sections: {
        nodes: [],
        findings: [],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "thanks" },
          { role: "assistant", content: "np" },
        ],
      },
    };

    const { artifact } = buildScoringInputs(
      baseRunCaseRow({
        caseKind: "CONVERSATION",
        targetAdapter: "conversation",
      }),
      baseCaseDef(),
      envelope,
      [],
    );

    expect(artifact.observedTrajectory?.steps).toEqual([]);
    expect(artifact.observedTrajectory?.turnCount).toBe(2);
  });
});

describe("buildScoringInputs — ObservedTrajectory toolSet/toolOrder", () => {
  it("toolSet is a sorted, deduplicated set from tool_permitted findings", () => {
    const envelope = {
      kind: "execution" as const,
      sections: {
        nodes: [],
        findings: [
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:shell",
          },
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:calculator",
          },
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:shell",
          },
          { decision: "deny", reason: "tool_denied:explicit_deny_list:rm" },
        ],
      },
    };

    const { artifact } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      envelope,
      [],
    );

    expect(artifact.observedTrajectory?.toolSet).toEqual([
      "calculator",
      "shell",
    ]);
  });

  it("toolOrder stays null when finding rows carry no usable order signal (honest gap, never guessed)", () => {
    const envelope = {
      kind: "execution" as const,
      sections: {
        nodes: [],
        findings: [
          {
            decision: "permit",
            reason: "tool_permitted:not_on_deny_list:calculator",
          },
        ],
      },
    };

    const { artifact } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      envelope,
      [],
    );

    expect(artifact.observedTrajectory?.toolOrder).toBeNull();
  });

  it("no envelope at all still yields a defined-but-empty ObservedTrajectory (never undefined shape crash)", () => {
    const { artifact } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      undefined,
      [],
    );

    expect(artifact.observedTrajectory).toEqual({
      steps: [],
      turnCount: 0,
      toolSet: [],
      toolOrder: null,
    });
  });
});

describe("buildScoringInputs — trajectorySpec mapping", () => {
  it("maps evalCase.trajectorySpec straight through to evalCaseForScoring", () => {
    const { evalCaseForScoring } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef({
        trajectorySpec: {
          maxSteps: 3,
          noLoop: true,
          toolSequence: { mode: "SET", tools: ["calculator"] },
        },
      }),
      undefined,
      [],
    );

    expect(evalCaseForScoring.trajectorySpec).toEqual({
      maxSteps: 3,
      noLoop: true,
      toolSequence: { mode: "SET", tools: ["calculator"] },
    });
  });

  it("trajectorySpec is undefined when the case defines none", () => {
    const { evalCaseForScoring } = buildScoringInputs(
      baseRunCaseRow(),
      baseCaseDef(),
      undefined,
      [],
    );
    expect(evalCaseForScoring.trajectorySpec).toBeUndefined();
  });
});
