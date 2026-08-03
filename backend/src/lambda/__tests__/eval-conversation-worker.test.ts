/**
 * CIT-102 Pass A — eval-conversation-worker tests.
 *
 * Adapter B (design §3): CONVERSATION-kind case dispatch. Constructs the
 * InvokeAgentRuntimeCommand payload {prompt, session_id, sessionAttributes?}
 * mirroring agent-message-handler.ts's sendMessageToAgentCore payload
 * shape, awaits inline (Lambda timeout ≤15min bounds this), writes a
 * CONVERSATIONS_TABLE transcript row + updates the case-result row to a
 * terminal state, then records completion (decrements pendingCases on the
 * parent run via the shared completion-recording helper).
 *
 * Forbidden-tool contract (mock seam — Python enforcement is Pass B): the
 * worker input's `forbiddenTools` is threaded VERBATIM into the dispatch
 * payload sent to InvokeAgentRuntimeCommand as `sessionAttributes.
 * forbiddenTools`, so a future arbiter-side change can read it without any
 * further TS change. This test pins that pass-through.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { sdkStreamMixin } from "@smithy/util-stream";
import { Readable } from "stream";

process.env.CONVERSATIONS_TABLE = "citadel-conversations-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockAgentCoreClient);
const ssmMock = mockClient(SSMClient);

import { dispatchConversationCase } from "../eval-conversation-worker";

function streamOf(text: string) {
  const encoder = new TextEncoder();
  const readable = Readable.from([encoder.encode(text)]);
  return sdkStreamMixin(readable);
}

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  ssmMock.reset();
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: {
      Value: JSON.stringify({
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:123:runtime/agent-1",
      }),
    },
  });
});

describe("dispatchConversationCase", () => {
  test("invokes AgentCoreRuntime with prompt + session_id, threads forbiddenTools into sessionAttributes", async () => {
    bedrockMock.on(InvokeAgentRuntimeCommand).resolves({
      response: streamOf("hello from agent"),
      contentType: "text/plain",
      $metadata: { httpStatusCode: 200 },
    } as never);
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { evalRunId: "run-1", pendingCases: 1 },
    });

    await dispatchConversationCase({
      evalRunId: "run-1",
      caseId: "case-1",
      orgId: "org-1",
      agentTargetId: "agent-1",
      prompt: "say hi",
      forbiddenTools: ["dangerous_tool"],
      evalContext: true,
      maxLatencyMs: 5000,
    });

    const invokeCalls = bedrockMock.commandCalls(InvokeAgentRuntimeCommand);
    expect(invokeCalls).toHaveLength(1);
    const payload = JSON.parse(invokeCalls[0].args[0].input.payload as string);
    expect(payload.prompt).toBe("say hi");
    expect(payload.session_id).toBeDefined();
    expect(payload.sessionAttributes.forbiddenTools).toEqual([
      "dangerous_tool",
    ]);
    expect(payload.sessionAttributes.evalRunId).toBe("run-1");
    expect(payload.sessionAttributes.evalContext).toBe(true);
  });

  test("writes a conversation transcript row and marks the case COMPLETED", async () => {
    bedrockMock.on(InvokeAgentRuntimeCommand).resolves({
      response: streamOf("ack"),
      contentType: "text/plain",
      $metadata: { httpStatusCode: 200 },
    } as never);
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { evalRunId: "run-1", pendingCases: 1 },
    });

    await dispatchConversationCase({
      evalRunId: "run-1",
      caseId: "case-1",
      orgId: "org-1",
      agentTargetId: "agent-1",
      prompt: "say hi",
      forbiddenTools: [],
      evalContext: true,
      maxLatencyMs: 5000,
    });

    const putCalls = ddbMock.commandCalls(PutCommand);
    const conversationPut = putCalls.find(
      (c) => c.args[0].input.TableName === "citadel-conversations-test",
    );
    expect(conversationPut).toBeDefined();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const caseUpdate = updateCalls.find(
      (c) => c.args[0].input.TableName === "citadel-eval-run-case-results-test",
    );
    expect(caseUpdate).toBeDefined();
    expect(
      caseUpdate?.args[0].input.ExpressionAttributeValues?.[":status"],
    ).toBe("COMPLETED");
    // F4: conversationId is stamped == caseId, the same convention
    // writeConversationTranscript uses for the transcript row's projectId
    // key, so assembleReplayPackage's conversation branch (keyed by
    // conversationId) resolves the correct transcript.
    expect(
      caseUpdate?.args[0].input.ExpressionAttributeValues?.[":conversationId"],
    ).toBe("case-1");
  });

  test("marks the case FAILED (not thrown) when InvokeAgentRuntimeCommand rejects", async () => {
    bedrockMock.on(InvokeAgentRuntimeCommand).rejects(new Error("boom"));
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { evalRunId: "run-1", pendingCases: 1 },
    });

    await expect(
      dispatchConversationCase({
        evalRunId: "run-1",
        caseId: "case-1",
        orgId: "org-1",
        agentTargetId: "agent-1",
        prompt: "say hi",
        forbiddenTools: [],
        evalContext: true,
        maxLatencyMs: 5000,
      }),
    ).resolves.not.toThrow();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const caseUpdate = updateCalls.find(
      (c) => c.args[0].input.TableName === "citadel-eval-run-case-results-test",
    );
    expect(
      caseUpdate?.args[0].input.ExpressionAttributeValues?.[":status"],
    ).toBe("FAILED");
  });
});
