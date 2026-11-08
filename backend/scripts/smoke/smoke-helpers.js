/**
 * smoke-helpers.js — Pure helper functions for the deployed smoke test.
 *
 * CJS module so that both the ESM smoke script (deployed-smoke.mjs) and
 * the Jest test suite (CJS/ts-jest) can consume it.
 */

"use strict";

/**
 * Classify an incoming AppSync WS message for subscription checks.
 * @returns {"ack"|"turn_accepted"|"agent_message"|"error"|"keepalive"|"other"}
 */
function classifyMessage(msg) {
  if (!msg || typeof msg !== "object") return "other";
  if (msg.type === "connection_ack") return "ack";
  if (msg.type === "ka") return "keepalive";
  if (msg.type === "error" || msg.type === "connection_error") return "error";
  if (msg.type === "start_ack") return "other";
  if (msg.type === "data") {
    const raw = msg.payload?.data;
    if (!raw) return "other";
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const cm = data.onConversationMessage ?? data.sendMessage;
    if (!cm) return "other";
    if (cm.messageType === "TURN_ACCEPTED") return "turn_accepted";
    if (
      cm.messageType === "AGENT_RESPONSE" ||
      cm.messageType === "SYSTEM_NOTIFICATION" ||
      cm.messageType === "PROGRESS_UPDATE"
    ) {
      return "agent_message";
    }
    return "other";
  }
  return "other";
}

/**
 * Shape a final JSON report from an array of check results.
 */
function shapeReport(checks) {
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  return {
    timestamp: new Date().toISOString(),
    checks,
    summary: { total: checks.length, passed, failed },
  };
}

/**
 * Race a promise against a timeout. Rejects with a descriptive error
 * if the timeout fires first.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Classify the outcome of a subscription-negative probe.
 *
 * @param {"start_ack"|"start_error"|"error"|"connection_error"|"timeout"} outcome
 *   The WS message type (or "timeout") observed after sending the subscribe
 *   frame for the zero-project.
 * @returns {{ pass: boolean, error?: string, detail?: string }}
 */
function classifySubNegative(outcome) {
  switch (outcome) {
    case "start_ack":
      return {
        pass: false,
        error:
          "subscription accepted for an unauthorised project; connect-time authoriser missing",
        detail: "start_ack",
      };
    case "start_error":
      return { pass: true, detail: "start_error" };
    case "error":
      return { pass: true, detail: "error" };
    case "connection_error":
      return { pass: true, detail: "connection_error" };
    case "timeout":
      return { pass: false, error: "no response", detail: "timeout" };
    default:
      return {
        pass: false,
        error: `unexpected outcome: ${outcome}`,
        detail: String(outcome),
      };
  }
}

/**
 * Terminal execution statuses as persisted by the arbiter step runner.
 * All lowercase — matches DynamoDB values in executor.py.
 */
const TERMINAL_EXECUTION_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Check whether an execution status string represents a terminal state.
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
function isTerminalExecution(status) {
  return typeof status === "string" && TERMINAL_EXECUTION_STATUSES.has(status);
}

/**
 * Classify a workflow progress event's eventType to determine whether
 * it signals execution-level termination.
 *
 * The fanout Lambda maps EventBridge detail-type directly into the
 * subscription's eventType field:
 *   - "workflow.completed"  → execution completed successfully
 *   - "workflow.failed"     → execution failed
 *   - "workflow.node.*"     → node-level progress, NOT terminal
 *   - "workflow.started"    → execution started, NOT terminal
 *
 * @param {string|null|undefined} eventType
 * @returns {"completed"|"failed"|"progress"|"unknown"}
 */
function classifyWorkflowEvent(eventType) {
  if (eventType === "workflow.completed") return "completed";
  if (eventType === "workflow.failed") return "failed";
  if (typeof eventType === "string" && eventType.startsWith("workflow."))
    return "progress";
  return "unknown";
}

module.exports = {
  classifyMessage,
  classifySubNegative,
  classifyWorkflowEvent,
  isTerminalExecution,
  shapeReport,
  TERMINAL_EXECUTION_STATUSES,
  withTimeout,
};
