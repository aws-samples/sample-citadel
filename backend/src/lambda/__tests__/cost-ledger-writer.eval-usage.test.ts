/**
 * cost-ledger-writer.eval-usage.test.ts (Phase 2 §2.6) — the judge's
 * `eval.usage.captured` (source citadel.eval.usage) event: a 4th
 * consumed shape, distinct from evalContext (Phase 1, excludes eval-RUN
 * spend from customer rollups) — this is `costContext:"eval"`, a
 * separate attribute tagging judge-invocation spend specifically, plus a
 * sparse GSI6 EvalContextIndex key so it can be queried/audited
 * independently of the base org rollup.
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

function evalUsageCapturedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-eval-1",
    source: "citadel.eval.usage",
    "detail-type": "eval.usage.captured",
    detail: {
      orgId: "org-1",
      agentId: "agent-1",
      modelId: "anthropic.claude-sonnet-5",
      inputTokens: 500,
      outputTokens: 200,
      capturedAt: "2026-08-01T00:00:00.000Z",
      correlationId: "run-abc123",
      ...overrides,
    },
  } as unknown as IncomingEvent;
}

describe("cost-ledger-writer — eval.usage.captured (Phase 2 §2.6)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  test("writes a row with costContext:'eval' and GSI6 EvalContextIndex keys", async () => {
    await handler(evalUsageCapturedEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.costContext).toBe("eval");
    expect(item.GSI6PK).toBe("EVALCTX#org-1");
    expect(item.orgId).toBe("org-1");
    expect(item.agentId).toBe("agent-1");
  });

  test("resolves pricing the same way as other usage sources", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({
      Item: {
        modelKey: "anthropic.claude-sonnet-5",
        inputPer1kTokens: 0.003,
        outputPer1kTokens: 0.015,
        currency: "USD",
      },
    });

    await handler(evalUsageCapturedEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(true);
    expect(item.costMicros).toBeGreaterThan(0);
  });

  test("never writes a plain evalContext:true flag for this source (distinct from Phase 1 evalRunId/evalContext dispatch tagging)", async () => {
    await handler(evalUsageCapturedEvent());
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.evalContext).toBeUndefined();
  });
});
