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
