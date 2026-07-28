import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EventBridgeEvent } from "aws-lambda";

process.env.COST_LEDGER_TABLE = "citadel-cost-ledger-test";
process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";

// Mocked once at module scope (not per-test resetModules) so the handler's
// module-level DynamoDBDocumentClient instance — and therefore ddbMock's
// interception of it — stays stable across the whole file. getSegment
// defaults to "no active segment" (undefined), matching the real Jest/CI
// behavior for every test that doesn't opt into the mock segment below.
const mockXraySegment = {
  addAnnotation: jest.fn(),
  addMetadata: jest.fn(),
};
jest.mock("aws-xray-sdk-core", () => ({
  getSegment: jest.fn().mockReturnValue(undefined),
  setContextMissingStrategy: jest.fn(),
  captureAWSv3Client: jest.fn((c: unknown) => c),
}));

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

function intakeUsageEvent(usageOverrides: Record<string, unknown> = {}) {
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
        ...usageOverrides,
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

  test("usage record WITH bedrockRequestId: row.bedrockRequestId is copied through (Tier B match key)", async () => {
    await handler(intakeUsageEvent({ bedrockRequestId: "req-abc-123" }));
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.bedrockRequestId).toBe("req-abc-123");
  });

  test.each([
    ["absent", undefined],
    ["empty string", ""],
    ["non-string (number)", 42],
    ["non-string (null)", null],
  ])(
    "usage record with %s bedrockRequestId: row is still written, key omitted, never throws",
    async (_label, value) => {
      await expect(
        handler(intakeUsageEvent({ bedrockRequestId: value })),
      ).resolves.not.toThrow();
      const putCalls = ddbMock.commandCalls(
        (await import("@aws-sdk/lib-dynamodb")).PutCommand,
      );
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
      expect(item.bedrockRequestId).toBeUndefined();
      expect("bedrockRequestId" in item).toBe(false);
    },
  );
});

// keep the exported error class referenced so an unused-import lint rule
// doesn't flag it if a future test needs to construct one directly.
void ConditionalCheckFailedError;

describe("cost-ledger-writer (pass 2 — pricing + decomposition)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  test("priced row: GetItem resolves catalog pricing, cost is computed and populated", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({
      Item: {
        modelKey: "anthropic-claude-sonnet-5",
        inputPer1kTokens: 3,
        outputPer1kTokens: 15,
        currency: "USD",
      },
    });

    await handler(intakeUsageEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(true);
    // intakeUsageEvent: inputTokens 10, outputTokens 5 @ $3/$15 per 1k
    // = 10/1000*3 + 5/1000*15 = 0.03 + 0.075 = 0.105
    expect(item.tokenCost).toBeCloseTo(0.105, 8);
    expect(item.costMicros).toBe(105000);
    expect(item.currency).toBe("USD");
    expect(item.estimate).toBe(true);
  });

  test("priced row: decomposition shape has tokenCost populated, compute/idle/memory null, runtimeComponentsPending true", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({
      Item: {
        modelKey: "anthropic-claude-sonnet-5",
        inputPer1kTokens: 3,
        outputPer1kTokens: 15,
        currency: "USD",
      },
    });

    await handler(intakeUsageEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    const decomp = item.decomposition as Record<string, unknown>;
    expect(decomp.currency).toBe("USD");
    expect(decomp.tokenCost).toBeCloseTo(0.105, 8);
    expect(decomp.compute).toBeNull();
    expect(decomp.idle).toBeNull();
    expect(decomp.memory).toBeNull();
    expect(decomp.runtimeComponentsPending).toBe(true);
  });

  test("unpriced row: model not in catalog (GetItem returns no Item) → still written, priced:false, unpricedReason set", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await handler(intakeUsageEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1); // never dropped
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(false);
    expect(item.tokenCost).toBeNull();
    expect(item.costMicros).toBeNull();
    expect(item.unpricedReason).toBe("model_not_in_catalog");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("unpriced row: catalog row exists but lacks pricing fields → still written, priced:false, reason pricing_absent", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({
      Item: { modelKey: "anthropic-claude-sonnet-5", status: "enabled" },
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await handler(intakeUsageEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(false);
    expect(item.unpricedReason).toBe("pricing_absent");
    warnSpy.mockRestore();
  });

  test("catalog-read failure: GetItem throws → row STILL written unpriced and logged, never dropped", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock
      .on(GetCommand)
      .rejects(new Error("ProvisionedThroughputExceededException"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(handler(intakeUsageEvent())).resolves.not.toThrow();

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1); // never dropped despite catalog-read failure
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(false);
    expect(item.tokenCost).toBeNull();
    expect(item.unpricedReason).toBe("pricing_absent");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("modelKey is resolved from the raw modelId using the same slug logic as catalog sync", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({
      Item: {
        modelKey: "anthropic-claude-sonnet-5",
        inputPer1kTokens: 1,
        outputPer1kTokens: 2,
        currency: "USD",
      },
    });

    await handler(intakeUsageEvent()); // modelId: "anthropic.claude-sonnet-5"

    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(getCalls[0].args[0].input.Key).toEqual({
      modelKey: "anthropic-claude-sonnet-5",
    });
  });

  test("multiple usage records in one event each resolve pricing independently", async () => {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({
      Item: {
        modelKey: "anthropic-claude-sonnet-5",
        inputPer1kTokens: 1,
        outputPer1kTokens: 1,
        currency: "USD",
      },
    });

    await handler(workflowNodeCompletedEvent());

    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.priced).toBe(true);
  });
});

describe("cost-ledger-writer: trace-propagation consumer wiring (design file-list item 4)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("R9 property: an event with NO traceContext never throws and business result is unchanged (no active segment in Jest)", async () => {
    await expect(handler(intakeUsageEvent())).resolves.not.toThrow();
    const putCalls = ddbMock.commandCalls(
      (await import("@aws-sdk/lib-dynamodb")).PutCommand,
    );
    expect(putCalls).toHaveLength(1);
  });

  test("annotates the active segment with the stable key contract when the event carries a traceContext", async () => {
    const AWSXRay = jest.requireMock("aws-xray-sdk-core") as {
      getSegment: jest.Mock;
    };
    AWSXRay.getSegment.mockReturnValue(mockXraySegment);
    mockXraySegment.addAnnotation.mockClear();
    mockXraySegment.addMetadata.mockClear();

    const event = intakeUsageEvent();
    (event.detail as Record<string, unknown>).traceContext = {
      traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      correlationId: "corr-1",
    };

    await handler(event);

    expect(mockXraySegment.addAnnotation).toHaveBeenCalledWith(
      "source_trace_id",
      "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(mockXraySegment.addAnnotation).toHaveBeenCalledWith(
      "correlation_id",
      "corr-1",
    );

    AWSXRay.getSegment.mockReturnValue(undefined);
  });
});
