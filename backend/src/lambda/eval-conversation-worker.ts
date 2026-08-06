/**
 * eval-conversation-worker (CIT-102 Pass A) — Adapter B: CONVERSATION-kind
 * eval case dispatch.
 *
 * Per-case worker invoked (async/SQS, per eval-runner.ts) for every
 * CONVERSATION-kind case. Constructs the same payload shape as
 * agent-message-handler.ts's sendMessageToAgentCore
 * ({prompt, session_id, sessionAttributes?}) and calls
 * InvokeAgentRuntimeCommand synchronously, awaiting the response inline —
 * bounded by this Lambda's own timeout (<=15min), configured in
 * governance-stack.ts.
 *
 * FROZEN CONTRACT pass-through (mock seam — Python/arbiter enforcement is
 * Pass B): `forbiddenTools` + `evalRunId` + `evalContext` are threaded
 * VERBATIM into `sessionAttributes` on the dispatch payload, so a future
 * arbiter-side change can read them without any further TS change.
 *
 * On completion (success OR failure), writes a CONVERSATIONS_TABLE
 * transcript row, marks the case-result row terminal (COMPLETED|FAILED),
 * and records completion against the parent run's `pendingCases` counter
 * (atomic decrement, guarded by `completionRecorded` so duplicate
 * redelivery cannot double-decrement — design §2).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { v4 as uuidv4 } from "uuid";
import { mintRunId } from "../utils/run-id";
import { getAgentConfig } from "./agent-message-handler";
import { recordCaseCompletion } from "./eval-run-completion";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE!;
const EVAL_RUN_CASE_RESULTS_TABLE = process.env.EVAL_RUN_CASE_RESULTS_TABLE!;

export interface ConversationCaseDispatchInput {
  evalRunId: string;
  caseId: string;
  orgId: string;
  agentTargetId: string;
  prompt: string;
  forbiddenTools: string[];
  evalContext: true;
  maxLatencyMs: number;
}

async function invokeAgentCore(
  agentRuntimeArn: string,
  sessionId: string,
  input: ConversationCaseDispatchInput,
): Promise<string> {
  const client = new BedrockAgentCoreClient({
    region: process.env.AWS_REGION || "ap-southeast-2",
  });
  const payload = JSON.stringify({
    prompt: input.prompt,
    session_id: sessionId,
    sessionAttributes: {
      evalRunId: input.evalRunId,
      evalContext: input.evalContext,
      forbiddenTools: input.forbiddenTools,
    },
  });

  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn,
      runtimeSessionId: sessionId,
      payload,
      qualifier: "DEFAULT",
    }),
  );

  let responseText = "";
  if (response.response) {
    const stream = response.response as unknown as AsyncIterable<Uint8Array>;
    const chunks: string[] = [];
    for await (const chunk of stream) {
      if (chunk) chunks.push(Buffer.from(chunk).toString("utf-8"));
    }
    responseText = chunks.join("");
  }
  return responseText;
}

async function writeConversationTranscript(
  input: ConversationCaseDispatchInput,
  responseText: string,
): Promise<void> {
  const now = new Date().toISOString();
  const runId = mintRunId();
  await docClient.send(
    new PutCommand({
      TableName: CONVERSATIONS_TABLE,
      Item: {
        projectId: input.caseId,
        timestamp: now,
        id: uuidv4(),
        agentId: input.agentTargetId,
        message: responseText,
        messageType: "AGENT_RESPONSE",
        userId: "eval-runner",
        runId,
        evalRunId: input.evalRunId,
        evalContext: true,
      },
    }),
  );
}

async function markCaseTerminal(
  evalRunId: string,
  caseId: string,
  status: "COMPLETED" | "FAILED" | "TIMEOUT",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const setParts = ["#status = :status", "#completedAt = :completedAt"];
  const names: Record<string, string> = {
    "#status": "status",
    "#completedAt": "completedAt",
  };
  const values: Record<string, unknown> = {
    ":status": status,
    ":completedAt": now,
  };
  for (const [k, v] of Object.entries(extra)) {
    setParts.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  await docClient.send(
    new UpdateCommand({
      TableName: EVAL_RUN_CASE_RESULTS_TABLE,
      Key: { evalRunId, caseId },
      UpdateExpression: "SET " + setParts.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Dispatch a single CONVERSATION-kind eval case. Never throws — a target
 * invocation failure marks the case FAILED (recorded as a terminal case
 * outcome + pendingCases decrement) rather than propagating, so a single
 * bad case cannot crash the fan-out or hang the run.
 */
export async function dispatchConversationCase(
  input: ConversationCaseDispatchInput,
): Promise<void> {
  const sessionId = mintRunId();
  const startedAt = new Date().toISOString();

  try {
    const config = await getAgentConfig(input.agentTargetId);
    const t0 = Date.now();
    const responseText = await invokeAgentCore(
      config.agentRuntimeArn,
      sessionId,
      input,
    );
    const latencyMs = Date.now() - t0;

    await writeConversationTranscript(input, responseText);
    await markCaseTerminal(input.evalRunId, input.caseId, "COMPLETED", {
      latencyMs,
      startedAt,
      // conversationId == the case's own caseId — writeConversationTranscript
      // stores the transcript row keyed by `projectId: input.caseId` (this
      // file's PutCommand above), and assembleReplayPackage's conversation
      // branch (replay-package-builder.ts readConversationMessages) queries
      // CONVERSATIONS_TABLE by that same `projectId`. Stamped here so
      // eval-run-completion.ts's F4 artifact materialization can resolve the
      // correct source id without re-deriving the convention.
      conversationId: input.caseId,
    });
  } catch (err: unknown) {
    console.error("eval-conversation-worker: case dispatch failed", {
      evalRunId: input.evalRunId,
      caseId: input.caseId,
      message: err instanceof Error ? err.message : undefined,
    });
    await markCaseTerminal(input.evalRunId, input.caseId, "FAILED", {
      error: err instanceof Error ? err.message : String(err),
      startedAt,
    });
  }

  await recordCaseCompletion(input.evalRunId, input.caseId);
}

export const handler = async (event: {
  Records?: Array<{ body: string }>;
}): Promise<void> => {
  for (const record of event.Records ?? []) {
    const input = JSON.parse(record.body) as ConversationCaseDispatchInput;
    await dispatchConversationCase(input);
  }
};
