/**
 * Tests for runId threading through cost-ledger-writer.ts (Pass 1, decision
 * f1cbd5ef) — `detail.runId` (server-minted upstream) must be copied to
 * `row.runId` when present, and the key must be entirely absent when the
 * event carries no runId (byte-identical to the pre-runId row shape). No
 * new GSI in this pass (deferred per design).
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EventBridgeEvent } from "aws-lambda";

process.env.COST_LEDGER_TABLE = "citadel-cost-ledger-test";
process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";

jest.mock("aws-xray-sdk-core", () => ({
  getSegment: jest.fn().mockReturnValue(undefined),
  setContextMissingStrategy: jest.fn(),
  captureAWSv3Client: jest.fn((c: unknown) => c),
}));

import { handler, IncomingDetail } from "../cost-ledger-writer";

type IncomingEvent = EventBridgeEvent<string, IncomingDetail>;

const ddbMock = mockClient(DynamoDBDocumentClient);

function taskCompletionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-runid-1",
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

function intakeUsageEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-runid-2",
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
      ...overrides,
    },
  } as unknown as IncomingEvent;
}

function workflowNodeCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-runid-3",
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
      ...overrides,
    },
  } as unknown as IncomingEvent;
}

describe("cost-ledger-writer: runId threading (Pass 1, decision f1cbd5ef)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  test("task.completion: detail.runId is copied to row.runId when present", async () => {
    await handler(taskCompletionEvent({ runId: "run-abc123" }));
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.runId).toBe("run-abc123");
  });

  test("task.completion: row.runId key absent when detail carries no runId", async () => {
    await handler(taskCompletionEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect("runId" in item).toBe(false);
  });

  test("intake.usage.captured: detail.runId is copied to row.runId when present", async () => {
    await handler(intakeUsageEvent({ runId: "run-def456" }));
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.runId).toBe("run-def456");
  });

  test("workflow.node.completed: detail.runId is copied to row.runId when present", async () => {
    await handler(workflowNodeCompletedEvent({ runId: "run-ghi789" }));
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.runId).toBe("run-ghi789");
  });

  test("workflow.node.completed: row.runId key absent when detail carries no runId", async () => {
    await handler(workflowNodeCompletedEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect("runId" in item).toBe(false);
  });

  test("no new GSI: runId does not add or alter any GSI keys", async () => {
    await handler(workflowNodeCompletedEvent({ runId: "run-nogssi" }));
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    // Existing GSI4 (workflow) key shape is unaffected by runId's presence.
    expect(item.GSI4PK).toBe("WORKFLOW#exec-3");
    expect(Object.keys(item).filter((k) => k.startsWith("GSI"))).toEqual([
      "GSI1PK",
      "GSI1SK",
      "GSI2PK",
      "GSI2SK",
      "GSI3PK",
      "GSI3SK",
      "GSI4PK",
      "GSI4SK",
    ]);
  });
});
