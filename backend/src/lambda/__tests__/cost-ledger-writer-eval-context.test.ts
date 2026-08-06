/**
 * Tests for evalRunId/evalContext threading through cost-ledger-writer.ts
 * (CIT-102 §5) — additive fields on LedgerRow, following the `runId`
 * precedent (cost-ledger-writer-run-id.test.ts) verbatim: `detail.evalRunId`
 * / `detail.evalContext` are copied to `row.evalRunId` / `row.evalContext`
 * when present, and BOTH keys must be entirely absent when the event
 * carries neither — byte-identical to the pre-eval row shape. No new GSI
 * this pass (per design §5); cost-aggregate.ts/cost-budget-evaluator.ts
 * consume `row.evalContext` to exclude these rows from org rollups/budget
 * sums (see cost-aggregate.test.ts / cost-budget-evaluator.test.ts PINNED
 * exclusion tests).
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
    id: "evt-evalctx-1",
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

function workflowNodeCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-evalctx-2",
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

describe("cost-ledger-writer: evalRunId/evalContext threading (CIT-102 §5)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  test("task.completion: detail.evalRunId + detail.evalContext copied to row when present", async () => {
    await handler(
      taskCompletionEvent({ evalRunId: "evalrun-abc123", evalContext: true }),
    );
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.evalRunId).toBe("evalrun-abc123");
    expect(item.evalContext).toBe(true);
  });

  test("task.completion: both keys absent when detail carries neither (byte-identical to pre-eval row)", async () => {
    await handler(taskCompletionEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect("evalRunId" in item).toBe(false);
    expect("evalContext" in item).toBe(false);
  });

  test("workflow.node.completed: detail.evalRunId + detail.evalContext copied to row when present", async () => {
    await handler(
      workflowNodeCompletedEvent({
        evalRunId: "evalrun-ghi789",
        evalContext: true,
      }),
    );
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.evalRunId).toBe("evalrun-ghi789");
    expect(item.evalContext).toBe(true);
  });

  test("workflow.node.completed: both keys absent when detail carries neither", async () => {
    await handler(workflowNodeCompletedEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect("evalRunId" in item).toBe(false);
    expect("evalContext" in item).toBe(false);
  });

  test("no new GSI: evalRunId/evalContext do not add or alter any GSI keys", async () => {
    await handler(
      workflowNodeCompletedEvent({
        evalRunId: "evalrun-nogsi",
        evalContext: true,
      }),
    );
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
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

  test("evalContext:false is threaded through as an explicit false (not coerced to absent)", async () => {
    await handler(
      taskCompletionEvent({
        evalRunId: "evalrun-false-case",
        evalContext: false,
      }),
    );
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.evalRunId).toBe("evalrun-false-case");
    expect(item.evalContext).toBe(false);
  });
});
