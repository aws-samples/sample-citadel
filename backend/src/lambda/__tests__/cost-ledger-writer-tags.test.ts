/**
 * Tests for CIT-042 agent-tag propagation on cost-ledger rows.
 * Policy (decision ad393b11): lookup failure or missing env → WARN once,
 * write row WITHOUT tags. NEVER drop or delay a row.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { EventBridgeEvent } from "aws-lambda";

process.env.COST_LEDGER_TABLE = "citadel-cost-ledger-test";
process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agent-config-test";

jest.mock("aws-xray-sdk-core", () => ({
  getSegment: jest.fn().mockReturnValue(undefined),
  setContextMissingStrategy: jest.fn(),
  captureAWSv3Client: jest.fn((c: unknown) => c),
}));

import { handler, IncomingDetail, _testInternals } from "../cost-ledger-writer";

type IncomingEvent = EventBridgeEvent<string, IncomingDetail>;

const ddbMock = mockClient(DynamoDBDocumentClient);

function taskEvent(
  overrides: Partial<{
    agentId: string;
    orgId: string;
    usage: Record<string, unknown>[];
  }> = {},
): IncomingEvent {
  return {
    id: "evt-tags-1",
    source: "task.completion",
    "detail-type": "task.completion",
    detail: {
      taskId: "task-1",
      orgId: overrides.orgId ?? "org-1",
      projectId: "proj-1",
      agentId: overrides.agentId ?? "agent-1",
      usage: overrides.usage ?? [
        {
          modelId: "anthropic.claude-sonnet-5",
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 200,
          callIndex: 0,
          capturedAt: "2026-10-01T00:00:00.000Z",
          source: "worker",
        },
      ],
    },
  } as unknown as IncomingEvent;
}

async function firstItem(): Promise<Record<string, unknown>> {
  const calls = ddbMock.commandCalls(PutCommand);
  return calls[0].args[0].input.Item as Record<string, unknown>;
}

describe("cost-ledger-writer: agent tag propagation (CIT-042)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.onAnyCommand().resolves({});
    process.env.AGENT_CONFIG_TABLE = "citadel-agent-config-test";
    _testInternals.resetAgentTagState();
  });

  it("copies agent tags onto the ledger row when present", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { agentId: "agent-1", tags: { team: "ml", env: "prod" } },
    });
    await handler(taskEvent());
    const item = await firstItem();
    expect(item.tags).toEqual({ team: "ml", env: "prod" });
  });

  it("omits tags when agent cache item has no tags attribute", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { agentId: "agent-1" } });
    await handler(taskEvent());
    const item = await firstItem();
    expect("tags" in item).toBe(false);
  });

  it("omits tags when agent cache item has empty tags", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { agentId: "agent-1", tags: {} },
    });
    await handler(taskEvent());
    const item = await firstItem();
    expect("tags" in item).toBe(false);
  });

  it("writes row without tags when GetItem throws (never drops row)", async () => {
    ddbMock.on(GetCommand).rejects(new Error("Simulated DDB error"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await handler(taskEvent());
    const item = await firstItem();
    expect("tags" in item).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "cost-ledger-writer: agent tag lookup failed, writing row without tags",
      expect.objectContaining({ agentId: "agent-1" }),
    );
    warnSpy.mockRestore();
  });

  it("writes row without tags and warns once when AGENT_CONFIG_TABLE env is missing", async () => {
    delete process.env.AGENT_CONFIG_TABLE;
    _testInternals.resetAgentTagState();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await handler(taskEvent());
    const item = await firstItem();
    expect("tags" in item).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "cost-ledger-writer: AGENT_CONFIG_TABLE env not set, writing rows without agent tags",
    );
    // Warn fires only once across a batch
    warnSpy.mockClear();
    _testInternals.resetAgentTagState(); // reset for second invocation
    delete process.env.AGENT_CONFIG_TABLE;
    await handler(
      taskEvent({
        usage: [
          {
            modelId: "anthropic.claude-sonnet-5",
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
            callIndex: 0,
            capturedAt: "2026-10-01T00:00:00.000Z",
            source: "worker",
          },
          {
            modelId: "anthropic.claude-sonnet-5",
            inputTokens: 20,
            outputTokens: 10,
            latencyMs: 150,
            callIndex: 1,
            capturedAt: "2026-10-01T00:00:01.000Z",
            source: "worker",
          },
        ],
      }),
    );
    // Should have warned exactly once (not per-row)
    expect(
      warnSpy.mock.calls.filter((c) =>
        (c[0] as string).includes("AGENT_CONFIG_TABLE env not set"),
      ),
    ).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("memoises agent tags — second call for same agentId does not issue another GetItem", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { agentId: "agent-1", tags: { team: "ml" } },
    });
    // Two usage records in one event → two buildLedgerRow calls for same agent
    await handler(
      taskEvent({
        usage: [
          {
            modelId: "anthropic.claude-sonnet-5",
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
            callIndex: 0,
            capturedAt: "2026-10-01T00:00:00.000Z",
            source: "worker",
          },
          {
            modelId: "anthropic.claude-sonnet-5",
            inputTokens: 20,
            outputTokens: 10,
            latencyMs: 150,
            callIndex: 1,
            capturedAt: "2026-10-01T00:00:01.000Z",
            source: "worker",
          },
        ],
      }),
    );
    // Should have exactly 1 GetCommand call to agent config table (memoised)
    const getCalls = ddbMock
      .commandCalls(GetCommand)
      .filter((c) => c.args[0].input.TableName === "citadel-agent-config-test");
    expect(getCalls).toHaveLength(1);
    // Both rows should have tags
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(2);
    expect(
      (putCalls[0].args[0].input.Item as Record<string, unknown>).tags,
    ).toEqual({ team: "ml" });
    expect(
      (putCalls[1].args[0].input.Item as Record<string, unknown>).tags,
    ).toEqual({ team: "ml" });
  });

  it("bounds tags to 10 keys maximum", async () => {
    const manyTags: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      manyTags[`key${i}`] = `val${i}`;
    }
    ddbMock.on(GetCommand).resolves({
      Item: { agentId: "agent-1", tags: manyTags },
    });
    await handler(taskEvent());
    const item = await firstItem();
    expect(Object.keys(item.tags as Record<string, string>)).toHaveLength(10);
  });
});
