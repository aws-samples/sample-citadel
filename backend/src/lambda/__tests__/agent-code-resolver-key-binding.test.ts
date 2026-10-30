/**
 * Tests for agent-code-resolver S3 key binding (finding C10).
 *
 * Validates that:
 * - Traversal filenames are refused with an opaque error.
 * - Sibling-record keys cannot be addressed.
 * - Basename-only filenames are accepted.
 * - Legacy fallback works for reads when scoped key is absent.
 * - Writes always go to the scoped key.
 * - CloudWatch metric is emitted on rejection.
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  AgentRegistryControlClient,
  GetRegistryRecordCommand,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const registryMock = mockClient(AgentRegistryControlClient);

import { handler } from "../agent-code-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

const ORG_ID = "org-a";
const READER_IDENTITY = { sub: "reader-1", "custom:organization": ORG_ID };
const WRITER_IDENTITY = {
  sub: "writer-1",
  "custom:organization": ORG_ID,
  "cognito:groups": ["architect"],
};

function mockAuthorizedAgent(agentId: string): void {
  registryMock.on(GetRegistryRecordCommand).resolves({
    recordId: agentId,
    name: agentId,
    status: "APPROVED",
    descriptors: {
      custom: {
        data: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
          manifest: { note: "marks record type=agent" },
          orgId: ORG_ID,
        }),
      },
    },
  });
}

function s3Body(content: string) {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return sdkStreamMixin(stream);
}

const makeEvent = (
  fieldName: string,
  args: Record<string, unknown>,
  identity: Record<string, unknown>,
): HandlerEvent =>
  ({
    info: { fieldName },
    arguments: args,
    identity,
  }) as unknown as HandlerEvent;

describe("agent-code-resolver key binding (C10)", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    registryMock.reset();
    process.env.AGENT_BUCKET_NAME = "test-bucket";
    process.env.AGENT_CONFIG_TABLE = "test-agent-config";
    process.env.REGISTRY_ID = "test-registry-id";
  });

  afterEach(() => {
    delete process.env.AGENT_BUCKET_NAME;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.REGISTRY_ID;
  });

  // -------------------------------------------------------------------------
  // Traversal filenames refused
  // -------------------------------------------------------------------------

  describe("traversal filenames refused", () => {
    const traversalFilenames = [
      "../../etc/passwd",
      "../tools/secret.py",
      "%2e%2e/tools/secret.py",
      "/etc/passwd",
      "foo//bar.py",
      "agent\x00.py",
    ];

    it.each(traversalFilenames)(
      "getAgentCode rejects filename %j with opaque error",
      async (filename) => {
        mockAuthorizedAgent("a1");
        dynamoMock
          .on(GetCommand)
          .resolves({ Item: { agentId: "a1", config: { filename } } });

        await expect(
          handler(
            makeEvent("getAgentCode", { agentId: "a1" }, READER_IDENTITY),
          ),
        ).rejects.toThrow("Access denied");

        // No S3 calls should have been made
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
      },
    );

    it.each(traversalFilenames)(
      "updateAgentCode rejects filename %j with opaque error",
      async (filename) => {
        mockAuthorizedAgent("a1");
        dynamoMock
          .on(GetCommand)
          .resolves({ Item: { agentId: "a1", config: { filename } } });

        await expect(
          handler(
            makeEvent(
              "updateAgentCode",
              { input: { agentId: "a1", code: "x" } },
              WRITER_IDENTITY,
            ),
          ),
        ).rejects.toThrow("Access denied");

        // No S3 write should have been made
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Sibling-record keys refused
  // -------------------------------------------------------------------------

  describe("sibling-record keys refused", () => {
    test("a config filename pointing at another record's prefix is stripped to basename", async () => {
      // config.filename = "other-agent-id/stolen.py" — the basename "stolen.py"
      // is extracted and scoped under the calling agent's own prefix.
      mockAuthorizedAgent("agent-a");
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "agent-a",
          config: { filename: "other-agent-id/stolen.py" },
        },
      });

      s3Mock.on(GetObjectCommand).resolves({
        Body: s3Body("# agent-a's code"),
        VersionId: "v1",
      });

      await handler(
        makeEvent("getAgentCode", { agentId: "agent-a" }, READER_IDENTITY),
      );

      // The key must be scoped to agent-a, NOT other-agent-id
      const getCalls = s3Mock.commandCalls(GetObjectCommand);
      expect(getCalls[0].args[0].input.Key).toBe("agents/agent-a/stolen.py");
    });

    test("updateAgentCode writes to own prefix even with sibling-scoped filename", async () => {
      mockAuthorizedAgent("agent-a");
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "agent-a",
          config: { filename: "other-agent-id/stolen.py" },
        },
      });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: "v2" });

      await handler(
        makeEvent(
          "updateAgentCode",
          { input: { agentId: "agent-a", code: "# safe" } },
          WRITER_IDENTITY,
        ),
      );

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls[0].args[0].input.Key).toBe("agents/agent-a/stolen.py");
    });
  });

  // -------------------------------------------------------------------------
  // Basename-only accepted
  // -------------------------------------------------------------------------

  describe("basename-only accepted", () => {
    test("simple Python filename resolves to scoped key", async () => {
      mockAuthorizedAgent("a1");
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "a1", config: { filename: "my_agent.py" } },
      });

      s3Mock.on(GetObjectCommand).resolves({
        Body: s3Body("# code"),
        VersionId: "v1",
      });

      await handler(
        makeEvent("getAgentCode", { agentId: "a1" }, READER_IDENTITY),
      );

      const getCalls = s3Mock.commandCalls(GetObjectCommand);
      expect(getCalls[0].args[0].input.Key).toBe("agents/a1/my_agent.py");
    });

    test("undefined filename defaults to {agentId}.py scoped key", async () => {
      mockAuthorizedAgent("a1");
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "a1", config: {} },
      });

      s3Mock.on(GetObjectCommand).resolves({
        Body: s3Body("# code"),
        VersionId: "v1",
      });

      await handler(
        makeEvent("getAgentCode", { agentId: "a1" }, READER_IDENTITY),
      );

      const getCalls = s3Mock.commandCalls(GetObjectCommand);
      expect(getCalls[0].args[0].input.Key).toBe("agents/a1/a1.py");
    });
  });

  // -------------------------------------------------------------------------
  // Legacy fallback behaviour
  // -------------------------------------------------------------------------

  describe("legacy fallback", () => {
    test("getAgentCode falls back to legacy flat key when scoped key is absent", async () => {
      mockAuthorizedAgent("seeded-agent");
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "seeded-agent",
          config: { filename: "demo_echo_agent.py" },
        },
      });

      const noSuchKeyError = new Error("NoSuchKey");
      noSuchKeyError.name = "NoSuchKey";

      s3Mock
        .on(GetObjectCommand, {
          Key: "agents/seeded-agent/demo_echo_agent.py",
        })
        .rejects(noSuchKeyError)
        .on(GetObjectCommand, { Key: "agents/demo_echo_agent.py" })
        .resolves({
          Body: s3Body("# seeded code"),
          VersionId: "v-legacy",
        });

      const result = (await handler(
        makeEvent("getAgentCode", { agentId: "seeded-agent" }, READER_IDENTITY),
      )) as { code: string; version: string };

      expect(result.code).toBe("# seeded code");
      expect(result.version).toBe("v-legacy");
    });

    test("updateAgentCode always writes to scoped key (never legacy)", async () => {
      mockAuthorizedAgent("seeded-agent");
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "seeded-agent",
          config: { filename: "demo_echo_agent.py" },
        },
      });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: "v2" });

      await handler(
        makeEvent(
          "updateAgentCode",
          { input: { agentId: "seeded-agent", code: "# updated" } },
          WRITER_IDENTITY,
        ),
      );

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Key).toBe(
        "agents/seeded-agent/demo_echo_agent.py",
      );
    });

    test("returns default template when both scoped and legacy keys are missing", async () => {
      mockAuthorizedAgent("brand-new");
      dynamoMock.on(GetCommand).resolves({});

      const noSuchKeyError = new Error("NoSuchKey");
      noSuchKeyError.name = "NoSuchKey";
      s3Mock.on(GetObjectCommand).rejects(noSuchKeyError);

      const result = (await handler(
        makeEvent("getAgentCode", { agentId: "brand-new" }, READER_IDENTITY),
      )) as { code: string; version: null };

      expect(result.code).toContain("def handler");
      expect(result.version).toBeNull();

      // Should have tried scoped then legacy
      const getCalls = s3Mock.commandCalls(GetObjectCommand);
      expect(getCalls).toHaveLength(2);
      expect(getCalls[0].args[0].input.Key).toBe(
        "agents/brand-new/brand-new.py",
      );
      expect(getCalls[1].args[0].input.Key).toBe("agents/brand-new.py");
    });
  });

  // -------------------------------------------------------------------------
  // Metric emission
  // -------------------------------------------------------------------------

  describe("metric emission", () => {
    test("emits CloudWatch EMF metric on key rejection", async () => {
      mockAuthorizedAgent("a1");
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "a1", config: { filename: "../../etc/passwd" } },
      });

      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      try {
        await expect(
          handler(
            makeEvent("getAgentCode", { agentId: "a1" }, READER_IDENTITY),
          ),
        ).rejects.toThrow("Access denied");

        // Find the EMF metric log
        const emfCall = logSpy.mock.calls.find(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("AgentCodeKey") &&
            call[0].includes("Refused"),
        );
        expect(emfCall).toBeDefined();
        const parsed = JSON.parse(emfCall![0] as string);
        expect(parsed.Site).toBe("getAgentCode");
        expect(parsed.Refused).toBe(1);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
