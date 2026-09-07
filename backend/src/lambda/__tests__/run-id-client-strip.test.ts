/**
 * Behavioral client-strip tests for the 4 TS runId entry points (Pass 1,
 * decision f1cbd5ef; verify-p1 NEEDS_CHANGES item 3).
 *
 * Prior to this file, `app-invoke-handler.test.ts` had ZERO runId
 * references and no TS entry point had a behavioral test proving a
 * client-supplied runId is ignored and a fresh server-minted value used
 * instead — only the Python `workflow_contract` test proved the strip
 * discipline. This file exercises each entry point with an attacker-
 * supplied `runId` planted in the inbound payload and asserts:
 *   1. the outbound event/record's runId does NOT equal the planted value
 *   2. the outbound event/record's runId matches the `run-<uuid>` shape
 *      mintRunId() produces (i.e. a fresh mint was actually used)
 */
// Env vars are read at module scope by task-runner-resolver.ts
// (AGENT_EVENT_BUS_NAME), so they must be set before that module is
// imported below.
process.env.AGENT_EVENT_BUS_NAME = "test-event-bus";

import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

jest.mock("uuid", () => ({ v4: jest.fn().mockReturnValue("msg-uuid-123") }));
jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));
jest.mock("../../utils/idempotency", () => ({
  IdempotencyGuard: jest.fn().mockImplementation(() => ({
    withIdempotency: jest.fn(
      async (_key: string, fn: () => Promise<unknown>) => {
        const result = await fn();
        return { executed: true, result };
      },
    ),
  })),
}));

import { handler as submitTaskHandler } from "../task-runner-resolver";
import { handler as executionHandler } from "../execution-resolver";
import { handler as conversationHandler } from "../conversation-resolver";
import { handler as appInvokeHandler } from "../app-invoke-handler";

const RUN_ID_SHAPE = /^run-[0-9a-f-]{36}$/i;
const ATTACKER_RUN_ID = "run-attacker-planted-0000";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("runId client-strip — submitTask (task-runner-resolver)", () => {
  test("ignores a client-supplied runId planted anywhere in the input and mints a fresh one", async () => {
    ebMock.on(PutEventsCommand).resolves({});

    await submitTaskHandler({
      info: { fieldName: "submitTask" },
      arguments: {
        input: {
          taskDetails: "do work",
          // SubmitTaskInput has no runId field — an attacker can only ever
          // smuggle this via a wider/loosely-typed payload; simulate that
          // with a cast.
          runId: ATTACKER_RUN_ID,
        } as unknown as { taskDetails: string },
      },
    });

    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.runId).not.toBe(ATTACKER_RUN_ID);
    expect(detail.runId).toMatch(RUN_ID_SHAPE);
  });
});

describe("runId client-strip — startExecution (execution-resolver)", () => {
  test("ignores a client-supplied runId planted in startExecution arguments and mints a fresh one", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        workflowId: "wf-1",
        orgId: "org-1",
        status: "PUBLISHED",
        version: 1,
        definition: JSON.stringify({
          nodes: [{ id: "n1", agentId: "agent-1" }],
        }),
      },
    });
    ddbMock.on(PutCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({});

    await executionHandler({
      info: { fieldName: "startExecution" },
      arguments: {
        workflowId: "wf-1",
        // ExecutionResolver's startExecution arguments have no runId field
        // in the schema — simulate a caller smuggling one via a wider
        // payload with a cast.
        runId: ATTACKER_RUN_ID,
      } as unknown as Record<string, unknown>,
      identity: { sub: "user-123", claims: { sub: "user-123" } },
    } as unknown as Parameters<typeof executionHandler>[0]);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const execItem = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(execItem.runId).not.toBe(ATTACKER_RUN_ID);
    expect(execItem.runId).toMatch(RUN_ID_SHAPE);
  });
});

describe("runId client-strip — chat message (conversation-resolver sendMessage)", () => {
  beforeEach(() => {
    process.env.CONVERSATIONS_TABLE = "test-conversations";
    process.env.EVENT_BUS_NAME = "test-event-bus";
  });

  afterEach(() => {
    delete process.env.CONVERSATIONS_TABLE;
    delete process.env.EVENT_BUS_NAME;
  });

  test("ignores a client-supplied runId planted in the message input and mints a fresh one", async () => {
    ddbMock.on(PutCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({});

    await conversationHandler({
      info: { fieldName: "sendMessage" },
      arguments: {
        projectId: "proj-1",
        message: {
          agentId: "agent-1",
          message: "hello",
          messageType: "USER_INPUT",
          // ConversationMessageInput has no runId field — simulate a
          // wider/loosely-typed payload smuggling one via a cast.
          runId: ATTACKER_RUN_ID,
        } as unknown as {
          agentId: string;
          message: string;
          messageType: string;
        },
      },
      identity: { sub: "user-123", username: "testuser" },
    } as unknown as Parameters<typeof conversationHandler>[0]);

    const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    expect(putItem.runId).not.toBe(ATTACKER_RUN_ID);
    expect(putItem.runId).toMatch(RUN_ID_SHAPE);

    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.runId).not.toBe(ATTACKER_RUN_ID);
    expect(detail.runId).toMatch(RUN_ID_SHAPE);
  });
});

describe("runId client-strip — app-invoke (processAppInvoke)", () => {
  const APP_ID = "app-strip-test";
  const WORKFLOW_ID = "wf-strip-test";
  const ORG_ID = "org-strip-test";

  test("strips an inbound detail.runId (untrusted app-boundary field) and mints a fresh one", async () => {
    ddbMock.on(QueryCommand).callsFake((input: { IndexName?: string }) => {
      if (input.IndexName === "GroupIndex") {
        return Promise.resolve({
          Items: [
            {
              appId: APP_ID,
              groupId: `APP#${APP_ID}`,
              sortId: "METADATA",
              name: "Strip Test App",
              status: "PUBLISHED",
              workflowIds: [WORKFLOW_ID],
              orgId: ORG_ID,
            },
          ],
        });
      }
      return Promise.resolve({ Items: [] });
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        workflowId: WORKFLOW_ID,
        orgId: ORG_ID,
        status: "PUBLISHED",
        version: 1,
        definition: JSON.stringify({
          nodes: [{ id: "n1", agentId: "agent-1" }],
        }),
      },
    });
    ddbMock.on(PutCommand).resolves({});
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "e1" }] });

    await appInvokeHandler({
      id: "evt-strip-1",
      version: "0",
      account: "123456789012",
      time: "2024-01-01T00:00:00Z",
      region: "us-east-1",
      source: "citadel.app.invoke",
      "detail-type": "app.invoke.requested",
      resources: [APP_ID],
      detail: {
        workflowId: WORKFLOW_ID,
        input: {},
        // Untrusted app-boundary field: any inbound runId must be
        // stripped/ignored (Pass 1, decision f1cbd5ef).
        runId: ATTACKER_RUN_ID,
      },
    } as unknown as Parameters<typeof appInvokeHandler>[0]);

    const execItem = ddbMock.commandCalls(PutCommand)[0].args[0].input
      .Item as Record<string, unknown>;
    expect(execItem.runId).not.toBe(ATTACKER_RUN_ID);
    expect(execItem.runId).toMatch(RUN_ID_SHAPE);

    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.runId).not.toBe(ATTACKER_RUN_ID);
    expect(detail.runId).toMatch(RUN_ID_SHAPE);
  });
});
