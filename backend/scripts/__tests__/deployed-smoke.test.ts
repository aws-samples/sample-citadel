/**
 * Unit tests for the pure helpers in deployed-smoke.mjs.
 * No network, no real WebSocket — only testing classifyMessage,
 * shapeReport, and withTimeout with fakes.
 */

// CJS helpers — directly importable by ts-jest without ESM gymnastics.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  classifyMessage,
  classifySubNegative,
  shapeReport,
  withTimeout,
} = require("../smoke/smoke-helpers.js");
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------
describe("classifyMessage", () => {
  it("returns 'ack' for connection_ack", () => {
    expect(classifyMessage({ type: "connection_ack" })).toBe("ack");
  });

  it("returns 'keepalive' for ka", () => {
    expect(classifyMessage({ type: "ka" })).toBe("keepalive");
  });

  it("returns 'error' for error type", () => {
    expect(classifyMessage({ type: "error", payload: {} })).toBe("error");
  });

  it("returns 'error' for connection_error type", () => {
    expect(classifyMessage({ type: "connection_error" })).toBe("error");
  });

  it("returns 'turn_accepted' for TURN_ACCEPTED data message", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: {
          data: {
            onConversationMessage: {
              messageType: "TURN_ACCEPTED",
              message: "",
            },
          },
        },
      }),
    ).toBe("turn_accepted");
  });

  it("returns 'agent_message' for AGENT_RESPONSE data message", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: {
          data: {
            onConversationMessage: {
              messageType: "AGENT_RESPONSE",
              message: "hello",
            },
          },
        },
      }),
    ).toBe("agent_message");
  });

  it("returns 'agent_message' for SYSTEM_NOTIFICATION data message", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: {
          data: {
            onConversationMessage: {
              messageType: "SYSTEM_NOTIFICATION",
              message: "info",
            },
          },
        },
      }),
    ).toBe("agent_message");
  });

  it("returns 'agent_message' for PROGRESS_UPDATE data message", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: {
          data: {
            onConversationMessage: {
              messageType: "PROGRESS_UPDATE",
              message: "progress",
            },
          },
        },
      }),
    ).toBe("agent_message");
  });

  it("handles stringified payload.data", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: {
          data: JSON.stringify({
            onConversationMessage: {
              messageType: "TURN_ACCEPTED",
              message: "",
            },
          }),
        },
      }),
    ).toBe("turn_accepted");
  });

  it("returns 'other' for null input", () => {
    expect(classifyMessage(null)).toBe("other");
  });

  it("returns 'other' for unrecognised type", () => {
    expect(classifyMessage({ type: "start_ack" })).toBe("other");
  });

  it("returns 'other' for data message with no onConversationMessage", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: { data: { otherField: {} } },
      }),
    ).toBe("other");
  });

  it("handles sendMessage key in data payload", () => {
    expect(
      classifyMessage({
        type: "data",
        payload: {
          data: {
            sendMessage: {
              messageType: "TURN_ACCEPTED",
              message: "",
            },
          },
        },
      }),
    ).toBe("turn_accepted");
  });
});

// ---------------------------------------------------------------------------
// classifySubNegative
// ---------------------------------------------------------------------------
describe("classifySubNegative", () => {
  it("returns pass:false for start_ack (gate missing)", () => {
    const result = classifySubNegative("start_ack");
    expect(result.pass).toBe(false);
    expect(result.error).toBe(
      "subscription accepted for an unauthorised project; connect-time authoriser missing",
    );
    expect(result.detail).toBe("start_ack");
  });

  it("returns pass:true for start_error (subscription refused)", () => {
    const result = classifySubNegative("start_error");
    expect(result.pass).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.detail).toBe("start_error");
  });

  it("returns pass:true for error (authoriser refusal)", () => {
    const result = classifySubNegative("error");
    expect(result.pass).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.detail).toBe("error");
  });

  it("returns pass:true for connection_error", () => {
    const result = classifySubNegative("connection_error");
    expect(result.pass).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.detail).toBe("connection_error");
  });

  it("returns pass:false for timeout (no response)", () => {
    const result = classifySubNegative("timeout");
    expect(result.pass).toBe(false);
    expect(result.error).toBe("no response");
    expect(result.detail).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// shapeReport
// ---------------------------------------------------------------------------
describe("shapeReport", () => {
  it("shapes a report with all checks passed", () => {
    const checks = [
      { name: "a", pass: true, durationMs: 100 },
      { name: "b", pass: true, durationMs: 200 },
    ];
    const report = shapeReport(checks);
    expect(report.summary).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(report.checks).toEqual(checks);
    expect(report.timestamp).toBeDefined();
  });

  it("shapes a report with mixed results", () => {
    const checks = [
      { name: "a", pass: true, durationMs: 100 },
      { name: "b", pass: false, durationMs: 200, error: "boom" },
    ];
    const report = shapeReport(checks);
    expect(report.summary).toEqual({ total: 2, passed: 1, failed: 1 });
  });

  it("handles empty checks array", () => {
    const report = shapeReport([]);
    expect(report.summary).toEqual({ total: 0, passed: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------
describe("withTimeout", () => {
  it("resolves when promise resolves before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 5000, "test");
    expect(result).toBe("ok");
  });

  it("rejects with timeout error when promise is slow", async () => {
    const slow = new Promise(() => {}); // never resolves, no real timer
    await expect(withTimeout(slow, 50, "test-label")).rejects.toThrow(
      "test-label: timed out after 50ms",
    );
  });

  it("rejects with original error when promise rejects before timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("original")), 5000, "test"),
    ).rejects.toThrow("original");
  });
});

// ---------------------------------------------------------------------------
// Smoke step error-message shaping (smoke finding 3)
//
// The deployed-smoke.mjs script now wraps "not found" errors from
// startExecution and testTool to hint at the env-var to check. These tests
// verify the shaping logic in isolation (pure string matching, no network).
// ---------------------------------------------------------------------------
describe("smoke step error-message shaping", () => {
  /** Mirrors the shaping applied in deployed-smoke.mjs step (5). */
  function shapeStartExecError(message: string, wfId: string): string {
    return /not found/i.test(message)
      ? `workflow ${wfId} not found; check ECHO_WORKFLOW_ID`
      : message;
  }

  /** Mirrors the shaping applied in deployed-smoke.mjs step (4). */
  function shapeTestToolError(
    errMsg: string | undefined,
    toolId: string,
  ): string {
    const msg = errMsg ?? "unknown";
    return /not found/i.test(msg)
      ? `tool ${toolId} not found; check SMOKE_TOOL_ID`
      : `testTool returned error: ${msg}`;
  }

  it("startExecution: rewrites 'Workflow not found' to include ECHO_WORKFLOW_ID hint", () => {
    const msg = shapeStartExecError(
      '[{"message":"Workflow not found"}]',
      "wf-abc",
    );
    expect(msg).toBe("workflow wf-abc not found; check ECHO_WORKFLOW_ID");
  });

  it("startExecution: passes through other errors unchanged", () => {
    const msg = shapeStartExecError("Timeout after 30s", "wf-abc");
    expect(msg).toBe("Timeout after 30s");
  });

  it("testTool: rewrites 'not found' error to include SMOKE_TOOL_ID hint", () => {
    const msg = shapeTestToolError("Tool not found", "tool-xyz");
    expect(msg).toBe("tool tool-xyz not found; check SMOKE_TOOL_ID");
  });

  it("testTool: wraps other errors with prefix", () => {
    const msg = shapeTestToolError("Lambda timeout", "tool-xyz");
    expect(msg).toBe("testTool returned error: Lambda timeout");
  });

  it("testTool: handles undefined error gracefully", () => {
    const msg = shapeTestToolError(undefined, "tool-xyz");
    expect(msg).toBe("testTool returned error: unknown");
  });
});

// ---------------------------------------------------------------------------
// classifyWorkflowEvent
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  classifyWorkflowEvent,
  isTerminalExecution,
} = require("../smoke/smoke-helpers.js");
/* eslint-enable @typescript-eslint/no-require-imports */

describe("classifyWorkflowEvent", () => {
  it("returns 'completed' for workflow.completed", () => {
    expect(classifyWorkflowEvent("workflow.completed")).toBe("completed");
  });

  it("returns 'failed' for workflow.failed", () => {
    expect(classifyWorkflowEvent("workflow.failed")).toBe("failed");
  });

  it("returns 'progress' for workflow.node.completed", () => {
    expect(classifyWorkflowEvent("workflow.node.completed")).toBe("progress");
  });

  it("returns 'progress' for workflow.node.started", () => {
    expect(classifyWorkflowEvent("workflow.node.started")).toBe("progress");
  });

  it("returns 'progress' for workflow.node.failed", () => {
    expect(classifyWorkflowEvent("workflow.node.failed")).toBe("progress");
  });

  it("returns 'progress' for workflow.started", () => {
    expect(classifyWorkflowEvent("workflow.started")).toBe("progress");
  });

  it("returns 'unknown' for null", () => {
    expect(classifyWorkflowEvent(null)).toBe("unknown");
  });

  it("returns 'unknown' for undefined", () => {
    expect(classifyWorkflowEvent(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for EXECUTION_COMPLETED (old wrong shape)", () => {
    expect(classifyWorkflowEvent("EXECUTION_COMPLETED")).toBe("unknown");
  });

  it("returns 'unknown' for EXECUTION_FAILED (old wrong shape)", () => {
    expect(classifyWorkflowEvent("EXECUTION_FAILED")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// isTerminalExecution
// ---------------------------------------------------------------------------
describe("isTerminalExecution", () => {
  it("returns true for 'completed'", () => {
    expect(isTerminalExecution("completed")).toBe(true);
  });

  it("returns true for 'failed'", () => {
    expect(isTerminalExecution("failed")).toBe(true);
  });

  it("returns true for 'cancelled'", () => {
    expect(isTerminalExecution("cancelled")).toBe(true);
  });

  it("returns true for 'timed_out'", () => {
    expect(isTerminalExecution("timed_out")).toBe(true);
  });

  it("returns false for 'running'", () => {
    expect(isTerminalExecution("running")).toBe(false);
  });

  it("returns false for 'pending'", () => {
    expect(isTerminalExecution("pending")).toBe(false);
  });

  it("returns false for uppercase 'COMPLETED' (wrong case)", () => {
    expect(isTerminalExecution("COMPLETED")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isTerminalExecution(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isTerminalExecution(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Workflow execution smoke step: fake integration scenarios
//
// These tests simulate the dual-detection strategy (subscription event
// + getExecution poll) used in deployed-smoke.mjs step (5).
// ---------------------------------------------------------------------------
describe("workflow execution terminal detection (fakes)", () => {
  /**
   * Simulates the smoke step (5) dual-detection logic using fakes.
   *
   * @param {{eventType?: string, delayMs?: number}|null} eventScenario
   *   If non-null, a subscription event is delivered after delayMs.
   * @param {{status: string, pollDelayMs?: number}|null} pollScenario
   *   If non-null, getExecution returns this status after pollDelayMs.
   * @param {number} timeoutMs  Overall timeout cap.
   * @returns {Promise<{pass: boolean, status: string, path: string, error?: string}>}
   */
  async function simulateStep5(eventScenario, pollScenario, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let resolved = false;
      const t0 = Date.now();

      const deadline = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({
            pass: false,
            status: "timeout",
            path: "none",
            error: "Workflow did not reach terminal status within timeout",
          });
        }
      }, timeoutMs);

      function finish(status, path) {
        if (resolved) return;
        resolved = true;
        clearTimeout(deadline);
        if (pollTimer) clearInterval(pollTimer);
        if (eventTimer) clearTimeout(eventTimer);
        const isFailure =
          status === "failed" ||
          status === "cancelled" ||
          status === "timed_out";
        resolve({
          pass: !isFailure,
          status,
          path,
          elapsedMs: Date.now() - t0,
          ...(isFailure ? { error: `Execution ${status}` } : {}),
        });
      }

      // Simulate subscription event delivery
      let eventTimer = null;
      if (eventScenario) {
        eventTimer = setTimeout(() => {
          const cls = classifyWorkflowEvent(eventScenario.eventType);
          if (cls === "completed") finish("completed", "event");
          else if (cls === "failed") finish("failed", "event");
        }, eventScenario.delayMs ?? 50);
      }

      // Simulate polling
      let pollTimer = null;
      if (pollScenario) {
        const pollStart = pollScenario.pollDelayMs ?? 100;
        pollTimer = setTimeout(() => {
          if (!resolved && isTerminalExecution(pollScenario.status)) {
            finish(pollScenario.status, "poll");
          }
        }, pollStart);
      }
    });
  }

  it("completion seen via poll only (no subscription event)", async () => {
    const result = await simulateStep5(null, {
      status: "completed",
      pollDelayMs: 100,
    });
    expect(result.pass).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.path).toBe("poll");
  });

  it("completion seen via event only (no poll result)", async () => {
    const result = await simulateStep5(
      { eventType: "workflow.completed", delayMs: 50 },
      null,
    );
    expect(result.pass).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.path).toBe("event");
  });

  it("failed execution detected via poll → pass:false with 'Execution failed'", async () => {
    const result = await simulateStep5(null, {
      status: "failed",
      pollDelayMs: 100,
    });
    expect(result.pass).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Execution failed");
  });

  it("failed execution detected via event → pass:false with 'Execution failed'", async () => {
    const result = await simulateStep5(
      { eventType: "workflow.failed", delayMs: 50 },
      null,
    );
    expect(result.pass).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Execution failed");
  });

  it("timeout when neither event nor poll delivers terminal status", async () => {
    const result = await simulateStep5(null, null, 200);
    expect(result.pass).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("did not reach terminal status");
  });

  it("event wins the race when both event and poll would deliver", async () => {
    const result = await simulateStep5(
      { eventType: "workflow.completed", delayMs: 30 },
      { status: "completed", pollDelayMs: 200 },
    );
    expect(result.pass).toBe(true);
    expect(result.path).toBe("event");
  });

  it("poll wins the race when event is slower", async () => {
    const result = await simulateStep5(
      { eventType: "workflow.completed", delayMs: 300 },
      { status: "completed", pollDelayMs: 30 },
    );
    expect(result.pass).toBe(true);
    expect(result.path).toBe("poll");
  });

  it("cancelled execution detected via poll → pass:false", async () => {
    const result = await simulateStep5(null, {
      status: "cancelled",
      pollDelayMs: 50,
    });
    expect(result.pass).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("Execution cancelled");
  });

  it("timed_out execution detected via poll → pass:false", async () => {
    const result = await simulateStep5(null, {
      status: "timed_out",
      pollDelayMs: 50,
    });
    expect(result.pass).toBe(false);
    expect(result.status).toBe("timed_out");
    expect(result.error).toBe("Execution timed_out");
  });

  it("node-level event (workflow.node.completed) does NOT cause terminal", async () => {
    const result = await simulateStep5(
      { eventType: "workflow.node.completed", delayMs: 30 },
      null,
      300,
    );
    // Should timeout since node events are progress only
    expect(result.pass).toBe(false);
    expect(result.status).toBe("timeout");
  });
});
