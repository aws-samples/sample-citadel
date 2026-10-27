/**
 * Tests for the project organisation → session attribute pipeline.
 *
 * Validates that agent-message-handler:
 *  1. Reads the project record to derive `org` SERVER-SIDE.
 *  2. Passes `org` (and `userId`) in `sessionAttributes` of the AgentCore payload.
 *  3. When the project has no organisation, does NOT invoke the agent and
 *     publishes a clear error message to the conversation.
 */

jest.mock("../../utils/idempotency", () => ({
  IdempotencyGuard: jest.fn().mockImplementation(() => ({
    withIdempotency: jest.fn(async (_key: string, fn: () => Promise<void>) => {
      await fn();
      return { executed: true };
    }),
  })),
}));

jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn((params: unknown) => params),
}));

jest.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeAgentRuntimeCommand: jest.fn((params: unknown) => params),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock("@aws-sdk/lib-dynamodb", () => {
  const send = jest.fn(async () => ({}));
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send })) },
    PutCommand: jest.fn((params: unknown) => params),
    GetCommand: jest.fn((params: unknown) => params),
    __docSend: send,
  };
});

jest.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: jest.fn(() =>
    jest.fn(async () => ({
      accessKeyId: "AK",
      secretAccessKey: "SK",
    })),
  ),
}));

jest.mock("@aws-sdk/signature-v4", () => ({
  SignatureV4: jest.fn(() => ({
    sign: jest.fn(
      async (req: {
        method: string;
        headers: Record<string, string>;
        body: string;
      }) => req,
    ),
  })),
}));

process.env.CONVERSATIONS_TABLE = "conversations-test";
process.env.APPSYNC_ENDPOINT = "https://appsync.invalid/graphql";
process.env.IDEMPOTENCY_TABLE = "idempotency-test";
process.env.PROJECTS_TABLE = "projects-test";
process.env.ENVIRONMENT = "test";
delete process.env.IMPORT_ENABLED;

type Handler = typeof import("../agent-message-handler").handler;
type LookupFn =
  typeof import("../agent-message-handler").lookupProjectOrganization;
let handler: Handler;
let lookupProjectOrganization: LookupFn;
let resetCaches: () => void;

const ssmModule = jest.requireMock("@aws-sdk/client-ssm") as {
  SSMClient: jest.Mock;
};
const agentCoreModule = jest.requireMock(
  "@aws-sdk/client-bedrock-agentcore",
) as {
  BedrockAgentCoreClient: jest.Mock;
  InvokeAgentRuntimeCommand: jest.Mock;
};
const libDynamo = jest.requireMock("@aws-sdk/lib-dynamodb") as {
  __docSend: jest.Mock;
  GetCommand: jest.Mock;
  PutCommand: jest.Mock;
};

function makeStream(chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  })();
}

/** Fixture matching the LIVE projects table row shape. */
const PROJECT_ROW = {
  id: "proj-org-1",
  name: "My AI Project",
  organization: "acme-corp",
  owner: "user-1",
  status: "ACTIVE",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const makeEvent = (
  overrides?: Partial<{ projectId: string; agentId: string }>,
) =>
  ({
    id: "evt-org-1",
    detail: {
      projectId: overrides?.projectId ?? "proj-org-1",
      agentId: overrides?.agentId ?? "agent_intake_single",
      message: "Hello agent",
      messageId: "msg-org-1",
      userId: "user-1",
      timestamp: new Date().toISOString(),
    },
  }) as unknown as Parameters<Handler>[0];

describe("agent-message-handler — org session attribute", () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let fetchMock: jest.Mock;
  let agentCoreSend: jest.Mock;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sut = require("../agent-message-handler");
    handler = sut.handler;
    lookupProjectOrganization = sut.lookupProjectOrganization;
    resetCaches = sut._resetCaches;
  });

  beforeEach(() => {
    resetCaches();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // SSM: return a valid agent config
    const ssmSend = (
      ssmModule.SSMClient.mock.results[0]?.value as { send: jest.Mock }
    ).send;
    ssmSend.mockReset();
    ssmSend.mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({
          agentRuntimeArn: "arn:aws:bedrock:us-west-2:123:agent/intake",
        }),
      },
    });

    // DynamoDB: route Get (project lookup) and Put (store response) correctly
    libDynamo.__docSend.mockReset();
    libDynamo.__docSend.mockImplementation(async (cmd: unknown) => {
      // GetCommand → return project row
      const c = cmd as {
        TableName?: string;
        Key?: { id: string };
        ProjectionExpression?: string;
      };
      if (c.ProjectionExpression === "organization") {
        return { Item: { organization: PROJECT_ROW.organization } };
      }
      // PutCommand → succeed
      return {};
    });

    // AgentCore: streaming response
    agentCoreSend = jest.fn(async () => ({
      $metadata: { httpStatusCode: 200, requestId: "req-org-1" },
      contentType: "text/event-stream",
      response: makeStream(['data: "OK"\n']),
    }));
    agentCoreModule.BedrockAgentCoreClient.mockImplementation(() => ({
      send: agentCoreSend,
    }));

    fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: {} }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // ── Happy path: org is carried in sessionAttributes ───────────────────
  test("payload carries org from the project record", async () => {
    await handler(makeEvent());

    // InvokeAgentRuntimeCommand should have been called
    expect(agentCoreModule.InvokeAgentRuntimeCommand).toHaveBeenCalled();
    const invokeArgs =
      agentCoreModule.InvokeAgentRuntimeCommand.mock.calls[0][0];
    const payload = JSON.parse(invokeArgs.payload);

    expect(payload.sessionAttributes).toBeDefined();
    expect(payload.sessionAttributes.org).toBe("acme-corp");
    expect(payload.sessionAttributes.userId).toBe("user-1");
    expect(payload.sessionAttributes.projectId).toBe("proj-org-1");
  });

  // ── Missing org: no invoke + error published ──────────────────────────
  test("missing org does not invoke agent and publishes error", async () => {
    // Project has no organization
    libDynamo.__docSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { ProjectionExpression?: string };
      if (c.ProjectionExpression === "organization") {
        return { Item: { organization: undefined } };
      }
      return {};
    });

    await handler(makeEvent());

    // AgentCore must NOT have been invoked
    expect(agentCoreSend).not.toHaveBeenCalled();

    // An error message must be stored and published
    const putCalls = libDynamo.PutCommand.mock.calls;
    const errorPut = putCalls.find((call: unknown[]) => {
      const item = (call[0] as { Item?: { message?: string } })?.Item;
      return item?.message?.includes("Could not determine your organisation");
    });
    expect(errorPut).toBeDefined();

    // AppSync mutation triggered (fetch called for the error message)
    expect(fetchMock).toHaveBeenCalled();
  });

  test("project not found does not invoke agent", async () => {
    libDynamo.__docSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { ProjectionExpression?: string };
      if (c.ProjectionExpression === "organization") {
        return { Item: undefined };
      }
      return {};
    });

    await handler(makeEvent());

    expect(agentCoreSend).not.toHaveBeenCalled();
  });

  // ── lookupProjectOrganization unit tests ──────────────────────────────
  test("lookupProjectOrganization returns org from project row", async () => {
    libDynamo.__docSend.mockResolvedValueOnce({
      Item: { organization: "my-org" },
    });
    const org = await lookupProjectOrganization("proj-1");
    expect(org).toBe("my-org");
  });

  test("lookupProjectOrganization returns undefined when project has no org", async () => {
    libDynamo.__docSend.mockResolvedValueOnce({
      Item: { organization: "" },
    });
    const org = await lookupProjectOrganization("proj-2");
    expect(org).toBeUndefined();
  });

  test("lookupProjectOrganization returns undefined when project not found", async () => {
    libDynamo.__docSend.mockResolvedValueOnce({ Item: undefined });
    const org = await lookupProjectOrganization("proj-missing");
    expect(org).toBeUndefined();
  });

  test("lookupProjectOrganization rethrows SDK errors instead of swallowing them", async () => {
    libDynamo.__docSend.mockRejectedValueOnce(new Error("DynamoDB timeout"));
    await expect(lookupProjectOrganization("proj-err")).rejects.toThrow(
      "DynamoDB timeout",
    );
  });

  test("SDK error in lookupProjectOrganization surfaces as a handler error, not missing org", async () => {
    // Clear prior PutCommand calls from earlier tests in this describe
    libDynamo.PutCommand.mockClear();

    libDynamo.__docSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { ProjectionExpression?: string };
      if (c.ProjectionExpression === "organization") {
        throw new Error("AccessDeniedException: not authorized");
      }
      return {};
    });

    await handler(makeEvent());

    // AgentCore must NOT have been invoked
    expect(agentCoreSend).not.toHaveBeenCalled();

    // The outer catch stores a generic error message (not the "Could not
    // determine your organisation" one that previously hid the real cause)
    const putCalls = libDynamo.PutCommand.mock.calls;
    const errorPut = putCalls.find((call: unknown[]) => {
      const item = (call[0] as { Item?: { message?: string } })?.Item;
      return item?.message?.includes("encountered an error");
    });
    expect(errorPut).toBeDefined();

    // The "missing org" path must NOT have been taken
    const missingOrgPut = putCalls.find((call: unknown[]) => {
      const item = (call[0] as { Item?: { message?: string } })?.Item;
      return item?.message?.includes("Could not determine your organisation");
    });
    expect(missingOrgPut).toBeUndefined();
  });

  // ── EMF metric on missing org ─────────────────────────────────────────
  test("missing org emits MissingProjectOrg metric", async () => {
    libDynamo.__docSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { ProjectionExpression?: string };
      if (c.ProjectionExpression === "organization") {
        return { Item: {} };
      }
      return {};
    });

    await handler(makeEvent());

    // Check EMF line in logs
    const emfLines = logSpy.mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string")
      .map((c: unknown[]) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((p: Record<string, unknown> | null) => p && p._aws) as Array<
      Record<string, unknown>
    >;

    const missingOrgMetric = emfLines.find(
      (b) => (b.MissingProjectOrg as number) === 1,
    );
    expect(missingOrgMetric).toBeDefined();
  });
});
