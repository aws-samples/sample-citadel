/**
 * CIT-105 artifact read path — pure projection/truncation tests for
 * eval-artifact-view.ts (design memory projects/cit-105-artifacts-design).
 *
 * Pure unit tests only — no I/O, no mocks. Mirrors eval-scoring.test.ts's
 * "pure function, direct input/output assertions" convention.
 */
import {
  projectSideView,
  decodeArtifactCursor,
  encodeArtifactCursor,
  MAX_TRANSCRIPT_BYTES_PER_SIDE,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRAJECTORY_STEPS,
  MAX_STEP_OUTPUT_BYTES,
  type ReplayEnvelopeForView,
} from "../src/lambda/utils/eval-artifact-view";

function conversationEnvelope(
  overrides: Partial<ReplayEnvelopeForView> = {},
): ReplayEnvelopeForView {
  return {
    orgId: "org-1",
    correlationId: "corr-1",
    sanitisation: {
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    },
    sections: {
      nodes: [],
      messages: [
        { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00Z" },
        {
          role: "assistant",
          content: "hi there",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ],
      findings: [],
    },
    ...overrides,
  };
}

function executionEnvelope(
  overrides: Partial<ReplayEnvelopeForView> = {},
): ReplayEnvelopeForView {
  return {
    orgId: "org-1",
    correlationId: "corr-2",
    sanitisation: {
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    },
    sections: {
      nodes: [
        {
          nodeId: "node-b",
          outputs: { result: "b" },
          status: "COMPLETED",
          startedAt: "2026-01-01T00:00:02Z",
          completedAt: "2026-01-01T00:00:03Z",
          agentId: "agent-b",
        },
        {
          nodeId: "node-a",
          outputs: { result: "a" },
          status: "COMPLETED",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:01Z",
          agentId: "agent-a",
        },
        {
          nodeId: "node-c-no-start",
          outputs: { result: "c" },
          status: "COMPLETED",
          startedAt: null,
          completedAt: null,
          agentId: "agent-c",
        },
      ],
      messages: undefined,
      findings: [
        {
          decision: "PERMITTED",
          reason: "tool_permitted:not_on_deny_list:search",
        },
        {
          decision: "PERMITTED",
          reason: "tool_permitted:not_on_deny_list:calculator",
        },
      ],
    },
    ...overrides,
  };
}

// ── Test 1/2: happy path, conversation + execution kinds ────────────────────
describe("projectSideView — happy path", () => {
  test("conversation kind: chronological transcript, empty trajectory, sanitisation surfaced verbatim", () => {
    const view = projectSideView(conversationEnvelope(), "CONVERSATION", {});
    expect(view.transcript.map((m) => m.content)).toEqual([
      "hello",
      "hi there",
    ]);
    expect(view.transcript[0].index).toBe(0);
    expect(view.transcript[1].index).toBe(1);
    expect(view.trajectory).toEqual([]);
    expect(view.sanitisation).toEqual({
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    });
    expect(view.transcriptTruncated).toBe(false);
    expect(view.trajectoryTruncated).toBe(false);
  });

  test("execution kind: empty transcript, trajectory populated from nodes, toolSet populated", () => {
    const view = projectSideView(executionEnvelope(), "EXECUTION", {});
    expect(view.transcript).toEqual([]);
    expect(view.trajectory.length).toBe(3);
    expect(view.toolSet).toEqual(["calculator", "search"]);
  });
});

// ── Test 3: deterministic trajectory ordering ───────────────────────────────
describe("projectSideView — trajectory ordering", () => {
  test("sorted by startedAt, then completedAt, then nodeId; missing startedAt sorts last", () => {
    const view = projectSideView(executionEnvelope(), "EXECUTION", {});
    expect(view.trajectory.map((s) => s.nodeId)).toEqual([
      "node-a",
      "node-b",
      "node-c-no-start",
    ]);
    expect(view.trajectory.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
  });
});

// ── Test 4: toolOrder honest-null ───────────────────────────────────────────
describe("projectSideView — toolOrder honesty", () => {
  test("toolOrder is always null even when findings are present (CIT-121 gap)", () => {
    const view = projectSideView(executionEnvelope(), "EXECUTION", {});
    expect(view.toolOrder).toBeNull();
  });

  test("toolSet sorted + deduped", () => {
    const env = executionEnvelope({
      sections: {
        nodes: [],
        messages: undefined,
        findings: [
          {
            decision: "PERMITTED",
            reason: "tool_permitted:not_on_deny_list:zeta",
          },
          {
            decision: "PERMITTED",
            reason: "tool_permitted:not_on_deny_list:alpha",
          },
          {
            decision: "PERMITTED",
            reason: "tool_permitted:not_on_deny_list:alpha",
          },
        ],
      },
    });
    const view = projectSideView(env, "EXECUTION", {});
    expect(view.toolSet).toEqual(["alpha", "zeta"]);
  });
});

// ── Bounding: truncation + pagination ───────────────────────────────────────
describe("projectSideView — bounding (truncation, never silent)", () => {
  test("transcript exceeding MAX_TRANSCRIPT_MESSAGES is truncated with visible metadata + nextCursor", () => {
    const messages = Array.from(
      { length: MAX_TRANSCRIPT_MESSAGES + 10 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message-${i}`,
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      }),
    );
    const env = conversationEnvelope({
      sections: { nodes: [], messages, findings: [] },
    });
    const view = projectSideView(env, "CONVERSATION", {});
    expect(view.transcriptTruncated).toBe(true);
    expect(view.transcriptReturnedCount).toBe(MAX_TRANSCRIPT_MESSAGES);
    expect(view.transcriptTotalCount).toBe(MAX_TRANSCRIPT_MESSAGES + 10);
    expect(view.transcriptNextCursor).not.toBeNull();
  });

  test("transcript exceeding MAX_TRANSCRIPT_BYTES_PER_SIDE truncates by byte budget", () => {
    const bigContent = "x".repeat(2000);
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      content: bigContent,
      timestamp: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    }));
    const env = conversationEnvelope({
      sections: { nodes: [], messages, findings: [] },
    });
    const view = projectSideView(env, "CONVERSATION", {});
    expect(view.transcriptTruncated).toBe(true);
    expect(view.transcriptReturnedBytes).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_BYTES_PER_SIDE,
    );
    expect(view.transcriptReturnedCount).toBeLessThan(200);
  });

  test("trajectory exceeding MAX_TRAJECTORY_STEPS is truncated with nextCursor", () => {
    const nodes = Array.from({ length: MAX_TRAJECTORY_STEPS + 5 }, (_, i) => ({
      nodeId: `node-${String(i).padStart(4, "0")}`,
      outputs: {},
      status: "COMPLETED",
      startedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      completedAt: null,
      agentId: null,
    }));
    const env = executionEnvelope({
      sections: { nodes, messages: undefined, findings: [] },
    });
    const view = projectSideView(env, "EXECUTION", {});
    expect(view.trajectoryTruncated).toBe(true);
    expect(view.trajectoryReturnedCount).toBe(MAX_TRAJECTORY_STEPS);
    expect(view.trajectoryTotalCount).toBe(MAX_TRAJECTORY_STEPS + 5);
    expect(view.trajectoryNextCursor).not.toBeNull();
  });

  test("per-node output exceeding MAX_STEP_OUTPUT_BYTES is truncated with outputTruncated=true", () => {
    const bigOutput = { blob: "y".repeat(MAX_STEP_OUTPUT_BYTES + 500) };
    const env = executionEnvelope({
      sections: {
        nodes: [
          {
            nodeId: "node-big",
            outputs: bigOutput,
            status: "COMPLETED",
            startedAt: "2026-01-01T00:00:00Z",
            completedAt: null,
            agentId: null,
          },
        ],
        messages: undefined,
        findings: [],
      },
    });
    const view = projectSideView(env, "EXECUTION", {});
    expect(view.trajectory[0].outputTruncated).toBe(true);
  });

  test("per-message content exceeding the slice cap is truncated with truncated=true on that message", () => {
    const bigContent = "z".repeat(MAX_TRANSCRIPT_BYTES_PER_SIDE + 100);
    const env = conversationEnvelope({
      sections: {
        nodes: [],
        messages: [
          {
            role: "user",
            content: bigContent,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        findings: [],
      },
    });
    const view = projectSideView(env, "CONVERSATION", {});
    expect(view.transcript[0].truncated).toBe(true);
  });

  test("pagination: passing transcriptCursor resumes at exact index with identical ordering", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `m-${i}`,
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    const env = conversationEnvelope({
      sections: { nodes: [], messages, findings: [] },
    });
    const firstPage = projectSideView(env, "CONVERSATION", {});
    const cursor = encodeArtifactCursor(3);
    const secondPage = projectSideView(env, "CONVERSATION", {
      transcriptCursor: cursor,
    });
    expect(secondPage.transcript[0].content).toBe("m-3");
    expect(secondPage.transcript.map((m) => m.index)).toEqual([
      3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(secondPage.transcriptTruncated).toBe(false);
    expect(secondPage.transcriptNextCursor).toBeNull();
    void firstPage;
  });

  test("malformed/tampered cursor throws a ValidationError rather than crashing or dumping full content", () => {
    const env = conversationEnvelope();
    expect(() =>
      projectSideView(env, "CONVERSATION", {
        transcriptCursor: "not-base64-json!!",
      }),
    ).toThrow(/ValidationError/);
  });
});

// ── Cursor codec round-trip ──────────────────────────────────────────────────
describe("encodeArtifactCursor / decodeArtifactCursor", () => {
  test("round-trips an index", () => {
    const encoded = encodeArtifactCursor(42);
    expect(decodeArtifactCursor(encoded)).toBe(42);
  });

  test("decodeArtifactCursor throws ValidationError on tampered input", () => {
    expect(() => decodeArtifactCursor("!!!not-valid###")).toThrow(
      /ValidationError/,
    );
  });
});
