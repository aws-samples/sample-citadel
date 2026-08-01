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

// ---------------------------------------------------------------------------
// Branch tests for the untested fail-closed refusal paths (finding 6de8908c).
// Every test below asserts BEHAVIOR: status code, refusal payload shape, no
// S3 write, no presigned URL issued — never implementation internals.
// ---------------------------------------------------------------------------

import {
  CrossOrgRowError,
  ReplayNotFoundError,
} from "../utils/replay-package-builder";

/** Same-org execution event whose ownership check passes, so the request
 * reaches handleEntryKeyRoute and the builder outcome drives the branch. */
function ownedExecutionEvent(): APIGatewayProxyEventV2WithJWTAuthorizer {
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(GetCommand, { TableName: "executions-test" }).resolves({
    Item: executionItem("org-1"),
  });
  return makeEvent(
    "GET /replay/by-execution/{executionId}",
    { executionId: "exec-1" },
    { "custom:organization": "org-1" },
  );
}

describe("fail-closed error translation — each builder throw maps to the refusal contract", () => {
  test("ReplayNotFoundError from the builder -> 404, no S3 write, no presigned URL", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue(new ReplayNotFoundError("execution", "exec-1"));

    try {
      const res = await handler(ownedExecutionEvent());
      expect(res.statusCode).toBe(404);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("CrossOrgRowError from the builder -> 403, no S3 write, no presigned URL (defence-in-depth layer)", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue(
        new CrossOrgRowError("workflows-test", "org-OTHER", "org-1"),
      );

    try {
      const res = await handler(ownedExecutionEvent());
      expect(res.statusCode).toBe(403);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(getSignedUrlMock).not.toHaveBeenCalled();
      // Refusal payload never echoes the mismatched org ids.
      expect(res.body ?? "").not.toContain("org-OTHER");
    } finally {
      spy.mockRestore();
    }
  });

  test("unexpected Error from the builder -> 500 generic body, no S3 write, no error-detail leak", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue(new Error("dynamo exploded: table arn secrets"));

    try {
      const res = await handler(ownedExecutionEvent());
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body!);
      expect(body).toEqual({ error: "Internal server error" });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("non-Error thrown value from the builder -> 500 generic body (String(err) arm)", async () => {
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue("string-throw");

    try {
      const res = await handler(ownedExecutionEvent());
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body!)).toEqual({ error: "Internal server error" });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("secret gate refusal surfaces log-safe patternIds in the refusal payload and issues no presigned URL", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();
    const spy = jest
      .spyOn(replayPackageBuilder, "assembleReplayPackage")
      .mockRejectedValue(new ReplaySecretLeakError(["github-token", "jwt"]));

    try {
      const res = await handler(ownedExecutionEvent());
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body!);
      // The refusal payload carries the pattern IDs (log-safe identifiers,
      // never the matched secret text) and no url field at all.
      expect(body.patternIds).toEqual(["github-token", "jwt"]);
      expect(body.error).toMatch(/refused/i);
      expect(body.url).toBeUndefined();
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("S3 PutObject failure — fail closed after build, before presign", () => {
  test("S3 send rejection -> 500 generic body, no presigned URL ever issued", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();

    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(PutObjectCommand).rejects(new Error("s3 unavailable"));

    const res = await handler(ownedExecutionEvent());
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body!);
    expect(body).toEqual({ error: "Internal server error" });
    expect(body.url).toBeUndefined();
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  test("S3 throwing a non-Error value -> 500 generic body (String(err) arm)", async () => {
    const getSignedUrlMock = getSignedUrl as jest.Mock;
    getSignedUrlMock.mockClear();

    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(PutObjectCommand).callsFake(() => {
      return Promise.reject({ notAnError: "s3-plain-object-rejection" });
    });

    const res = await handler(ownedExecutionEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body!)).toEqual({ error: "Internal server error" });
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });
});

describe("presigned TTL clamp — env may only lower the 300s ceiling, never raise it", () => {
  test.each<[string, string | undefined, number]>([
    ["unset", undefined, 300],
    ['"0"', "0", 300],
    ['"-5"', "-5", 300],
    ['"abc"', "abc", 300],
    ['"600"', "600", 300],
    ['"120"', "120", 120],
  ])(
    "REPLAY_PRESIGN_TTL_SECONDS %s -> expiresIn %i",
    async (_label, envValue, expected) => {
      if (envValue === undefined) {
        delete process.env.REPLAY_PRESIGN_TTL_SECONDS;
      } else {
        process.env.REPLAY_PRESIGN_TTL_SECONDS = envValue;
      }
      const getSignedUrlMock = getSignedUrl as jest.Mock;
      getSignedUrlMock.mockClear();

      ddbMock.on(QueryCommand).resolves({ Items: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const res = await handler(ownedExecutionEvent());
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body!);
      expect(body.expiresInSeconds).toBe(expected);
      const options = getSignedUrlMock.mock.calls[0][2];
      expect(options.expiresIn).toBe(expected);
      expect(options.expiresIn).toBeLessThanOrEqual(300);
    },
  );
});

describe("bad request paths — missing path parameters", () => {
  test("missing executionId (pathParameters absent) -> 400, nothing read or written", async () => {
    const event = {
      ...makeEvent(
        "GET /replay/by-execution/{executionId}",
        {},
        { "custom:organization": "org-1" },
      ),
      pathParameters: undefined,
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(ddbMock.calls()).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("missing conversationId (empty pathParameters) -> 400, nothing read or written", async () => {
    const event = makeEvent(
      "GET /replay/by-conversation/{conversationId}",
      {},
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(ddbMock.calls()).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("missing org claim on the conversation route -> 403 before any read", async () => {
    const event = makeEvent(
      "GET /replay/by-conversation/{conversationId}",
      { conversationId: "conv-1" },
      {},
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe("top-level unhandled error -> 500, never a partial success", () => {
  test("ownership resolution rejecting (Error) -> 500 generic body, no S3 write", async () => {
    ddbMock.on(GetCommand).rejects(new Error("dynamo down"));

    const event = makeEvent(
      "GET /replay/by-execution/{executionId}",
      { executionId: "exec-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body!)).toEqual({ error: "Internal server error" });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("ownership resolution throwing a non-Error value -> 500 generic body (String(err) arm)", async () => {
    ddbMock.on(GetCommand).callsFake(() => {
      return Promise.reject({ notAnError: "ddb-plain-object-rejection" });
    });

    const event = makeEvent(
      "GET /replay/by-conversation/{conversationId}",
      { conversationId: "conv-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body!)).toEqual({ error: "Internal server error" });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});
