/**
 * replay-package-handler.test.ts — HTTP handler for the replay-package
 * routes (CIT-026 design §2/§4). Ownership-gated (reuses
 * resolveExecutionOwnership from trace-http-shared.ts); on a gate hit,
 * asserts a 5xx AND that s3:PutObject was NEVER called (fail-closed,
 * invariant 1). Presigned URL TTL <= 5 minutes.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest
    .fn()
    .mockResolvedValue("https://example-bucket.s3.amazonaws.com/signed-url"),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as replayPackageBuilder from "../utils/replay-package-builder";
import { ReplaySecretLeakError } from "../utils/replay-sanitize";

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  process.env.EXECUTIONS_TABLE = "executions-test";
  process.env.CONVERSATIONS_TABLE = "conversations-test";
  process.env.PROJECTS_TABLE = "projects-test";
  process.env.WORKFLOWS_TABLE = "workflows-test";
  process.env.AGENT_CONFIG_TABLE = "agent-config-test";
  process.env.EXECUTION_SPECS_TABLE = "execspec-test";
  process.env.MODEL_CONFIG_TABLE = "model-config-test";
  process.env.GOVERNANCE_LEDGER_TABLE = "governance-ledger-test";
  process.env.COST_LEDGER_TABLE = "cost-ledger-test";
  process.env.REPLAY_BUCKET = "replay-bucket-test";
  process.env.REPLAY_PRESIGN_TTL_SECONDS = "300";
  process.env.ENVIRONMENT = "test";
});

import { handler } from "../replay-package-handler";

function makeEvent(
  routeKey: string,
  pathParameters: Record<string, string>,
  claims: Record<string, unknown>,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    routeKey,
    pathParameters,
    queryStringParameters: {},
    requestContext: { authorizer: { jwt: { claims, scopes: null } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function executionItem(orgId: string) {
  return {
    executionId: "exec-1",
    orgId,
    workflowId: "wf-1",
    status: "completed",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:05:00.000Z",
    nodeResults: {},
  };
}

describe("GET /replay/by-execution/{executionId} — ownership gate", () => {
  test("same-org non-admin -> 200 with a presigned url, s3:PutObject IS called", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: executionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const event = makeEvent(
      "GET /replay/by-execution/{executionId}",
      { executionId: "exec-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.url).toBeDefined();
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  test("cross-org non-admin -> 404, s3:PutObject is NEVER called", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: executionItem("org-OTHER"),
    });

    const event = makeEvent(
      "GET /replay/by-execution/{executionId}",
      { executionId: "exec-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("unknown execution -> 404", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent(
      "GET /replay/by-execution/{executionId}",
      { executionId: "does-not-exist" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("missing org claim -> 403, s3:PutObject never called", async () => {
    const event = makeEvent(
      "GET /replay/by-execution/{executionId}",
      { executionId: "exec-1" },
      {},
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe("fail-closed gate: secret leak -> 5xx, no S3 write, no URL", () => {
  test("a bundle carrying an unredacted secret pattern refuses to publish", async () => {
    // sanitizeBundle inside assembleReplayPackage will actually redact
    // real secret classes, so to exercise the gate's fail-closed HTTP
    // behavior we spy on the real builder module's export and force it to
    // reject with ReplaySecretLeakError, simulating a genuine leak that
    // survived sanitisation. jest.spyOn (vs. jest.doMock) never touches
    // the module registry, so aws-sdk-client-mock's bindings to
    // DynamoDBDocumentClient/S3Client stay intact for every other test in
    // this file.
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue(new ReplaySecretLeakError(["github-token"]));

    try {
      const event = makeEvent(
        "GET /replay/by-execution/{executionId}",
        { executionId: "exec-1" },
        { "custom:organization": "org-1" },
      );
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
        Item: executionItem("org-1"),
      });

      const res = await handler(event);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      const body = JSON.parse(res.body!);
      expect(body.error).toBeDefined();
      // Pattern IDs may be surfaced (log-safe), but never a raw secret value.
      expect(JSON.stringify(body)).not.toContain("ghp_");
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("presigned URL TTL", () => {
  test("getSignedUrl is called with expiresIn <= 300 seconds", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
      Item: executionItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const event = makeEvent(
      "GET /replay/by-execution/{executionId}",
      { executionId: "exec-1" },
      { "custom:organization": "org-1" },
    );
    await handler(event);

    expect(getSignedUrlMock).toHaveBeenCalled();
    const callArgs = getSignedUrlMock.mock.calls[0];
    const command = callArgs[1];
    const options = callArgs[2];
    // Regression guard for the presign-wrong-operation bug: the client only
    // ever downloads the sanitized package, so the presigned URL MUST sign
    // a GetObjectCommand, never a PutObjectCommand (a PUT-signed URL both
    // breaks the browser's GET download and hands the client a write path
    // that could overwrite the gate-sanitized artifact).
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(options.expiresIn).toBeLessThanOrEqual(300);
  });
});

describe("GET /replay/by-conversation/{conversationId}", () => {
  function projectItem(orgId: string) {
    return {
      id: "conv-1",
      orgId,
      updatedAt: "2026-07-01T00:05:00.000Z",
    };
  }

  test("unresolvable conversation -> 404, no S3 write", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent(
      "GET /replay/by-conversation/{conversationId}",
      { conversationId: "conv-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("same-org conversation -> 200 with a presigned url (ReplayNotFoundError gap closed)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "projects-test" }).resolves({
      Item: projectItem("org-1"),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const event = makeEvent(
      "GET /replay/by-conversation/{conversationId}",
      { conversationId: "conv-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.url).toBeDefined();
    expect(body.query.kind).toBe("conversation");
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  test("ownership refusal happens BEFORE any read/write: cross-org conversation -> 404, zero table reads beyond the ownership GetItem, zero S3 calls", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: "projects-test" }).resolves({
      Item: projectItem("org-OTHER"),
    });

    const event = makeEvent(
      "GET /replay/by-conversation/{conversationId}",
      { conversationId: "conv-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    // Only the ownership GetItem against projects-test happened — no
    // Query against conversations-test/cost-ledger-test was ever issued,
    // proving ownership resolution gates the build entirely.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test("fail-closed gate applies identically on the conversation path: gate refusal -> 5xx, no S3 write, no URL", async () => {
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue(new ReplaySecretLeakError(["jwt"]));

    try {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(GetCommand, { TableName: "projects-test" }).resolves({
        Item: projectItem("org-1"),
      });

      const event = makeEvent(
        "GET /replay/by-conversation/{conversationId}",
        { conversationId: "conv-1" },
        { "custom:organization": "org-1" },
      );

      const res = await handler(event);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("unknown route", () => {
  test("returns 404", async () => {
    const event = makeEvent(
      "GET /replay/unknown-shape",
      {},
      { "custom:organization": "org-1" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });
});
