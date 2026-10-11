/**
 * CIT-237: Tests for execution-scoped pause API surface.
 *
 * Covers: listAwaitingApprovals returns running execution with pendingApproval
 * marker; approve '__execution__' emits correct event; scope/nodeIds surfaced
 * in API response; legacy per-node behaviour unchanged.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
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

process.env.EXECUTIONS_TABLE = "citadel-executions-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";

import { handler, __resetColdStartForTest } from "../execution-resolver";

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

async function invoke<T = Record<string, unknown>>(
  event: HandlerEvent,
): Promise<T> {
  return (await invokeHandler(event)) as T;
}

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  options?: { groups?: string[]; org?: string; sub?: string },
): HandlerEvent {
  const groups = options?.groups ?? [];
  const org = options?.org ?? "org-1";
  const sub = options?.sub ?? "user-123";
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      sub,
      "custom:organization": org,
      "cognito:groups": groups,
      claims: {
        sub,
        "custom:organization": org,
        "cognito:groups": groups,
      },
    },
  } as unknown as HandlerEvent;
}

/** Execution with execution-scoped __execution__ approval request. */
const EXEC_SCOPED_AWAITING = {
  executionId: "exec-scoped-1",
  workflowId: "wf-1",
  orgId: "org-1",
  status: "awaiting_approval",
  pendingApproval: "Y",
  nodeResults: {
    "node-a": {
      nodeId: "node-a",
      agentId: "agent-1",
      status: "awaiting_approval",
      retryCount: 0,
    },
    "node-b": {
      nodeId: "node-b",
      agentId: "agent-2",
      status: "awaiting_approval",
      retryCount: 0,
    },
  },
  approvalRequests: {
    __execution__: {
      requestType: "execution_pause",
      reason: "Manual pause requested",
      requestedBy: "user-100",
      requestedAt: "2026-10-05T00:00:00Z",
      resumeToken: "exec-secret-token",
      decidedBy: null,
      decidedAt: null,
      decision: null,
      orgId: "org-1",
      scope: "execution",
      nodeIds: ["node-a", "node-b"],
    },
  },
  startedAt: "2026-10-04T00:00:00Z",
  triggeredBy: "user-100",
  runId: "run-xyz",
};

/** Running execution with pendingApproval marker (some nodes still parked). */
const EXEC_RUNNING_WITH_PENDING = {
  ...EXEC_SCOPED_AWAITING,
  executionId: "exec-running-pa",
  status: "running",
  nodeResults: {
    "node-a": {
      nodeId: "node-a",
      agentId: "agent-1",
      status: "awaiting_approval",
      retryCount: 0,
    },
    "node-b": {
      nodeId: "node-b",
      agentId: "agent-2",
      status: "running",
      retryCount: 0,
    },
  },
};

/** Legacy per-node execution (pre-engine change, no pendingApproval marker). */
const EXEC_LEGACY_AWAITING = {
  executionId: "exec-legacy",
  workflowId: "wf-1",
  orgId: "org-1",
  status: "awaiting_approval",
  nodeResults: {
    "node-a": {
      nodeId: "node-a",
      agentId: "agent-1",
      status: "awaiting_approval",
      retryCount: 0,
    },
  },
  approvalRequests: {
    "node-a": {
      requestType: "approval_required",
      reason: "Needs sign-off",
      requestedBy: "system",
      requestedAt: "2026-10-05T00:00:00Z",
      resumeToken: "legacy-token",
      decidedBy: null,
      decidedAt: null,
      decision: null,
      orgId: "org-1",
    },
  },
  startedAt: "2026-10-04T00:00:00Z",
  triggeredBy: "user-100",
};

describe("CIT-237: execution-scoped pause API", () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cwMock.reset();
    cognitoMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    cwMock.on(PutMetricDataCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: "sub", Value: "user-123" },
        { Name: "custom:organization", Value: "org-1" },
      ],
    });
    __resetColdStartForTest();
  });

  // ── listAwaitingApprovals ────────────────────────────────────────

  describe("listAwaitingApprovals", () => {
    test("returns running execution with pendingApproval='Y' marker", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [{ ...EXEC_RUNNING_WITH_PENDING }],
      });

      const result = await invoke<{ items: Record<string, unknown>[] }>(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["admin"], org: "org-1" },
        ),
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("running");
      expect(result.items[0].executionId).toBe("exec-running-pa");
    });

    test("scan filter includes pendingApproval OR status fallback", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      await invoke(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["admin"], org: "org-1" },
        ),
      );

      const scanCalls = ddbMock.commandCalls(ScanCommand);
      const filter = scanCalls[0].args[0].input.FilterExpression;
      expect(filter).toContain("pendingApproval");
      expect(filter).toContain("awaitingApproval");
    });

    test("returns legacy awaiting_approval execution via fallback filter", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [{ ...EXEC_LEGACY_AWAITING }],
      });

      const result = await invoke<{ items: Record<string, unknown>[] }>(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["admin"], org: "org-1" },
        ),
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].executionId).toBe("exec-legacy");
    });
  });

  // ── approveExecution — __execution__ sentinel ────────────────────

  describe("approveExecution with __execution__", () => {
    test("emits execution.resume.requested with node_id='__execution__'", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_SCOPED_AWAITING } });

      await invoke(
        makeEvent(
          "approveExecution",
          { executionId: "exec-scoped-1", nodeId: "__execution__" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEvent = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEvent).toBeDefined();

      const detail = JSON.parse(resumeEvent!.Detail!);
      expect(detail.approval_decision.decision).toBe("approved");
      expect(detail.approval_decision.node_id).toBe("__execution__");
      expect(detail.approval_decision.resume_token).toBe("exec-secret-token");
    });

    test("accepts __execution__ when execution status is running", async () => {
      ddbMock
        .on(GetCommand)
        .resolves({ Item: { ...EXEC_RUNNING_WITH_PENDING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "approveExecution",
          { executionId: "exec-running-pa", nodeId: "__execution__" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      expect(result.executionId).toBe("exec-running-pa");
    });

    test("rejects __execution__ when execution is completed", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { ...EXEC_SCOPED_AWAITING, status: "completed" },
      });

      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-scoped-1", nodeId: "__execution__" },
            { groups: ["architect"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("Cannot approve execution");
    });

    test("resumeToken is stripped from response", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_SCOPED_AWAITING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "approveExecution",
          { executionId: "exec-scoped-1", nodeId: "__execution__" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("resumeToken");
      expect(resultStr).not.toContain("exec-secret-token");
    });
  });

  // ── denyExecution — __execution__ sentinel ───────────────────────

  describe("denyExecution with __execution__", () => {
    test("emits denied event with node_id='__execution__'", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_SCOPED_AWAITING } });

      await invoke(
        makeEvent(
          "denyExecution",
          {
            executionId: "exec-scoped-1",
            nodeId: "__execution__",
            reason: "Security concern",
          },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEvent = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEvent).toBeDefined();

      const detail = JSON.parse(resumeEvent!.Detail!);
      expect(detail.approval_decision.decision).toBe("denied");
      expect(detail.approval_decision.node_id).toBe("__execution__");
      expect(detail.approval_decision.reason).toBe("Security concern");
    });

    test("accepts __execution__ when execution status is running", async () => {
      ddbMock
        .on(GetCommand)
        .resolves({ Item: { ...EXEC_RUNNING_WITH_PENDING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "denyExecution",
          {
            executionId: "exec-running-pa",
            nodeId: "__execution__",
            reason: "no",
          },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      expect(result.executionId).toBe("exec-running-pa");
    });
  });

  // ── scope and nodeIds surfaced in API response ───────────────────

  describe("scope and nodeIds surfaced", () => {
    test("getExecution surfaces scope and nodeIds from __execution__ request", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_SCOPED_AWAITING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "getExecution",
          { executionId: "exec-scoped-1" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ar = result.approvalRequests as Array<Record<string, unknown>>;
      expect(ar).toHaveLength(1);
      expect(ar[0].nodeId).toBe("__execution__");
      expect(ar[0].scope).toBe("execution");
      expect(ar[0].nodeIds).toEqual(["node-a", "node-b"]);
    });

    test("legacy per-node request has no scope or nodeIds", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_LEGACY_AWAITING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "getExecution",
          { executionId: "exec-legacy" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ar = result.approvalRequests as Array<Record<string, unknown>>;
      expect(ar).toHaveLength(1);
      expect(ar[0].nodeId).toBe("node-a");
      expect(ar[0].scope).toBeUndefined();
      expect(ar[0].nodeIds).toBeUndefined();
    });
  });

  // ── Legacy per-node approve/deny unchanged ───────────────────────

  describe("legacy per-node approve/deny unchanged", () => {
    test("approve per-node request still works", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_LEGACY_AWAITING } });

      await invoke(
        makeEvent(
          "approveExecution",
          { executionId: "exec-legacy", nodeId: "node-a" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEvent = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEvent).toBeDefined();

      const detail = JSON.parse(resumeEvent!.Detail!);
      expect(detail.approval_decision.node_id).toBe("node-a");
    });

    test("deny per-node request still works", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXEC_LEGACY_AWAITING } });

      await invoke(
        makeEvent(
          "denyExecution",
          { executionId: "exec-legacy", nodeId: "node-a", reason: "nope" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEvent = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEvent).toBeDefined();

      const detail = JSON.parse(resumeEvent!.Detail!);
      expect(detail.approval_decision.node_id).toBe("node-a");
      expect(detail.approval_decision.decision).toBe("denied");
    });

    test("per-node approve still rejects non-awaiting status", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { ...EXEC_LEGACY_AWAITING, status: "running" },
      });

      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-legacy", nodeId: "node-a" },
            { groups: ["architect"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("Cannot approve execution");
    });
  });

  // ── Idempotency: already-decided execution-scoped request ────────

  describe("idempotency for execution-scoped requests", () => {
    test("re-approve __execution__ with nodes still awaiting is idempotent", async () => {
      const alreadyApproved = {
        ...EXEC_SCOPED_AWAITING,
        approvalRequests: {
          __execution__: {
            ...EXEC_SCOPED_AWAITING.approvalRequests.__execution__,
            decision: "approved",
          },
        },
      };
      ddbMock.on(GetCommand).resolves({ Item: alreadyApproved });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "approveExecution",
          { executionId: "exec-scoped-1", nodeId: "__execution__" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      expect(result.executionId).toBe("exec-scoped-1");
    });

    test("approve __execution__ with all nodes resolved throws already-decided", async () => {
      const allResolved = {
        ...EXEC_SCOPED_AWAITING,
        nodeResults: {
          "node-a": { nodeId: "node-a", status: "pending", retryCount: 0 },
          "node-b": { nodeId: "node-b", status: "completed", retryCount: 0 },
        },
        approvalRequests: {
          __execution__: {
            ...EXEC_SCOPED_AWAITING.approvalRequests.__execution__,
            decision: "approved",
          },
        },
      };
      ddbMock.on(GetCommand).resolves({ Item: allResolved });

      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-scoped-1", nodeId: "__execution__" },
            { groups: ["architect"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("already approved");
    });
  });
});
