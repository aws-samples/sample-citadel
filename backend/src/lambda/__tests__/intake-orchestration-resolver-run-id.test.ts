/**
 * Red-first tests for runId carry-through in intake-orchestration-resolver
 * (Pass 1, decision f1cbd5ef; verify-p1 NEEDS_CHANGES item 4 — this file
 * had zero runId references).
 *
 * This resolver is NOT one of the 4 server-mint entry points (chat,
 * submitTask, startExecution/app-invoke, intake turn) — it is a downstream
 * IAM-only boundary invoked by the intake AgentCore runtime AFTER
 * fabrication, well after the chat entry point already minted and stamped
 * a runId on the linked conversation row (conversation-resolver.ts
 * sendMessage). Per the server-minted-only invariant, this resolver must
 * NEVER mint its own runId — it may only CARRY one through, when present,
 * for observability continuity (log correlation) across the intake→app
 * boundary.
 *
 * Scope: `findLinkedProjectId`'s scan already reads the conversations row
 * that `sendMessage` stamps with `runId`; this test asserts that value is
 * additionally projected and surfaced on the structured `log(...)` calls
 * this resolver already emits, via a new `runId` field alongside the
 * existing `correlationId`. Absence (pre-runId row, or a session with no
 * linked conversation) must not throw and must simply omit the field.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

jest.mock("../agent-config-resolver", () => ({
  activateProjectAgents: jest.fn(),
  findProjectAgentRecords: jest.fn(),
}));
jest.mock("../registry-agent-record-resolver", () => ({
  createApp: jest.fn(),
  ensureAppAgentBindings: jest.fn(),
  findAppBySourceProjectId: jest.fn(),
}));
jest.mock("../workflow-resolver", () => ({
  createWorkflow: jest.fn(),
  publishWorkflow: jest.fn(),
  importBlueprint: jest.fn(),
}));
jest.mock("../ensure-agent-config-rows", () => ({
  extractAgentIdsFromDefinition: jest.requireActual(
    "../ensure-agent-config-rows",
  ).extractAgentIdsFromDefinition,
  ensureAgentConfigRows: jest.fn(),
}));

import { activateProjectAgents } from "../agent-config-resolver";
import { handler } from "../intake-orchestration-resolver";

const ddbMock = mockClient(DynamoDBDocumentClient);

const activateMock = activateProjectAgents as jest.MockedFunction<
  typeof activateProjectAgents
>;

type HandlerEvent = Parameters<typeof handler>[0];

const IAM_IDENTITY = {
  accountId: "123456789012",
  userArn: "arn:aws:sts::123456789012:assumed-role/intake-runtime-role/session",
  username: "AROAEXAMPLE:session",
  sourceIp: ["10.0.0.1"],
};

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity: IAM_IDENTITY,
  } as unknown as HandlerEvent;
}

const invoke = handler as (event: HandlerEvent) => Promise<unknown>;

const SESSION_ID = "sess-run-id-1";
const PROJECT_ID = "proj-run-id-1";

describe("intake-orchestration-resolver — runId carry-through", () => {
  beforeAll(() => {
    process.env.PROJECTS_TABLE = "citadel-projects-test";
    process.env.CONVERSATIONS_TABLE = "citadel-conversations-test";
    process.env.APPS_TABLE = "citadel-apps-test";
    process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
  });

  afterAll(() => {
    delete process.env.PROJECTS_TABLE;
    delete process.env.CONVERSATIONS_TABLE;
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
  });

  beforeEach(() => {
    ddbMock.reset();
    activateMock.mockReset();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("surfaces runId in the resolver log when the linked conversation row carries one", async () => {
    ddbMock
      .on(ScanCommand, { TableName: "citadel-conversations-test" })
      .resolves({ Items: [{ projectId: PROJECT_ID, runId: "run-carried-1" }] });
    ddbMock
      .on(GetCommand, { TableName: "citadel-projects-test" })
      .resolves({ Item: { id: PROJECT_ID, organization: "org-1" } });
    activateMock.mockResolvedValue({
      activated: [],
      failed: [],
      alreadyActive: [],
    });

    await invoke(
      makeEvent("intakeActivateProjectAgents", { sessionId: SESSION_ID }),
    );

    const logCalls = (console.log as jest.Mock).mock.calls.map((c) =>
      JSON.parse(c[0]),
    );
    const withRunId = logCalls.find((entry) => entry.runId === "run-carried-1");
    expect(withRunId).toBeDefined();
  });

  it("omits runId from the log without throwing when the conversation row has none", async () => {
    ddbMock
      .on(ScanCommand, { TableName: "citadel-conversations-test" })
      .resolves({ Items: [{ projectId: PROJECT_ID }] });
    ddbMock
      .on(GetCommand, { TableName: "citadel-projects-test" })
      .resolves({ Item: { id: PROJECT_ID, organization: "org-1" } });
    activateMock.mockResolvedValue({
      activated: [],
      failed: [],
      alreadyActive: [],
    });

    await expect(
      invoke(
        makeEvent("intakeActivateProjectAgents", { sessionId: SESSION_ID }),
      ),
    ).resolves.toBeDefined();

    const logCalls = (console.log as jest.Mock).mock.calls.map((c) =>
      JSON.parse(c[0]),
    );
    for (const entry of logCalls) {
      expect(entry.runId).toBeUndefined();
    }
  });

  it("omits runId without throwing when there is no linked conversation row at all", async () => {
    ddbMock
      .on(ScanCommand, { TableName: "citadel-conversations-test" })
      .resolves({ Items: [] });
    ddbMock
      .on(GetCommand, { TableName: "citadel-projects-test" })
      .resolves({ Item: undefined });
    activateMock.mockResolvedValue({
      activated: [],
      failed: [],
      alreadyActive: [],
    });

    await expect(
      invoke(
        makeEvent("intakeActivateProjectAgents", { sessionId: SESSION_ID }),
      ),
    ).resolves.toBeDefined();
  });
});
