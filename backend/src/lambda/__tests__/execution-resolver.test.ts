/**
 * Unit tests for execution-resolver Lambda
 * Uses aws-sdk-client-mock for DynamoDB, EventBridge, Cognito
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cwMock = mockClient(CloudWatchClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

import { handler, __resetColdStartForTest } from "../execution-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  sub = "user-123",
): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as unknown as HandlerEvent;
}

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

/** Invokes the handler and casts the result. */
async function invoke<T = Record<string, unknown>>(
  event: HandlerEvent,
): Promise<T> {
  return (await invokeHandler(event)) as T;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: "sub", Value: "user-123" },
      { Name: "custom:organization", Value: orgId },
    ],
  });
}

describe("execution-resolver", () => {
  beforeAll(() => {
    process.env.EXECUTIONS_TABLE = "citadel-executions-test";
    process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
    process.env.EVENT_BUS_NAME = "citadel-agents-test";
    process.env.USER_POOL_ID = "us-east-1_test";
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cwMock.reset();
    cognitoMock.reset();
    mockCognitoOrg("org-1");
    ebMock.on(PutEventsCommand).resolves({});
    cwMock.on(PutMetricDataCommand).resolves({});
    __resetColdStartForTest();
  });

  afterAll(() => {
    delete process.env.EXECUTIONS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // ─── getExecution ──────────────────────────────────────────────

  describe("getExecution", () => {
    test("returns item and verifies org access", async () => {
      const execution = {
        executionId: "exec-1",
        workflowId: "wf-1",
        orgId: "org-1",
        status: "pending",
        nodeResults: {},
        startedAt: "2024-01-01T00:00:00Z",
        triggeredBy: "user-123",
      };
      ddbMock.on(GetCommand).resolves({ Item: { ...execution } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent("getExecution", { executionId: "exec-1" }),
      );

      // Additive: usageTotals is added (null here — no usage on this
      // execution) but every pre-existing field is unchanged.
      expect(result).toEqual({ ...execution, usageTotals: null });
    });

    test("throws Access denied on org mismatch", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: "exec-1",
          workflowId: "wf-1",
          orgId: "org-other",
          status: "pending",
        },
      });

      await expect(
        invoke(makeEvent("getExecution", { executionId: "exec-1" })),
      ).rejects.toThrow("Access denied");
    });

    test("claim-first path: reads custom:organization from identity and skips Cognito", async () => {
      const execution = {
        executionId: "exec-claim",
        workflowId: "wf-claim",
        orgId: "org-claim",
        status: "pending",
        nodeResults: {},
        startedAt: "2024-01-01T00:00:00Z",
        triggeredBy: "user-123",
      };
      ddbMock.on(GetCommand).resolves({ Item: { ...execution } });

      const claimEvent = {
        info: { fieldName: "getExecution" },
        arguments: { executionId: "exec-claim" },
        identity: { sub: "user-123", "custom:organization": "org-claim" },
      } as unknown as HandlerEvent;

      const result = await invoke(claimEvent);

      expect(result).toEqual({ ...execution, usageTotals: null });
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test("returns additive usageTotals folded from per-node usageTotals", async () => {
      const execution = {
        executionId: "exec-usage",
        workflowId: "wf-1",
        orgId: "org-1",
        status: "completed",
        nodeResults: {
          n0: {
            nodeId: "n0",
            status: "completed",
            usageTotals: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              callCount: 1,
            },
          },
          n1: {
            nodeId: "n1",
            status: "completed",
            usageTotals: {
              inputTokens: 3,
              outputTokens: 7,
              totalTokens: 10,
              callCount: 2,
            },
          },
        },
        startedAt: "2024-01-01T00:00:00Z",
        triggeredBy: "user-123",
      };
      ddbMock.on(GetCommand).resolves({ Item: execution });

      const result = await invoke<Record<string, unknown>>(
        makeEvent("getExecution", { executionId: "exec-usage" }),
      );

      expect(result.usageTotals).toEqual({
        inputTokens: 13,
        outputTokens: 12,
        totalTokens: 25,
        callCount: 3,
      });
      // Additive: existing fields and access checks are untouched.
      expect(result.executionId).toBe("exec-usage");
    });

    test("falls back to node usage/output.usage when usageTotals absent", async () => {
      const execution = {
        executionId: "exec-usage-fallback",
        workflowId: "wf-1",
        orgId: "org-1",
        status: "completed",
        nodeResults: {
          n0: {
            nodeId: "n0",
            status: "completed",
            usage: [{ inputTokens: 4, outputTokens: 6 }],
          },
          n1: {
            nodeId: "n1",
            status: "completed",
            output: {
              response: "ok",
              usage: [{ inputTokens: 1, outputTokens: 1 }],
            },
          },
        },
        startedAt: "2024-01-01T00:00:00Z",
        triggeredBy: "user-123",
      };
      ddbMock.on(GetCommand).resolves({ Item: execution });

      const result = await invoke<Record<string, unknown>>(
        makeEvent("getExecution", { executionId: "exec-usage-fallback" }),
      );

      expect(result.usageTotals).toEqual({
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        callCount: 2,
      });
    });

    test("returns null usageTotals when no node carries usage (legacy run)", async () => {
      const execution = {
        executionId: "exec-legacy",
        workflowId: "wf-1",
        orgId: "org-1",
        status: "completed",
        nodeResults: {
          n0: {
            nodeId: "n0",
            status: "completed",
            output: JSON.stringify({ response: "ok" }),
          },
        },
        startedAt: "2024-01-01T00:00:00Z",
        triggeredBy: "user-123",
      };
      ddbMock.on(GetCommand).resolves({ Item: execution });

      const result = await invoke<Record<string, unknown>>(
        makeEvent("getExecution", { executionId: "exec-legacy" }),
      );

      expect(result.usageTotals).toBeNull();
    });

    test("org access check still enforced when usage is present", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: "exec-usage-denied",
          workflowId: "wf-1",
          orgId: "org-other",
          status: "completed",
          nodeResults: {
            n0: {
              nodeId: "n0",
              status: "completed",
              usageTotals: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                callCount: 1,
              },
            },
          },
        },
      });

      await expect(
        invoke(makeEvent("getExecution", { executionId: "exec-usage-denied" })),
      ).rejects.toThrow("Access denied");
    });
  });

  // ─── listExecutions ────────────────────────────────────────────

  describe("listExecutions", () => {
    test("queries WorkflowIndex GSI by workflowId", async () => {
      const items = [
        {
          executionId: "exec-1",
          workflowId: "wf-1",
          status: "completed",
          startedAt: "2024-01-01T00:00:00Z",
        },
        {
          executionId: "exec-2",
          workflowId: "wf-1",
          status: "pending",
          startedAt: "2024-01-02T00:00:00Z",
        },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: items });

      const result = await invoke(
        makeEvent("listExecutions", { workflowId: "wf-1" }),
      );

      expect(result).toEqual({ items, nextToken: undefined });

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe("WorkflowIndex");
      expect(queryCall.args[0].input.KeyConditionExpression).toContain(
        "workflowId",
      );
    });
  });

  // ─── startExecution ────────────────────────────────────────────

  describe("startExecution", () => {
    const publishedWorkflow = {
      workflowId: "wf-1",
      orgId: "org-1",
      name: "Published Workflow",
      status: "PUBLISHED",
      version: 3,
      definition: JSON.stringify({
        nodes: [
          { id: "n1", agentId: "agent-1", type: "agent" },
          { id: "n2", agentId: "agent-2", type: "agent" },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      }),
    };

    test("verifies workflow is PUBLISHED, initializes all nodeResults as pending, publishes execution.start.requested event", async () => {
      // First GetCommand: workflow lookup
      ddbMock.on(GetCommand).resolves({ Item: publishedWorkflow });
      ddbMock.on(PutCommand).resolves({});

      const result = await invoke(
        makeEvent("startExecution", {
          workflowId: "wf-1",
          input: JSON.stringify({ key: "value" }),
        }),
      );

      // Execution created with correct fields
      expect(result.executionId).toBeDefined();
      expect(result.workflowId).toBe("wf-1");
      expect(result.status).toBe("pending");
      expect(result.workflowVersion).toBe(3);
      expect(result.orgId).toBe("org-1");
      expect(result.triggeredBy).toBe("user-123");
      expect(result.startedAt).toBeDefined();

      // All nodeResults initialized as pending
      const nodeResults = result.nodeResults as Record<
        string,
        { nodeId: string; agentId: string; status: string }
      >;
      expect(nodeResults).toBeDefined();
      expect(nodeResults["n1"]).toMatchObject({
        nodeId: "n1",
        agentId: "agent-1",
        status: "pending",
      });
      expect(nodeResults["n2"]).toMatchObject({
        nodeId: "n2",
        agentId: "agent-2",
        status: "pending",
      });

      // PutCommand for execution
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);

      // EventBridge: execution.start.requested
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe("citadel.workflows");
      expect(entry.DetailType).toBe("execution.start.requested");
      const detail = JSON.parse(entry.Detail!);
      expect(detail.executionId).toBe(result.executionId);
      expect(detail.workflowId).toBe("wf-1");
    });

    test("rejects DRAFT workflows", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          workflowId: "wf-draft",
          orgId: "org-1",
          name: "Draft Workflow",
          status: "DRAFT",
          version: 1,
          definition: JSON.stringify({ nodes: [], edges: [] }),
        },
      });

      await expect(
        invoke(makeEvent("startExecution", { workflowId: "wf-draft" })),
      ).rejects.toThrow(/published/i);
    });
  });

  // ─── cancelExecution ───────────────────────────────────────────

  describe("cancelExecution", () => {
    test("updates status to cancelled and publishes execution.cancel.requested event", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: "exec-1",
          workflowId: "wf-1",
          orgId: "org-1",
          status: "running",
        },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          executionId: "exec-1",
          workflowId: "wf-1",
          orgId: "org-1",
          status: "cancelled",
        },
      });

      const result = await invoke(
        makeEvent("cancelExecution", { executionId: "exec-1" }),
      );

      expect(result.status).toBe("cancelled");

      // UpdateCommand called
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      // EventBridge: execution.cancel.requested
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe("citadel.workflows");
      expect(entry.DetailType).toBe("execution.cancel.requested");
    });
  });

  // ─── resumeExecution ───────────────────────────────────────────

  describe("resumeExecution", () => {
    test("emits execution.resume.requested with only locating ids + server orgId", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: "exec-1",
          workflowId: "wf-1",
          orgId: "org-1",
          status: "running",
          runId: "run-abc",
        },
      });

      const result = await invoke(
        makeEvent("resumeExecution", { executionId: "exec-1" }),
      );
      expect((result as { status: string }).status).toBe("running");

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe("citadel.workflows");
      expect(entry.DetailType).toBe("execution.resume.requested");
      const detail = JSON.parse(entry.Detail!);
      // Server-derived frontier: payload carries ONLY locating ids + orgId,
      // never a node list / status override.
      expect(detail).toEqual({
        executionId: "exec-1",
        workflowId: "wf-1",
        orgId: "org-1",
        runId: "run-abc",
      });
    });

    test.each(["completed", "cancelled", "failed"])(
      "rejects terminal state %s without emitting an event (O5)",
      async (terminal) => {
        ddbMock.on(GetCommand).resolves({
          Item: {
            executionId: "exec-t",
            workflowId: "wf-1",
            orgId: "org-1",
            status: terminal,
          },
        });

        await expect(
          invoke(makeEvent("resumeExecution", { executionId: "exec-t" })),
        ).rejects.toThrow(/terminal state/);
        expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
      },
    );

    test("cross-org resume is denied (IDOR) before any event is emitted", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          executionId: "exec-other",
          workflowId: "wf-1",
          orgId: "org-other",
          status: "running",
        },
      });

      await expect(
        invoke(makeEvent("resumeExecution", { executionId: "exec-other" })),
      ).rejects.toThrow("Access denied");
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test("missing execution throws before emit", async () => {
      ddbMock.on(GetCommand).resolves({});
      await expect(
        invoke(makeEvent("resumeExecution", { executionId: "nope" })),
      ).rejects.toThrow("Execution not found");
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });
  });

  // ─── publishWorkflowProgress ───────────────────────────────────

  describe("publishWorkflowProgress", () => {
    const progressInput = {
      executionId: "exec-1",
      workflowId: "wf-1",
      eventType: "node.completed",
      nodeId: "n1",
      status: "completed",
      output: '{"result":"ok"}',
      error: null,
      timestamp: "2024-01-01T00:00:00Z",
    };

    test("echoes args.input so AppSync fans out to onWorkflowProgress subscribers", async () => {
      const result = await invoke(
        makeEvent("publishWorkflowProgress", { input: progressInput }),
      );

      expect(result).toEqual(progressInput);
    });

    test("does not throw Unknown field", async () => {
      await expect(
        invoke(makeEvent("publishWorkflowProgress", { input: progressInput })),
      ).resolves.toBeDefined();
    });
  });

  // ─── Cold-start metric ──────────────────────────────────────────

  describe("cold-start metric", () => {
    test("first invocation in a fresh container emits NodeColdStart", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await invoke(makeEvent("listExecutions", { workflowId: "wf-1" }));

      const calls = cwMock.commandCalls(PutMetricDataCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Namespace).toBe("Citadel/Workflows");
      expect(calls[0].args[0].input.MetricData?.[0]).toMatchObject({
        MetricName: "NodeColdStart",
        Value: 1,
        Unit: "Count",
      });
    });

    test("second invocation in the same (warm) container does not re-emit", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await invoke(makeEvent("listExecutions", { workflowId: "wf-1" }));
      await invoke(makeEvent("listExecutions", { workflowId: "wf-1" }));

      expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
    });

    test("a CloudWatch failure never fails the resolver", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      cwMock.on(PutMetricDataCommand).rejects(new Error("cloudwatch down"));

      await expect(
        invoke(makeEvent("listExecutions", { workflowId: "wf-1" })),
      ).resolves.toEqual({ items: [], nextToken: undefined });
    });
  });
});

// ─── computeExecutionUsageTotals (pure reduction, usage rollup) ────

import { computeExecutionUsageTotals } from "../execution-resolver";

describe("computeExecutionUsageTotals", () => {
  test("sums usageTotals across nodes", () => {
    const result = computeExecutionUsageTotals({
      n0: {
        nodeId: "n0",
        status: "completed",
        usageTotals: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          callCount: 1,
        },
      },
      n1: {
        nodeId: "n1",
        status: "completed",
        usageTotals: {
          inputTokens: 3,
          outputTokens: 7,
          totalTokens: 10,
          callCount: 2,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 13,
      outputTokens: 12,
      totalTokens: 25,
      callCount: 3,
    });
  });

  test("falls back to node usage array when usageTotals absent", () => {
    const result = computeExecutionUsageTotals({
      n0: {
        nodeId: "n0",
        status: "completed",
        usage: [{ inputTokens: 4, outputTokens: 6 }],
      },
    });
    expect(result).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
      callCount: 1,
    });
  });

  test("falls back to output.usage when neither usageTotals nor usage present", () => {
    const result = computeExecutionUsageTotals({
      n0: {
        nodeId: "n0",
        status: "completed",
        output: {
          response: "ok",
          usage: [{ inputTokens: 1, outputTokens: 1 }],
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      callCount: 1,
    });
  });

  test("handles a JSON-string output field defensively", () => {
    const result = computeExecutionUsageTotals({
      n0: {
        nodeId: "n0",
        status: "completed",
        output: JSON.stringify({
          response: "ok",
          usage: [{ inputTokens: 2, outputTokens: 2 }],
        }),
      },
    });
    expect(result).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
      callCount: 1,
    });
  });

  test("returns null for empty/undefined nodeResults", () => {
    expect(computeExecutionUsageTotals(undefined)).toBeNull();
    expect(computeExecutionUsageTotals({})).toBeNull();
  });

  test("returns null when no node carries any usage source", () => {
    const result = computeExecutionUsageTotals({
      n0: {
        nodeId: "n0",
        status: "completed",
        output: JSON.stringify({ response: "ok" }),
      },
    });
    expect(result).toBeNull();
  });

  test("malformed node entries never throw and are skipped", () => {
    const result = computeExecutionUsageTotals({
      n0: {
        nodeId: "n0",
        status: "completed",
        usageTotals: {
          inputTokens: 5,
          outputTokens: 5,
          totalTokens: 10,
          callCount: 1,
        },
      },
      n1: null as unknown as Record<string, unknown>,
      n2: {
        nodeId: "n2",
        status: "completed",
        usage: "not-an-array" as unknown as unknown[],
      },
    });
    expect(result).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      callCount: 1,
    });
  });

  test("is pure and idempotent: reducing the same input twice yields equal totals", () => {
    const nodeResults = {
      n0: {
        nodeId: "n0",
        status: "completed",
        usageTotals: {
          inputTokens: 6,
          outputTokens: 4,
          totalTokens: 10,
          callCount: 1,
        },
      },
    };
    const first = computeExecutionUsageTotals(nodeResults);
    const second = computeExecutionUsageTotals(nodeResults);
    expect(first).toEqual(second);
  });
});
