/**
 * Unit tests for app-invoke-handler.ts — EventBridge consumer for the
 * per-app invoke path (source: citadel.app.invoke, detail-type:
 * app.invoke.requested).
 *
 * Covers:
 *  - selectWorkflowId pure helper: 0/1-match/1-diff/many-none/many-in/many-out
 *  - handler: happy path (execution created + event emitted), workflow-not-
 *    bound denial, non-PUBLISHED denial, malformed/oversized body rejection,
 *    duplicate-event idempotency, org/app mismatch denials.
 */
jest.mock("../../utils/idempotency", () => {
  const seen = new Set<string>();
  return {
    IdempotencyGuard: jest.fn().mockImplementation(() => ({
      withIdempotency: jest.fn(
        async (key: string, fn: () => Promise<unknown>) => {
          if (seen.has(key)) {
            return { executed: false };
          }
          seen.add(key);
          const result = await fn();
          return { executed: true, result };
        },
      ),
    })),
    __seen: seen,
    __reset: () => seen.clear(),
  };
});

import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";
import { EventBridgeEvent } from "aws-lambda";

import {
  handler,
  selectWorkflowId,
  AppInvokeEventDetail,
} from "../app-invoke-handler";

const idem = jest.requireMock("../../utils/idempotency") as {
  __reset: () => void;
};

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  idem.__reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────

const APP_ID = "app-42";
const ORG_ID = "org-1";
const WORKFLOW_ID = "wf-1";

function makeAppMetadata(overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    groupId: `APP#${APP_ID}`,
    sortId: "METADATA",
    name: "Test App",
    status: "PUBLISHED",
    workflowIds: [WORKFLOW_ID],
    orgId: ORG_ID,
    ...overrides,
  };
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: WORKFLOW_ID,
    orgId: ORG_ID,
    status: "PUBLISHED",
    definition: JSON.stringify({ nodes: [{ id: "n1", agentId: "agent-1" }] }),
    version: 1,
    ...overrides,
  };
}

function makeEvent(
  detail: Partial<AppInvokeEventDetail> = {},
  resources: string[] = [APP_ID],
  id = "evt-1",
): EventBridgeEvent<"app.invoke.requested", AppInvokeEventDetail> {
  return {
    id,
    version: "0",
    account: "123456789012",
    time: "2024-01-01T00:00:00Z",
    region: "us-east-1",
    source: "citadel.app.invoke",
    "detail-type": "app.invoke.requested",
    resources,
    detail: { input: {}, ...detail },
  };
}

/** Query mock: first call = app metadata GroupIndex query, second = workflow lookup. */
function mockAppQuery(items: unknown[]) {
  ddbMock
    .on(QueryCommand, {
      IndexName: "GroupIndex",
    })
    .resolves({ Items: items });
}

// ── selectWorkflowId (pure helper) ───────────────────────────

describe("selectWorkflowId", () => {
  test("0 bound workflows → undefined (no_bound_workflow)", () => {
    expect(selectWorkflowId([], undefined)).toBeUndefined();
    expect(selectWorkflowId([], "wf-x")).toBeUndefined();
  });

  test("1 bound, no requested → uses the single bound workflow", () => {
    expect(selectWorkflowId(["wf-1"], undefined)).toBe("wf-1");
  });

  test("1 bound, requested matches → uses it", () => {
    expect(selectWorkflowId(["wf-1"], "wf-1")).toBe("wf-1");
  });

  test("1 bound, requested differs → undefined (mismatch)", () => {
    expect(selectWorkflowId(["wf-1"], "wf-2")).toBeUndefined();
  });

  test("many bound, no requested → undefined (ambiguous)", () => {
    expect(selectWorkflowId(["wf-1", "wf-2"], undefined)).toBeUndefined();
  });

  test("many bound, requested is one of them → uses it", () => {
    expect(selectWorkflowId(["wf-1", "wf-2"], "wf-2")).toBe("wf-2");
  });

  test("many bound, requested not in set → undefined (not_bound)", () => {
    expect(selectWorkflowId(["wf-1", "wf-2"], "wf-3")).toBeUndefined();
  });
});

// ── Handler: happy path ──────────────────────────────────────

describe("handler happy path", () => {
  test("creates execution and emits execution.start.requested", async () => {
    mockAppQuery([makeAppMetadata()]);
    ddbMock.on(QueryCommand, { TableName: undefined }).resolves({});
    // Workflow lookup uses QueryCommand against WORKFLOWS_TABLE keyed differently —
    // route by table name via callsFake below instead of a second .on() overload.
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "GroupIndex") {
        return Promise.resolve({ Items: [makeAppMetadata()] });
      }
      return Promise.resolve({ Items: [] });
    });
    ddbMock.on(PutCommand).resolves({});
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "e1" }] });

    // Workflow GetCommand-style lookup — implemented via QueryCommand? We
    // instead expect the handler to fetch the workflow by primary key. Mock
    // whichever DynamoDB Document client command it issues by resolving both
    // Query and Get generically to the workflow item when not GroupIndex.
    const { GetCommand } = jest.requireActual("@aws-sdk/lib-dynamodb");
    ddbMock.on(GetCommand).resolves({ Item: makeWorkflow() });

    const result = await handler(
      makeEvent({ workflowId: WORKFLOW_ID, input: { foo: "bar" } }),
    );

    expect(result).toBeUndefined();

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const execItem = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(execItem.workflowId).toBe(WORKFLOW_ID);
    expect(execItem.appId).toBe(APP_ID);
    expect(execItem.orgId).toBe(ORG_ID);
    expect(execItem.status).toBe("pending");
    expect(execItem.triggeredBy).toBe(`app-invoke:${APP_ID}`);
    expect(execItem.nodeResults).toMatchObject({
      n1: {
        nodeId: "n1",
        agentId: "agent-1",
        status: "pending",
        retryCount: 0,
      },
    });

    const putEventsCalls = ebMock.commandCalls(PutEventsCommand);
    expect(putEventsCalls).toHaveLength(1);
    const entry = putEventsCalls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe("citadel.workflows");
    expect(entry.DetailType).toBe("execution.start.requested");
    const detail = JSON.parse(entry.Detail!);
    expect(detail.workflowId).toBe(WORKFLOW_ID);
    expect(detail.correlationId).toBe("evt-1");
  });

  test("uses resources[0] as appId and ignores any appId in the body", async () => {
    const { GetCommand } = jest.requireActual("@aws-sdk/lib-dynamodb");
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (
        input.IndexName === "GroupIndex" &&
        input.ExpressionAttributeValues?.[":gid"] === `APP#${APP_ID}`
      ) {
        return Promise.resolve({ Items: [makeAppMetadata()] });
      }
      return Promise.resolve({ Items: [] });
    });
    ddbMock.on(GetCommand).resolves({ Item: makeWorkflow() });
    ddbMock.on(PutCommand).resolves({});
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "e1" }] });

    await handler(
      makeEvent(
        { workflowId: WORKFLOW_ID, input: { appId: "attacker-app", value: 1 } },
        [APP_ID],
      ),
    );

    const execItem = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    expect(execItem.appId).toBe(APP_ID);
    const input = execItem.input as Record<string, unknown> | null;
    expect(input?.appId).toBeUndefined();
  });
});

// ── Handler: denial paths ────────────────────────────────────

describe("handler denial paths", () => {
  test("drops event when resources is empty", async () => {
    await handler(makeEvent({}, []));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test("drops event when app is not found", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent());

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when app is not PUBLISHED", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [makeAppMetadata({ status: "DRAFT" })] });

    await handler(makeEvent());

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when 0 workflows are bound to the app", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [makeAppMetadata({ workflowIds: [] })] });

    await handler(makeEvent());

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when many workflows are bound and body workflowId is missing", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAppMetadata({ workflowIds: ["wf-1", "wf-2"] })],
    });

    await handler(makeEvent({}));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when many workflows are bound and body workflowId is not in the set", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAppMetadata({ workflowIds: ["wf-1", "wf-2"] })],
    });

    await handler(makeEvent({ workflowId: "wf-not-bound" }));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when the resolved workflow is not PUBLISHED", async () => {
    const { GetCommand } = jest.requireActual("@aws-sdk/lib-dynamodb");
    ddbMock.on(QueryCommand).resolves({ Items: [makeAppMetadata()] });
    ddbMock
      .on(GetCommand)
      .resolves({ Item: makeWorkflow({ status: "DRAFT" }) });

    await handler(makeEvent({ workflowId: WORKFLOW_ID }));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when workflow orgId does not match app orgId (org mismatch)", async () => {
    const { GetCommand } = jest.requireActual("@aws-sdk/lib-dynamodb");
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [makeAppMetadata({ orgId: "org-1" })] });
    ddbMock.on(GetCommand).resolves({ Item: makeWorkflow({ orgId: "org-2" }) });

    await handler(makeEvent({ workflowId: WORKFLOW_ID }));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when workflow.appId is set and does not match the trusted appId (cross-app)", async () => {
    const { GetCommand } = jest.requireActual("@aws-sdk/lib-dynamodb");
    ddbMock.on(QueryCommand).resolves({ Items: [makeAppMetadata()] });
    ddbMock
      .on(GetCommand)
      .resolves({ Item: makeWorkflow({ appId: "some-other-app" }) });

    await handler(makeEvent({ workflowId: WORKFLOW_ID }));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("drops event when the body exceeds the 64KiB size cap", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeAppMetadata()] });

    const oversized = { blob: "x".repeat(70_000) };
    await handler(makeEvent({ workflowId: WORKFLOW_ID, input: oversized }));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

// ── Handler: idempotency ─────────────────────────────────────

describe("handler idempotency", () => {
  test("duplicate event.id is a no-op on the second delivery", async () => {
    const { GetCommand } = jest.requireActual("@aws-sdk/lib-dynamodb");
    ddbMock.on(QueryCommand).resolves({ Items: [makeAppMetadata()] });
    ddbMock.on(GetCommand).resolves({ Item: makeWorkflow() });
    ddbMock.on(PutCommand).resolves({});
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "e1" }] });

    const evt = makeEvent({ workflowId: WORKFLOW_ID }, [APP_ID], "evt-dup-1");
    await handler(evt);
    await handler(evt);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
  });
});
