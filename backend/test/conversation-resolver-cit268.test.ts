/**
 * CIT-268: conversation-resolver — clientMessageId dedup +
 * TURN_ACCEPTED publish ordering.
 *
 * Exercises the sendMessage handler at the Lambda boundary with mocked
 * AWS SDK clients so we can assert:
 *   1. Duplicate sends (same projectId + clientMessageId) return the
 *      existing message and emit NO second EventBridge event.
 *   2. TURN_ACCEPTED is published (via AppSync fetch) BEFORE the
 *      EventBridge PutEvents call.
 *   3. Without clientMessageId, every call writes a new row.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Track call order for ordering assertions ────────────────────────
const callOrder: string[] = [];

// ── Mock send function shared across DDB + EB ───────────────────────
const mockDdbSend = jest.fn<(cmd: any) => Promise<any>>();
const mockEbSend = jest.fn<(cmd: any) => Promise<any>>();

// ── Mock fetch for TURN_ACCEPTED publish ────────────────────────────
const mockFetch = jest.fn<typeof fetch>();

// ── Module mocks ────────────────────────────────────────────────────

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@aws-sdk/lib-dynamodb", () => {
  class MockPutCommand {
    _type = "Put";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  class MockQueryCommand {
    _type = "Query";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: mockDdbSend }) },
    PutCommand: MockPutCommand,
    QueryCommand: MockQueryCommand,
  };
});

jest.mock("@aws-sdk/client-eventbridge", () => {
  class MockPutEventsCommand {
    _type = "PutEvents";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  return {
    EventBridgeClient: jest.fn().mockImplementation(() => ({
      send: mockEbSend,
    })),
    PutEventsCommand: MockPutEventsCommand,
  };
});

jest.mock("@aws-sdk/signature-v4", () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({
    sign: jest.fn().mockResolvedValue({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  })),
}));

jest.mock("@aws-crypto/sha256-js", () => ({ Sha256: jest.fn() }));
jest.mock("@smithy/protocol-http", () => ({
  HttpRequest: jest.fn().mockImplementation((p: any) => p),
}));
jest.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: jest.fn().mockReturnValue(jest.fn()),
}));

jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("msg-uuid-001"),
}));

jest.mock("../src/utils/run-id", () => ({
  mintRunId: jest.fn().mockReturnValue("run-fixed"),
  buildDispatchContext: jest.fn().mockImplementation((p: any) => p),
}));

jest.mock("../src/utils/project-access", () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
}));

// Set env vars before import.
process.env.CONVERSATIONS_TABLE = "citadel-conversations-test";
process.env.EVENT_BUS_NAME = "citadel-agent-bus-test";
process.env.APPSYNC_ENDPOINT = "https://appsync.example.com/graphql";

import { handler } from "../src/lambda/conversation-resolver";

// ── Helpers ──────────────────────────────────────────────────────────

function makeEvent(messageOverrides: Record<string, any> = {}): any {
  return {
    arguments: {
      projectId: "proj-1",
      message: {
        agentId: "agent1",
        message: "hello",
        messageType: "USER_INPUT",
        ...messageOverrides,
      },
    },
    identity: { sub: "user-1" },
    info: { fieldName: "sendMessage" },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("CIT-268: sendMessage dedupe + TURN_ACCEPTED", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    callOrder.length = 0;
    // Default: DDB returns no items, EB succeeds.
    mockDdbSend.mockResolvedValue({ Items: [] });
    mockEbSend.mockResolvedValue({});
    // fetch succeeds (TURN_ACCEPTED publish).
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    } as any);
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    // @ts-expect-error — cleanup
    delete global.fetch;
  });

  // ── Dedup ────────────────────────────────────────────────────────

  it("returns existing message when clientMessageId already exists", async () => {
    const existingMsg = {
      id: "existing-id",
      projectId: "proj-1",
      agentId: "agent1",
      message: "hello",
      messageType: "USER_INPUT",
      timestamp: "2026-01-01T00:00:00.000Z",
      clientMessageId: "client-msg-1",
    };

    // Query for dedup → returns existing
    mockDdbSend.mockResolvedValueOnce({ Items: [existingMsg] });

    const event = makeEvent({ clientMessageId: "client-msg-1" });
    const result = await handler(event);

    expect(result).toEqual(existingMsg);
    // Only a Query was issued (dedup lookup), no Put.
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend.mock.calls[0][0]).toHaveProperty("_type", "Query");
    // No EventBridge event.
    expect(mockEbSend).not.toHaveBeenCalled();
    // No TURN_ACCEPTED publish.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stores and dispatches when clientMessageId is new", async () => {
    // Query returns empty, Put succeeds.
    mockDdbSend
      .mockResolvedValueOnce({ Items: [] }) // Query (dedup)
      .mockResolvedValueOnce({}); // Put (store)

    const event = makeEvent({ clientMessageId: "client-msg-new" });
    const result = await handler(event);

    expect(result).toHaveProperty("id", "msg-uuid-001");
    expect(result).toHaveProperty("clientMessageId", "client-msg-new");
    // Query + Put.
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    expect(mockDdbSend.mock.calls[0][0]).toHaveProperty("_type", "Query");
    expect(mockDdbSend.mock.calls[1][0]).toHaveProperty("_type", "Put");
    // EventBridge dispatch.
    expect(mockEbSend).toHaveBeenCalledTimes(1);
  });

  it("stores normally without clientMessageId (no dedup query)", async () => {
    mockDdbSend.mockResolvedValueOnce({}); // Put

    const event = makeEvent(); // no clientMessageId
    const result = await handler(event);

    expect(result).toHaveProperty("id", "msg-uuid-001");
    // Only Put, no Query.
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend.mock.calls[0][0]).toHaveProperty("_type", "Put");
  });

  // ── TURN_ACCEPTED ordering ──────────────────────────────────────

  it("publishes TURN_ACCEPTED before EventBridge dispatch", async () => {
    mockDdbSend.mockImplementation(async (cmd: any) => {
      if (cmd._type === "Put") {
        callOrder.push("ddb-put");
        return {};
      }
      return { Items: [] };
    });

    mockEbSend.mockImplementation(async () => {
      callOrder.push("eventbridge");
      return {};
    });

    mockFetch.mockImplementation(async () => {
      callOrder.push("turn-accepted-publish");
      return { ok: true, json: async () => ({ data: {} }) } as any;
    });

    const event = makeEvent();
    await handler(event);

    expect(callOrder).toEqual([
      "ddb-put",
      "turn-accepted-publish",
      "eventbridge",
    ]);
  });

  it("TURN_ACCEPTED publish failure does not block the mutation", async () => {
    mockDdbSend.mockResolvedValueOnce({}); // Put

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ errors: [{ message: "AppSync down" }] }),
    } as any);

    const event = makeEvent();
    const result = await handler(event);

    // Mutation still succeeds.
    expect(result).toHaveProperty("id", "msg-uuid-001");
    // EventBridge still fires.
    expect(mockEbSend).toHaveBeenCalledTimes(1);
  });

  // ── Schema additions ───────────────────────────────────────────

  it("TURN_ACCEPTED is a valid MessageType in the GraphQL schema", () => {
    // Read schema and verify the enum includes TURN_ACCEPTED.
    const fs = jest.requireActual<typeof import("fs")>("fs");
    const pathMod = jest.requireActual<typeof import("path")>("path");
    const schema = fs.readFileSync(
      pathMod.resolve(__dirname, "../src/schema/schema.graphql"),
      "utf8",
    );
    expect(schema).toContain("TURN_ACCEPTED");
    // Also verify clientMessageId on ConversationMessageInput.
    expect(schema).toMatch(
      /input ConversationMessageInput[\s\S]*?clientMessageId/,
    );
    // And on ConversationMessage type.
    expect(schema).toMatch(/type ConversationMessage[\s\S]*?clientMessageId/);
  });
});
