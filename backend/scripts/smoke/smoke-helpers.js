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

module.exports = { classifyMessage, shapeReport, withTimeout };
