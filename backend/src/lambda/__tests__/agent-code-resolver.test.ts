/**
 * Tests for agent-code-resolver Lambda.
 *
 * Authorization is a SEPARATE concern covered exhaustively in
 * agent-code-resolver-authz.test.ts (finding 1a9181a4). These tests focus
 * on the S3/DynamoDB filename-resolution and code-body behavior, so every
 * case here authorizes as a legitimate same-org caller (architect role for
 * updateAgentCode's write) via a mocked Registry record, mirroring the
 * "legitimate caller succeeds" cases in the authz suite.
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BedrockAgentCoreControlClient,
  GetRegistryRecordCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mockClient } from "aws-sdk-client-mock";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const registryMock = mockClient(BedrockAgentCoreControlClient);

import { handler } from "../agent-code-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

/** Result shape of getAgentCode / updateAgentCode. */
interface AgentCodeResult {
  agentId: string;
  code: string;
  version: string | null;
}

/** Invoke the one-parameter handler and cast the result to the expected field shape. */
async function invoke<T = AgentCodeResult>(event: HandlerEvent): Promise<T> {
  return (await handler(event)) as T;
}

const ORG_ID = "org-a";
const READER_IDENTITY = { sub: "reader-1", "custom:organization": ORG_ID };
const WRITER_IDENTITY = {
  sub: "writer-1",
  "custom:organization": ORG_ID,
  "custom:role": "architect",
};

/** Mocks a same-org Registry record for the given agentId so the org/role gate passes. */
function mockAuthorizedAgent(agentId: string): void {
  registryMock.on(GetRegistryRecordCommand).resolves({
    recordId: agentId,
    name: agentId,
    status: "APPROVED",
    descriptors: {
      custom: {
        inlineContent: JSON.stringify({
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

describe("agent-code-resolver", () => {
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

  describe("getAgentCode", () => {
    test("returns code from S3 using filename from config", async () => {
      mockAuthorizedAgent("a1");
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "a1", config: { filename: "my_agent.py" } },
      });

      const stream = new Readable();
      stream.push("def handler(): pass");
      stream.push(null);
      const sdkStream = sdkStreamMixin(stream);

      s3Mock.on(GetObjectCommand).resolves({
        Body: sdkStream,
        VersionId: "v1",
        LastModified: new Date("2025-01-01"),
      });

      const result = await invoke(
        makeEvent("getAgentCode", { agentId: "a1" }, READER_IDENTITY),
      );

      expect(result.agentId).toBe("a1");
      expect(result.code).toBe("def handler(): pass");
      expect(result.version).toBe("v1");
    });

    test("returns default code when S3 key not found", async () => {
      mockAuthorizedAgent("a1");
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "a1", config: { filename: "missing.py" } },
      });

      const noSuchKeyError = new Error("NoSuchKey");
      noSuchKeyError.name = "NoSuchKey";
      s3Mock.on(GetObjectCommand).rejects(noSuchKeyError);

      const result = await invoke(
        makeEvent("getAgentCode", { agentId: "a1" }, READER_IDENTITY),
      );

      expect(result.agentId).toBe("a1");
      expect(result.code).toContain("def handler");
      expect(result.version).toBeNull();
    });

    test("falls back to agentId.py in S3 when no DynamoDB config exists (registry-based agent)", async () => {
      mockAuthorizedAgent("missing");
      dynamoMock.on(GetCommand).resolves({});

      const noSuchKeyError = new Error("NoSuchKey");
      noSuchKeyError.name = "NoSuchKey";
      s3Mock.on(GetObjectCommand).rejects(noSuchKeyError);

      const result = await invoke(
        makeEvent("getAgentCode", { agentId: "missing" }, READER_IDENTITY),
      );

      expect(result.agentId).toBe("missing");
      expect(result.code).toContain("def handler");
      expect(result.version).toBeNull();

      const getCalls = s3Mock.commandCalls(GetObjectCommand);
      expect(getCalls[0].args[0].input.Key).toBe("agents/missing.py");
    });
  });

  describe("updateAgentCode", () => {
    test("writes code to S3", async () => {
      mockAuthorizedAgent("a1");
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "a1", config: { filename: "my_agent.py" } },
      });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: "v2" });

      const result = await invoke(
        makeEvent(
          "updateAgentCode",
          { input: { agentId: "a1", code: 'print("hello")' } },
          WRITER_IDENTITY,
        ),
      );

      expect(result.agentId).toBe("a1");
      expect(result.code).toBe('print("hello")');

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Key).toBe("agents/my_agent.py");
    });

    test("falls back to agentId.py in S3 when no DynamoDB config exists (registry-based agent)", async () => {
      mockAuthorizedAgent("missing");
      dynamoMock.on(GetCommand).resolves({});
      s3Mock.on(PutObjectCommand).resolves({ VersionId: "v3" });

      const result = await invoke(
        makeEvent(
          "updateAgentCode",
          { input: { agentId: "missing", code: "x" } },
          WRITER_IDENTITY,
        ),
      );

      expect(result.agentId).toBe("missing");
      expect(result.code).toBe("x");

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls[0].args[0].input.Key).toBe("agents/missing.py");
    });
  });

  test("throws on unknown field", async () => {
    await expect(
      handler(makeEvent("unknownField", {}, READER_IDENTITY)),
    ).rejects.toThrow("Unknown field");
  });
});
