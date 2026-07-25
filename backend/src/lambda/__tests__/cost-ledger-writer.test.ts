import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EventBridgeEvent } from "aws-lambda";

process.env.COST_LEDGER_TABLE = "citadel-cost-ledger-test";
process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";

import {
  handler,
  ConditionalCheckFailedError,
  IncomingDetail,
} from "../cost-ledger-writer";

type IncomingEvent = EventBridgeEvent<string, IncomingDetail>;

const ddbMock = mockClient(DynamoDBDocumentClient);

function taskCompletionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    source: "task.completion",
    "detail-type": "task.completion",
    detail: {
      taskId: "task-1",
      orgId: "org-1",
      projectId: "proj-1",
      usage: [
        {
          modelId: "anthropic.claude-sonnet-5",
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 250,
          callIndex: 0,
          capturedAt: "2026-07-25T00:00:00.000Z",
          source: "worker",
        },
      ],
      ...overrides,
    },
  } as unknown as IncomingEvent;
}

function intakeUsageEvent() {
  return {
    id: "evt-2",
    source: "agent_intake.usage",
    "detail-type": "intake.usage.captured",
    detail: {
      orgId: "org-2",
      appId: "app-2",
      usage: {
        modelId: "anthropic.claude-sonnet-5",
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
        callIndex: 0,
        capturedAt: "2026-07-25T00:00:01.000Z",
        source: "worker",
      },
    },
  } as unknown as IncomingEvent;
}

function workflowNodeCompletedEvent() {
  return {
    id: "evt-3",
    source: "citadel.workflows",
    "detail-type": "workflow.node.completed",
    detail: {
      orgId: "org-3",
      projectId: "proj-3",
      appId: "app-3",
      workflowExecutionId: "exec-3",
      nodeId: "node-3",
      agentId: "agent-3",
      usage: [
        {
          modelId: "anthropic.claude-sonnet-5",
          inputTokens: 20,
          outputTokens: 8,
          latencyMs: 80,
          callIndex: 0,
          capturedAt: "2026-07-25T00:00:02.000Z",
          source: "worker",
        },
      ],
    },
  } as unknown as IncomingEvent;
}

describe("cost-ledger-writer (pass 1 — usage-only rows)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  test("task.completion WITHOUT workflow correlation writes N usage rows", async () => {
    await handler(taskCompletionEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe("ORG#org-1");
    expect(item.orgId).toBe("org-1");
  });

  test("intake.usage.captured writes exactly 1 row", async () => {
    await handler(intakeUsageEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe("ORG#org-2");
    expect(item.GSI2PK).toBe("APP#app-2");
  });

  test("workflow.node.completed writes per-node usage rows with WorkflowIndex GSI keys", async () => {
    await handler(workflowNodeCompletedEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.GSI4PK).toBe("WORKFLOW#exec-3");
    expect(String(item.GSI4SK)).toContain("#node-3#");
    expect(item.GSI3PK).toBe("AGENT#agent-3");
  });

  test("DEDUPE: task.completion WITH workflowExecutionId/nodeId is dropped (0 rows)", async () => {
    await handler(
      taskCompletionEvent({ workflowExecutionId: "exec-9", nodeId: "node-9" }),
    );
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(0);
  });

  test("DEDUPE: task.completion WITHOUT workflow correlation is written", async () => {
    await handler(taskCompletionEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
  });

  test("IDEMPOTENCY: redelivery of same event is swallowed via attribute_not_exists(PK) conditional check", async () => {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(PutCommand).rejects(
      Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    await expect(handler(intakeUsageEvent())).resolves.not.toThrow();
  });

  test("non-conditional-check errors are logged and rethrown for retry/DLQ semantics", async () => {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock
      .on(PutCommand)
      .rejects(new Error("ProvisionedThroughputExceededException"));

    await expect(handler(intakeUsageEvent())).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });

  test("sparse GSI attrs: missing appId/workflow correlation omits AppIndex/WorkflowIndex keys", async () => {
    await handler(taskCompletionEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.GSI2PK).toBeUndefined();
    expect(item.GSI4PK).toBeUndefined();
    // Project dimension IS present on this event -> ProjectIndex keys written
    expect(item.GSI1PK).toBe("PROJECT#proj-1");
  });

  test("missing org resolves to ORG#UNKNOWN fallback", async () => {
    await handler(taskCompletionEvent({ orgId: undefined }));
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe("ORG#UNKNOWN");
  });

  test("usage-only rows carry no pricing fields (priced:false, tokenCost:null)", async () => {
    await handler(intakeUsageEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(false);
    expect(item.tokenCost).toBeNull();
    expect(item.estimate).toBe(true);
  });
});

// keep the exported error class referenced so an unused-import lint rule
// doesn't flag it if a future test needs to construct one directly.
void ConditionalCheckFailedError;
