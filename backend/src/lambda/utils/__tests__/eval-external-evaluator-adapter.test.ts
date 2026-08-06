/**
 * eval-external-evaluator-adapter.ts tests (CIT-107) — invokes an
 * org-registered EXTERNAL evaluator (Lambda or HTTP target) through the
 * existing agent-source invocation machinery (secret-backed auth), then
 * runs the raw response through validateExternalScoreVector so a
 * malformed/oversized response never reaches the caller as dimension
 * scores.
 */
import { createExternalEvaluator } from "../eval-external-evaluator-adapter";
import type { CommandSender } from "../../../adapters/agent-source/invoke-support";
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

describe("createExternalEvaluator — LAMBDA_INVOKE target", () => {
  it("invokes the Lambda with the case/artifact/evalCase payload and returns validated scores", async () => {
    const validScore = {
      dimension: "org.acme.tone",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "score", score: 0.8 },
      detail: "positive tone",
    };
    const sender: CommandSender = {
      send: jest.fn().mockResolvedValue({
        Payload: new TextEncoder().encode(JSON.stringify([validScore])),
      }),
    };

    const evaluator = createExternalEvaluator({
      id: "org.acme.tone-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "LAMBDA_INVOKE",
        target: "arn:aws:lambda:ap-southeast-2:111111111111:function:tone-eval",
        auth: { mode: "NONE" },
        mode: "sync",
      },
      lambdaSender: sender,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results).toEqual([validScore]);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("attaches a secret-backed auth header via resolveSecret before invoking an HTTP target", async () => {
    const validScore = {
      dimension: "org.acme.tone",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "boolean", pass: true },
      detail: "ok",
    };
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([validScore]),
    });
    const resolveSecret = jest.fn().mockResolvedValue("super-secret-token");

    const evaluator = createExternalEvaluator({
      id: "org.acme.http-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "HTTP_ENDPOINT",
        target: "https://evaluators.example.com/score",
        auth: {
          mode: "BEARER",
          secretRef: "arn:aws:secretsmanager:...:secret:eval-key",
        },
        mode: "sync",
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveSecret,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );

    expect(results).toEqual([validScore]);
    expect(resolveSecret).toHaveBeenCalledWith(
      "arn:aws:secretsmanager:...:secret:eval-key",
    );
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer super-secret-token");
  });

  it("returns an empty array (never throws, never poisons) when the Lambda response is malformed", async () => {
    const sender: CommandSender = {
      send: jest.fn().mockResolvedValue({
        Payload: new TextEncoder().encode(
          JSON.stringify([
            {
              dimension: "org.acme.tone",
              status: "SCORED",
              basis: "DETERMINISTIC",
              verdict: { kind: "score", score: 99 },
              detail: "bad",
            },
          ]),
        ),
      }),
    };

    const evaluator = createExternalEvaluator({
      id: "org.acme.tone-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "LAMBDA_INVOKE",
        target: "arn:aws:lambda:ap-southeast-2:111111111111:function:tone-eval",
        auth: { mode: "NONE" },
        mode: "sync",
      },
      lambdaSender: sender,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results).toEqual([]);
  });

  it("returns an empty array when the Lambda payload is not valid JSON", async () => {
    const sender: CommandSender = {
      send: jest.fn().mockResolvedValue({
        Payload: new TextEncoder().encode("not json at all {{{"),
      }),
    };

    const evaluator = createExternalEvaluator({
      id: "org.acme.tone-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "LAMBDA_INVOKE",
        target: "arn:aws:lambda:ap-southeast-2:111111111111:function:tone-eval",
        auth: { mode: "NONE" },
        mode: "sync",
      },
      lambdaSender: sender,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results).toEqual([]);
  });

  it("returns an empty array (never throws) when the invocation itself rejects", async () => {
    const sender: CommandSender = {
      send: jest.fn().mockRejectedValue(new Error("network unreachable")),
    };

    const evaluator = createExternalEvaluator({
      id: "org.acme.tone-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "LAMBDA_INVOKE",
        target: "arn:aws:lambda:ap-southeast-2:111111111111:function:tone-eval",
        auth: { mode: "NONE" },
        mode: "sync",
      },
      lambdaSender: sender,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results).toEqual([]);
  });

  it("rejects an HTTP target response that fails structural sanitization (oversized payload)", async () => {
    const hugeArray = Array.from({ length: 10_000 }, (_, i) => ({
      dimension: `org.acme.d${i}`,
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "score", score: 0.1 },
      detail: "x".repeat(2000),
    }));
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(hugeArray),
    });

    const evaluator = createExternalEvaluator({
      id: "org.acme.http-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "HTTP_ENDPOINT",
        target: "https://evaluators.example.com/score",
        auth: { mode: "NONE" },
        mode: "sync",
      },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results).toEqual([]);
  });

  it("drops a well-formed score for a dimension the evaluator did not declare", async () => {
    const declaredScore = {
      dimension: "org.acme.tone",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "score", score: 0.8 },
      detail: "positive tone",
    };
    const smuggledScore = {
      dimension: "org.evil.smuggled",
      status: "SCORED",
      basis: "DETERMINISTIC",
      verdict: { kind: "score", score: 0.5 },
      detail: "not declared by this evaluator",
    };
    const sender: CommandSender = {
      send: jest.fn().mockResolvedValue({
        Payload: new TextEncoder().encode(
          JSON.stringify([declaredScore, smuggledScore]),
        ),
      }),
    };

    const evaluator = createExternalEvaluator({
      id: "org.acme.tone-evaluator",
      dimensions: ["org.acme.tone"],
      invocation: {
        protocol: "LAMBDA_INVOKE",
        target: "arn:aws:lambda:ap-southeast-2:111111111111:function:tone-eval",
        auth: { mode: "NONE" },
        mode: "sync",
      },
      lambdaSender: sender,
    });

    const results = await evaluator.score(
      makeCaseRow(),
      makeArtifact(),
      makeEvalCase(),
    );
    expect(results).toEqual([declaredScore]);
    expect(
      results.find((r) => r.dimension === "org.evil.smuggled"),
    ).toBeUndefined();
  });

  it("throws when constructed with an unsupported invocation protocol", () => {
    expect(() =>
      createExternalEvaluator({
        id: "org.acme.bad-protocol",
        dimensions: [],
        invocation: {
          protocol: "MCP",
          target: "mcp://foo",
          auth: { mode: "NONE" },
          mode: "sync",
        },
      }),
    ).toThrow();
  });
});
