/**
 * CIT-030: Tests for pauseExecution, approveExecution, denyExecution,
 * listAwaitingApprovals mutations.
 *
 * Covers: role gate (developer refused, architect/admin ok), cross-org
 * refused, approve emits decision payload with stored token, token absent
 * from all responses, pause marker written, list scoping.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
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

// Set env vars BEFORE importing the handler so module-level constants
// (EVENT_BUS_NAME, EXECUTIONS_TABLE, etc.) capture the test values.
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

const EXECUTION_AWAITING = {
  executionId: "exec-1",
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
      reason: "Needs human sign-off",
      requestedBy: "system",
      requestedAt: "2026-10-05T00:00:00Z",
      resumeToken: "secret-token-uuid",
      expiresAt: "2026-10-06T00:00:00Z",
      decidedBy: null,
      decidedAt: null,
      decision: null,
      orgId: "org-1",
    },
  },
  startedAt: "2026-10-04T00:00:00Z",
  triggeredBy: "user-100",
  runId: "run-abc",
};

const EXECUTION_RUNNING = {
  executionId: "exec-2",
  workflowId: "wf-1",
  orgId: "org-1",
  status: "running",
  nodeResults: {},
  startedAt: "2026-10-04T00:00:00Z",
  triggeredBy: "user-100",
};

describe("execution-resolver — CIT-030 approval mutations", () => {
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

  // ─── Role Gate Tests ───────────────────────────────────────────

  describe("role gate — developer refused, architect/admin ok", () => {
    test("developer is refused on pauseExecution", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_RUNNING } });
      await expect(
        invoke(
          makeEvent(
            "pauseExecution",
            { executionId: "exec-2", reason: "hold" },
            { groups: ["developer"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("admin or architect role required");
    });

    test("developer is refused on approveExecution", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-1", nodeId: "node-a" },
            { groups: ["developer"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("admin or architect role required");
    });

    test("developer is refused on denyExecution", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      await expect(
        invoke(
          makeEvent(
            "denyExecution",
            { executionId: "exec-1", nodeId: "node-a", reason: "no" },
            { groups: ["developer"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("admin or architect role required");
    });

    test("developer is refused on listAwaitingApprovals", async () => {
      await expect(
        invoke(
          makeEvent(
            "listAwaitingApprovals",
            {},
            { groups: ["developer"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("admin or architect role required");
    });

    test("architect can approve", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "approved",
              decidedBy: "user-123",
              decidedAt: "2026-10-05T01:00:00Z",
            },
          },
        },
      });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "approveExecution",
          { executionId: "exec-1", nodeId: "node-a" },
          { groups: ["architect"], org: "org-1" },
        ),
      );
      expect(result).toBeDefined();
      expect(result.executionId).toBe("exec-1");
    });

    test("admin can approve", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "approved",
              decidedBy: "admin-1",
              decidedAt: "2026-10-05T01:00:00Z",
            },
          },
        },
      });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "approveExecution",
          { executionId: "exec-1", nodeId: "node-a" },
          { groups: ["admin"], org: "org-1", sub: "admin-1" },
        ),
      );
      expect(result).toBeDefined();
    });
  });

  // ─── Cross-Org Refused ─────────────────────────────────────────

  describe("cross-org access refused", () => {
    test("architect in org-2 cannot approve execution in org-1", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-1", nodeId: "node-a" },
            { groups: ["architect"], org: "org-2" },
          ),
        ),
      ).rejects.toThrow("Access denied");
    });

    test("architect in org-2 cannot pause execution in org-1", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_RUNNING } });
      await expect(
        invoke(
          makeEvent(
            "pauseExecution",
            { executionId: "exec-2", reason: "hold" },
            { groups: ["architect"], org: "org-2" },
          ),
        ),
      ).rejects.toThrow("Access denied");
    });
  });

  // ─── approveExecution ──────────────────────────────────────────

  describe("approveExecution", () => {
    test("emits decision payload with stored resume token", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "approved",
              decidedBy: "user-123",
            },
          },
        },
      });

      await invoke(
        makeEvent(
          "approveExecution",
          { executionId: "exec-1", nodeId: "node-a" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls.length).toBeGreaterThanOrEqual(1);

      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEvent = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEvent).toBeDefined();

      const detail = JSON.parse(resumeEvent!.Detail!);
      expect(detail.approval_decision).toBeDefined();
      expect(detail.approval_decision.decision).toBe("approved");
      expect(detail.approval_decision.node_id).toBe("node-a");
      expect(detail.approval_decision.resume_token).toBe("secret-token-uuid");
      expect(detail.approval_decision.decided_by).toBe("user-123");
      expect(detail.approval_decision.org_id).toBe("org-1");
    });

    test("resume token is absent from the response", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...EXECUTION_AWAITING },
      });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "approveExecution",
          { executionId: "exec-1", nodeId: "node-a" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      // resumeToken must not appear anywhere in the response
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("resumeToken");
      expect(resultStr).not.toContain("secret-token-uuid");
    });

    test("rejects if execution is not awaiting_approval", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_RUNNING } });

      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-2", nodeId: "node-a" },
            { groups: ["architect"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("Cannot approve execution");
    });
  });

  // ─── denyExecution ─────────────────────────────────────────────

  describe("denyExecution", () => {
    test("emits denied decision payload with stored resume token and reason", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "denied",
              decidedBy: "user-123",
            },
          },
        },
      });

      await invoke(
        makeEvent(
          "denyExecution",
          {
            executionId: "exec-1",
            nodeId: "node-a",
            reason: "Risky operation",
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
      expect(detail.approval_decision.resume_token).toBe("secret-token-uuid");
      expect(detail.approval_decision.reason).toBe("Risky operation");
    });

    test("token absent from deny response", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...EXECUTION_AWAITING },
      });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "denyExecution",
          { executionId: "exec-1", nodeId: "node-a", reason: "no" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("resumeToken");
      expect(resultStr).not.toContain("secret-token-uuid");
    });
  });

  // ─── pauseExecution ────────────────────────────────────────────

  describe("pauseExecution", () => {
    test("writes pauseRequested marker and emits event", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_RUNNING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_RUNNING,
          pauseRequested: {
            reason: "Deploying hotfix",
            requestedBy: "user-123",
            requestedAt: "2026-10-05T01:00:00Z",
          },
        },
      });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "pauseExecution",
          { executionId: "exec-2", reason: "Deploying hotfix" },
          { groups: ["admin"], org: "org-1" },
        ),
      );

      expect(result.pauseRequested).toBeDefined();

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const pauseEvent = entries.find(
        (e) => e.DetailType === "execution.pause.requested",
      );
      expect(pauseEvent).toBeDefined();

      const detail = JSON.parse(pauseEvent!.Detail!);
      expect(detail.executionId).toBe("exec-2");
      expect(detail.reason).toBe("Deploying hotfix");
    });

    test("rejects pause on terminal execution", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { ...EXECUTION_RUNNING, status: "completed" },
      });

      await expect(
        invoke(
          makeEvent(
            "pauseExecution",
            { executionId: "exec-2", reason: "hold" },
            { groups: ["admin"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("Cannot pause execution in terminal state");
    });
  });

  // ─── listAwaitingApprovals ─────────────────────────────────────

  describe("listAwaitingApprovals", () => {
    test("returns executions with awaiting_approval status", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          {
            ...EXECUTION_AWAITING,
            approvalRequests: {
              "node-a": {
                ...EXECUTION_AWAITING.approvalRequests["node-a"],
              },
            },
          },
        ],
      });

      const result = await invoke<{ items: Record<string, unknown>[] }>(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["admin"], org: "org-1" },
        ),
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("awaiting_approval");
    });

    test("strips resumeToken from listed results", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [{ ...EXECUTION_AWAITING }],
      });

      const result = await invoke<{ items: Record<string, unknown>[] }>(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["admin"], org: "org-1" },
        ),
      );

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("resumeToken");
      expect(resultStr).not.toContain("secret-token-uuid");
    });

    test("architect scoped to own org", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      await invoke(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls.length).toBe(1);
      const filter = scanCalls[0].args[0].input.FilterExpression;
      expect(filter).toContain("#orgId = :orgId");
    });

    test("admin sees all orgs (no org filter)", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      await invoke(
        makeEvent(
          "listAwaitingApprovals",
          {},
          { groups: ["admin"], org: "org-1" },
        ),
      );

      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls.length).toBe(1);
      const filter = scanCalls[0].args[0].input.FilterExpression;
      expect(filter).not.toContain("orgId");
    });
  });

  // ─── getExecution strips token ─────────────────────────────────

  describe("getExecution strips resumeToken", () => {
    test("resumeToken not present in getExecution response", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "getExecution",
          { executionId: "exec-1" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("resumeToken");
      expect(resultStr).not.toContain("secret-token-uuid");
    });

    test("approvalRequests carry nodeId from the map key", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });

      const result = await invoke<Record<string, unknown>>(
        makeEvent(
          "getExecution",
          { executionId: "exec-1" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const requests = result.approvalRequests as Array<
        Record<string, unknown>
      >;
      expect(requests).toHaveLength(1);
      expect(requests[0].nodeId).toBe("node-a");
    });
  });

  // ─── Event bus/source/detail-type parity ───────────────────────

  describe("emitEvent uses correct bus, source, and detail type", () => {
    test("pauseExecution emits on EVENT_BUS_NAME with Source citadel.workflows", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_RUNNING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_RUNNING,
          pauseRequested: {
            reason: "hold",
            requestedBy: "user-123",
            requestedAt: "2026-10-05T01:00:00Z",
          },
        },
      });

      await invoke(
        makeEvent(
          "pauseExecution",
          { executionId: "exec-2", reason: "hold" },
          { groups: ["admin"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const pauseEntry = entries.find(
        (e) => e.DetailType === "execution.pause.requested",
      );
      expect(pauseEntry).toBeDefined();
      expect(pauseEntry!.EventBusName).toBe("citadel-agents-test");
      expect(pauseEntry!.Source).toBe("citadel.workflows");
      expect(pauseEntry!.DetailType).toBe("execution.pause.requested");
    });

    test("approveExecution emits on EVENT_BUS_NAME with Source citadel.workflows", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "approved",
              decidedBy: "user-123",
            },
          },
        },
      });

      await invoke(
        makeEvent(
          "approveExecution",
          { executionId: "exec-1", nodeId: "node-a" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEntry = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEntry).toBeDefined();
      expect(resumeEntry!.EventBusName).toBe("citadel-agents-test");
      expect(resumeEntry!.Source).toBe("citadel.workflows");
    });

    test("denyExecution emits on EVENT_BUS_NAME with Source citadel.workflows", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "denied",
              decidedBy: "user-123",
            },
          },
        },
      });

      await invoke(
        makeEvent(
          "denyExecution",
          { executionId: "exec-1", nodeId: "node-a", reason: "no" },
          { groups: ["architect"], org: "org-1" },
        ),
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const entries = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
      const resumeEntry = entries.find(
        (e) => e.DetailType === "execution.resume.requested",
      );
      expect(resumeEntry).toBeDefined();
      expect(resumeEntry!.EventBusName).toBe("citadel-agents-test");
      expect(resumeEntry!.Source).toBe("citadel.workflows");
    });
  });

  // ─── FailedEntryCount surfaces error ───────────────────────────

  describe("FailedEntryCount > 0 surfaces an error", () => {
    test("pauseExecution throws when PutEvents has FailedEntryCount", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_RUNNING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_RUNNING,
          pauseRequested: {
            reason: "hold",
            requestedBy: "user-123",
            requestedAt: "2026-10-05T01:00:00Z",
          },
        },
      });
      ebMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "bus down" }],
      });

      await expect(
        invoke(
          makeEvent(
            "pauseExecution",
            { executionId: "exec-2", reason: "hold" },
            { groups: ["admin"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("EventBridge publish failed");
    });

    test("approveExecution throws when PutEvents has FailedEntryCount", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "approved",
              decidedBy: "user-123",
            },
          },
        },
      });
      ebMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 1,
        Entries: [
          { ErrorCode: "ThrottlingException", ErrorMessage: "rate exceeded" },
        ],
      });

      await expect(
        invoke(
          makeEvent(
            "approveExecution",
            { executionId: "exec-1", nodeId: "node-a" },
            { groups: ["architect"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("EventBridge publish failed");
    });

    test("denyExecution throws when PutEvents has FailedEntryCount", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...EXECUTION_AWAITING } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          ...EXECUTION_AWAITING,
          approvalRequests: {
            "node-a": {
              ...EXECUTION_AWAITING.approvalRequests["node-a"],
              decision: "denied",
              decidedBy: "user-123",
            },
          },
        },
      });
      ebMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "bus error" }],
      });

      await expect(
        invoke(
          makeEvent(
            "denyExecution",
            { executionId: "exec-1", nodeId: "node-a", reason: "no" },
            { groups: ["architect"], org: "org-1" },
          ),
        ),
      ).rejects.toThrow("EventBridge publish failed");
    });
  });
});
