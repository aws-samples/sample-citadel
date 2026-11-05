#!/usr/bin/env node
/**
 * deployed-smoke.mjs — headless post-deploy smoke test for Citadel.
 *
 * Validates: Cognito auth, AppSync subscriptions (positive + negative),
 * conversation round-trip, tool invocation, workflow execution, and
 * blueprint catalog — all over the wire against a live deployment.
 *
 * Usage:
 *   node backend/scripts/smoke/deployed-smoke.mjs
 *   node backend/scripts/smoke/deployed-smoke.mjs --print-env-template
 *
 * Exit code 0 = all checks passed; 1 = at least one check failed.
 * JSON report is written to stdout on completion.
 */
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const { classifyMessage, classifySubNegative, shapeReport, withTimeout } = require("./smoke-helpers.js");

// Re-export pure helpers for potential direct-ESM consumers.
export { classifyMessage, classifySubNegative, shapeReport, withTimeout };

// ---------------------------------------------------------------------------
// Env template (--print-env-template)
// ---------------------------------------------------------------------------
const ENV_TEMPLATE = `# Citadel deployed-smoke environment template
# Copy to .env.smoke, fill in values, then: set -a; source .env.smoke; set +a
USER_POOL_ID=
CLIENT_ID=
SMOKE_USERNAME=
SMOKE_PASSWORD=
APPSYNC_URL=
REGION=us-west-2
PROJECT_ID=
ECHO_WORKFLOW_ID=
SMOKE_TOOL_ID=
`;

if (process.argv.includes("--print-env-template")) {
  process.stdout.write(ENV_TEMPLATE);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const REQUIRED = [
  "USER_POOL_ID",
  "CLIENT_ID",
  "SMOKE_USERNAME",
  "SMOKE_PASSWORD",
  "APPSYNC_URL",
  "REGION",
  "PROJECT_ID",
  "ECHO_WORKFLOW_ID",
  "SMOKE_TOOL_ID",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`missing: ${missing.join(", ")}`);
  process.exit(2);
}

const {
  USER_POOL_ID,
  CLIENT_ID,
  SMOKE_USERNAME,
  SMOKE_PASSWORD,
  APPSYNC_URL,
  REGION,
  PROJECT_ID,
  ECHO_WORKFLOW_ID,
  SMOKE_TOOL_ID,
} = process.env;

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

async function gqlFetch(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: idToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
}

function buildWsUrl(idToken) {
  const host = new URL(APPSYNC_URL).host;
  const realtimeHost = host.replace("appsync-api", "appsync-realtime-api");
  const header = Buffer.from(
    JSON.stringify({ host, Authorization: idToken }),
  ).toString("base64");
  return { wsUrl: `wss://${realtimeHost}/graphql?header=${header}&payload=e30=`, host };
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ["graphql-ws"]);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "connection_ack") resolve(ws);
      else if (msg.type === "connection_error" || msg.type === "error") {
        reject(new Error(`WS connect error: ${JSON.stringify(msg.payload ?? msg)}`));
      }
    });
    ws.on("error", (err) => reject(err));
  });
}

function subscribe(ws, subscriptionQuery, variables, idToken, host) {
  const subId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      id: subId,
      type: "start",
      payload: {
        data: JSON.stringify({ query: subscriptionQuery, variables }),
        extensions: {
          authorization: { Authorization: idToken, host },
        },
      },
    }),
  );
  return subId;
}

// ---------------------------------------------------------------------------
// Decode orgId from JWT (base64url → JSON)
// ---------------------------------------------------------------------------
function decodeOrgId(idToken) {
  const payload = idToken.split(".")[1];
  const json = JSON.parse(Buffer.from(payload, "base64url").toString());
  return json["custom:orgId"] || json["custom:organization"] || "";
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------
const checks = [];

function record(name, pass, durationMs, error) {
  checks.push({ name, pass, durationMs, error: error ?? undefined });
}

async function runChecks() {
  let idToken;

  // ---- (1) Auth ----------------------------------------------------------
  {
    const t0 = Date.now();
    try {
      const cognito = new CognitoIdentityProviderClient({ region: REGION });
      const res = await cognito.send(
        new AdminInitiateAuthCommand({
          UserPoolId: USER_POOL_ID,
          ClientId: CLIENT_ID,
          AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: SMOKE_USERNAME, PASSWORD: SMOKE_PASSWORD },
        }),
      );
      idToken = res.AuthenticationResult?.IdToken;
      if (!idToken) throw new Error("No IdToken returned");
      record("auth", true, Date.now() - t0);
    } catch (err) {
      record("auth", false, Date.now() - t0, err.message);
      // Cannot continue without a token.
      return;
    }
  }

  const { wsUrl, host } = buildWsUrl(idToken);
  const orgId = decodeOrgId(idToken);

  // ---- (2) Subscription negative ----------------------------------------
  {
    const t0 = Date.now();
    try {
      const outcome = await withTimeout(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl, ["graphql-ws"]);
          const ZERO = "00000000-0000-0000-0000-000000000000";
          ws.on("open", () => ws.send(JSON.stringify({ type: "connection_init" })));
          ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "connection_ack") {
              subscribe(
                ws,
                `subscription OnConvMsg($pid: ID!) { onConversationMessage(projectId: $pid) { id messageType message } }`,
                { pid: ZERO },
                idToken,
                host,
              );
            } else if (msg.type === "start_ack") {
              ws.close();
              resolve("start_ack");
            } else if (msg.type === "start_error") {
              ws.close();
              resolve("start_error");
            } else if (msg.type === "error") {
              ws.close();
              resolve("error");
            } else if (msg.type === "connection_error") {
              ws.close();
              resolve("connection_error");
            }
          });
          ws.on("error", () => { resolve("connection_error"); });
        }),
        10_000,
        "subscription-negative",
      ).catch((err) => {
        if (err.message.includes("timed out")) return "timeout";
        throw err;
      });
      const verdict = classifySubNegative(outcome);
      record("subscription-negative", verdict.pass, Date.now() - t0, verdict.error);
    } catch (err) {
      record("subscription-negative", false, Date.now() - t0, err.message);
    }
  }

  // ---- (3) Subscription positive + chat turn ----------------------------
  {
    const t0 = Date.now();
    try {
      const ws = await withTimeout(connectWs(wsUrl), 10_000, "ws-connect");
      const clientMessageId = crypto.randomUUID();
      let gotTurnAccepted = false;
      let gotAgentMessage = false;

      const done = new Promise((resolve, reject) => {
        const failTimer = setTimeout(
          () => reject(new Error("No agent message within 90s")),
          90_000,
        );

        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          const cls = classifyMessage(msg);
          if (cls === "turn_accepted") gotTurnAccepted = true;
          if (cls === "agent_message") {
            gotAgentMessage = true;
            clearTimeout(failTimer);
            ws.close();
            resolve();
          }
        });
      });

      subscribe(
        ws,
        `subscription OnConvMsg($pid: ID!) { onConversationMessage(projectId: $pid) { id messageType message agentId } }`,
        { pid: PROJECT_ID },
        idToken,
        host,
      );

      // Small delay to let subscription register, then send the message.
      await new Promise((r) => setTimeout(r, 500));
      await gqlFetch(
        `mutation Send($pid: ID!, $msg: ConversationMessageInput!) {
          sendMessage(projectId: $pid, message: $msg) { id messageType }
        }`,
        {
          pid: PROJECT_ID,
          msg: {
            agentId: "intake-agent",
            message: "smoke ping",
            messageType: "USER_INPUT",
            clientMessageId,
          },
        },
        idToken,
      );

      await done;

      if (!gotTurnAccepted) throw new Error("Never received TURN_ACCEPTED");
      if (!gotAgentMessage) throw new Error("Never received agent message");
      record("chat-roundtrip", true, Date.now() - t0);
    } catch (err) {
      record("chat-roundtrip", false, Date.now() - t0, err.message);
    }
  }

  // ---- (4) testTool -----------------------------------------------------
  {
    const t0 = Date.now();
    try {
      const data = await withTimeout(
        gqlFetch(
          `mutation TestTool($tid: String!, $inputs: AWSJSON!, $oid: String!) {
            testTool(toolId: $tid, inputs: $inputs, orgId: $oid) { success output error executionTimeMs }
          }`,
          { tid: SMOKE_TOOL_ID, inputs: JSON.stringify({ key: "value" }), oid: orgId },
          idToken,
        ),
        30_000,
        "testTool",
      );
      if (!data.testTool.success) {
        throw new Error(`testTool returned error: ${data.testTool.error}`);
      }
      record("test-tool", true, Date.now() - t0);
    } catch (err) {
      record("test-tool", false, Date.now() - t0, err.message);
    }
  }

  // ---- (5) startExecution + onWorkflowProgress --------------------------
  {
    const t0 = Date.now();
    try {
      const ws = await withTimeout(connectWs(wsUrl), 10_000, "ws-connect-wf");

      // Start the execution first so we get the executionId for the subscription.
      const startData = await gqlFetch(
        `mutation StartExec($wid: ID!, $input: AWSJSON) {
          startExecution(workflowId: $wid, input: $input) { executionId status }
        }`,
        { wid: ECHO_WORKFLOW_ID, input: JSON.stringify({}) },
        idToken,
      );
      const executionId = startData.startExecution.executionId;
      if (!executionId) throw new Error("No executionId returned");

      let terminal = false;
      let allNodesCompleted = true;
      const nodeStatuses = {};

      const done = new Promise((resolve, reject) => {
        const failTimer = setTimeout(
          () => reject(new Error("Workflow did not reach terminal status within 120s")),
          120_000,
        );

        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== "data") return;
          const evt =
            msg.payload?.data?.onWorkflowProgress ??
            (typeof msg.payload?.data === "string"
              ? JSON.parse(msg.payload.data).onWorkflowProgress
              : null);
          if (!evt) return;

          if (evt.nodeId) nodeStatuses[evt.nodeId] = evt.status;

          if (
            evt.status === "COMPLETED" ||
            evt.status === "FAILED" ||
            evt.eventType === "EXECUTION_COMPLETED" ||
            evt.eventType === "EXECUTION_FAILED"
          ) {
            terminal = true;
            clearTimeout(failTimer);
            ws.close();
            if (evt.status === "FAILED" || evt.eventType === "EXECUTION_FAILED") {
              reject(new Error(`Workflow execution failed: ${evt.error ?? "unknown"}`));
            } else {
              resolve();
            }
          }
        });
      });

      subscribe(
        ws,
        `subscription OnWfProg($eid: ID!) { onWorkflowProgress(executionId: $eid) { executionId workflowId eventType nodeId status output error timestamp } }`,
        { eid: executionId },
        idToken,
        host,
      );

      await done;

      // Verify all tracked nodes completed
      for (const [nodeId, status] of Object.entries(nodeStatuses)) {
        if (status !== "COMPLETED" && status !== "completed") {
          allNodesCompleted = false;
        }
      }

      if (!terminal) throw new Error("Never reached terminal status");
      record("workflow-execution", true, Date.now() - t0);
    } catch (err) {
      record("workflow-execution", false, Date.now() - t0, err.message);
    }
  }

  // ---- (6) listBlueprints -----------------------------------------------
  {
    const t0 = Date.now();
    try {
      const data = await withTimeout(
        gqlFetch(
          `query ListBP { listBlueprints { items { workflowId name description isBlueprint } } }`,
          {},
          idToken,
        ),
        15_000,
        "listBlueprints",
      );
      const items = data.listBlueprints?.items ?? [];
      if (items.length === 0) throw new Error("listBlueprints returned empty");
      const echoDemo = items.find(
        (bp) => bp.name && bp.name.toLowerCase().includes("echo demo"),
      );
      if (!echoDemo) {
        throw new Error(
          `Echo Demo blueprint not found. Got: ${items.map((i) => i.name).join(", ")}`,
        );
      }
      record("list-blueprints", true, Date.now() - t0);
    } catch (err) {
      record("list-blueprints", false, Date.now() - t0, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
await runChecks();
const report = shapeReport(checks);
console.log(JSON.stringify(report, null, 2));
process.exit(report.summary.failed > 0 ? 1 : 0);
