/**
 * tool-run-resolver.ts — Mutation.testTool backed by a RequestResponse
 * invoke of the worker wrapper Lambda (board task 10c3bf48, Slice 1).
 *
 * Covers: tool:execute authz (admin bypass, non-admin denied), server-
 * derived org (never the client), org-match / "All Organizations" sentinel
 * / mismatch -> "Tool not found", invalid-inputs rejection, happy path
 * (worker success mapped to ToolTestResult), worker structured error
 * surfaced, 25s client timeout -> TIMEOUT, and runId is always
 * server-minted (never accepted from the client).
 */
import { mockClient } from "aws-sdk-client-mock";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaMock = mockClient(LambdaClient);

jest.mock("../utils/resolve-tool-config", () => ({
  resolveToolConfig: jest.fn(),
}));

import { resolveToolConfig } from "../utils/resolve-tool-config";
import { handler } from "../tool-run-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

const resolveToolConfigMock = resolveToolConfig as jest.MockedFunction<
  typeof resolveToolConfig
>;

function payloadOf(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    identity: {
      sub: "user-1",
      username: "user-1",
      "cognito:groups": ["architect"],
      "custom:organization": "org-a",
    },
    arguments: {
      toolId: "echo-tool",
      inputs: "{}",
    },
    ...overrides,
  };
}

describe("tool-run-resolver handler", () => {
  beforeEach(() => {
    lambdaMock.reset();
    resolveToolConfigMock.mockReset();
    process.env.WORKER_WRAPPER_FUNCTION_ARN =
      "arn:aws:lambda:us-west-2:123456789012:function:citadel-worker-test";
  });

  test("denies a non-admin/non-architect caller (tool:execute required)", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-a",
    });
    const event = baseEvent({
      identity: {
        sub: "u2",
        username: "u2",
        "cognito:groups": ["developer"],
        "custom:organization": "org-a",
      },
    });
    const result = await handler(event as HandlerEvent);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tool:execute/);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("admin bypasses the tool:execute permission check but still needs org match", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-z",
    });
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadOf({
        runId: "server-minted",
        status: "success",
        output: { ok: true },
        durationMs: 12,
      }),
    });
    const event = baseEvent({
      identity: {
        sub: "admin-1",
        username: "admin-1",
        "cognito:groups": ["admin"],
        "custom:organization": "org-z",
      },
    });
    const result = await handler(event as HandlerEvent);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ ok: true });
  });

  test("org mismatch returns 'Tool not found' (no cross-tenant enumeration)", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-b",
    });
    const result = await handler(baseEvent() as HandlerEvent);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not found");
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("missing tool returns 'Tool not found'", async () => {
    resolveToolConfigMock.mockResolvedValue(null);
    const result = await handler(baseEvent() as HandlerEvent);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not found");
  });

  test("'All Organizations' sentinel is allowed through", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "All Organizations",
    });
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadOf({
        runId: "x",
        status: "success",
        output: {},
        durationMs: 1,
      }),
    });
    const result = await handler(baseEvent() as HandlerEvent);
    expect(result.success).toBe(true);
  });

  test("invalid inputs JSON is rejected before invoking the worker", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-a",
    });
    const event = baseEvent({
      arguments: { toolId: "echo-tool", inputs: "{not-json" },
    });
    const result = await handler(event as HandlerEvent);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid inputs/);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  test("happy path invokes the worker with kind:'tool-run' and a server-minted runId", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-a",
    });
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadOf({
        runId: "server-minted-id",
        status: "success",
        output: { echoed: "hi" },
        durationMs: 42,
      }),
    });
    const event = baseEvent({
      arguments: {
        toolId: "echo-tool",
        inputs: '{"msg":"hi"}',
        runId: "client-supplied-should-be-ignored",
      },
    });
    const result = await handler(event as HandlerEvent);

    expect(result).toEqual({
      success: true,
      output: { echoed: "hi" },
      executionTimeMs: 42,
    });
    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.InvocationType).toBe("RequestResponse");
    expect(input.FunctionName).toBe(process.env.WORKER_WRAPPER_FUNCTION_ARN);
    const sentPayload = JSON.parse(
      Buffer.from(input.Payload as Uint8Array).toString(),
    );
    expect(sentPayload.kind).toBe("tool-run");
    expect(sentPayload.toolId).toBe("echo-tool");
    expect(sentPayload.orgId).toBe("org-a");
    expect(sentPayload.runId).not.toBe("client-supplied-should-be-ignored");
    expect(typeof sentPayload.runId).toBe("string");
    expect(sentPayload.runId.length).toBeGreaterThan(0);
  });

  test("worker structured error is mapped onto ToolTestResult.error", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-a",
    });
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadOf({
        runId: "r1",
        status: "error",
        error: { code: "UNSUPPORTED_BINDING", message: "nope" },
        durationMs: 3,
      }),
    });
    const result = await handler(baseEvent() as HandlerEvent);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UNSUPPORTED_BINDING/);
    expect(result.error).toMatch(/nope/);
  });

  test("25s client timeout surfaces a structured TIMEOUT error", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-a",
    });
    lambdaMock.on(InvokeCommand).callsFake(() => {
      return new Promise(() => {
        // never resolves — forces the resolver's own timeout race to win
      });
    });
    const event = baseEvent();
    const resultPromise = handler(event as HandlerEvent, { timeoutMs: 25 });
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TIMEOUT/);
  }, 1000);

  test("invocation failure (Lambda throws) is mapped to a structured error", async () => {
    resolveToolConfigMock.mockResolvedValue({
      toolId: "echo-tool",
      orgId: "org-a",
    });
    lambdaMock
      .on(InvokeCommand)
      .rejects(new Error("ResourceNotFoundException"));
    const result = await handler(baseEvent() as HandlerEvent);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ResourceNotFoundException/);
  });
});
