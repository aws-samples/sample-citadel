/**
 * Tests for canary attribution (releaseId/releaseArm) threading through
 * cost-ledger-writer.ts (decision D2/D3). The usage record's releaseId +
 * releaseArm (written by arbiter/common/usage.py) must be copied onto the
 * ledger row so the auto-rollback evaluator can compute per-arm cost +
 * latency. Omit-when-absent (byte-identical pre-canary row); a malformed
 * arm is dropped, never persisted.
 */
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
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

function taskCompletionEvent(usageOverrides: Record<string, unknown> = {}) {
  return {
    id: "evt-arm-1",
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
          capturedAt: "2026-08-18T00:00:00.000Z",
          source: "worker",
          ...usageOverrides,
        },
      ],
    },
  } as unknown as IncomingEvent;
}

async function firstItem(): Promise<Record<string, unknown>> {
  const calls = ddbMock.commandCalls(PutCommand);
  return calls[0].args[0].input.Item as Record<string, unknown>;
}

describe("cost-ledger-writer: canary attribution (D2/D3)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  it("copies releaseId + a valid candidate releaseArm onto the ledger row", async () => {
    await handler(
      taskCompletionEvent({
        releaseId: "rel-candidate",
        releaseArm: "candidate",
      }),
    );
    const item = await firstItem();
    expect(item.releaseId).toBe("rel-candidate");
    expect(item.releaseArm).toBe("candidate");
  });

  it("copies a valid stable releaseArm", async () => {
    await handler(
      taskCompletionEvent({ releaseId: "rel-stable", releaseArm: "stable" }),
    );
    const item = await firstItem();
    expect(item.releaseArm).toBe("stable");
  });

  it("omits both keys when the usage record carries no attribution (byte-identical pre-canary row)", async () => {
    await handler(taskCompletionEvent());
    const item = await firstItem();
    expect("releaseId" in item).toBe(false);
    expect("releaseArm" in item).toBe(false);
  });

  it("drops a malformed/unknown releaseArm (never persisted)", async () => {
    await handler(
      taskCompletionEvent({ releaseId: "rel-x", releaseArm: "bogus-arm" }),
    );
    const item = await firstItem();
    expect("releaseArm" in item).toBe(false);
    // releaseId still copied — a valid id with an invalid arm keeps the id.
    expect(item.releaseId).toBe("rel-x");
  });
});
