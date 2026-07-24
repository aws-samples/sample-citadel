/**
 * Unit tests for app-api-authorizer.ts — Lambda authorizer for per-app API Gateway.
 *
 * Tests API key validation against DynamoDB, audit logging, and async lastUsedAt updates.
 * Uses API Gateway Lambda authorizer v2 format (simple response: isAuthorized boolean).
 *
 * Covers HMAC-SHA-256-with-pepper hashing (current) and the plain-SHA-256
 * dual-read branch (legacy, migration window only).
 *
 * Validates: Requirements 3.2, 3.3, 3.4, 3.8, 3.9
 */
import { createHash } from "crypto";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { handler, AuthorizerEvent } from "../app-api-authorizer";
import { hashApiKey, HASH_ALG } from "../../utils/api-key-hash";
import * as apiKeyHash from "../../utils/api-key-hash";

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

// Capture console.log/console.info for audit log assertions
let logSpy: jest.SpyInstance;

// ── Helpers ─────────────────────────────────────────────────

const TEST_APP_ID = "app-test-123";
const TEST_API_KEY = "cit_test_api_key_plaintext_value_1234";
const TEST_PEPPER = "f".repeat(64);
const TEST_HASHED_KEY = hashApiKey(TEST_API_KEY, TEST_PEPPER);
const TEST_KEY_ID = "key-abc-789";
const TEST_SOURCE_IP = "192.168.1.100";

function makeEvent(overrides: Partial<AuthorizerEvent> = {}): AuthorizerEvent {
  return {
    headers: {
      "x-api-key": TEST_API_KEY,
      ...(overrides.headers !== undefined ? overrides.headers : {}),
    },
    requestContext: {
      http: { sourceIp: TEST_SOURCE_IP },
      stage: "$default",
      apiId: "api-gw-id",
      ...(overrides.requestContext || {}),
    },
    stageVariables: {
      appId: TEST_APP_ID,
      ...(overrides.stageVariables || {}),
    },
  };
}

/** New-generation (HMAC + hashAlg) active key item. */
function makeActiveKeyItem(overrides: Record<string, unknown> = {}) {
  return {
    appId: `${TEST_APP_ID}#APIKEY#${TEST_KEY_ID}`,
    groupId: `APP#${TEST_APP_ID}`,
    sortId: `APIKEY#${TEST_KEY_ID}`,
    keyId: TEST_KEY_ID,
    name: "default",
    hashedKey: TEST_HASHED_KEY,
    hashAlg: HASH_ALG,
    prefix: TEST_API_KEY.substring(0, 8),
    status: "ACTIVE",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Legacy (pre-migration, plain SHA-256, no hashAlg) active key item. */
function makeLegacyActiveKeyItem(overrides: Record<string, unknown> = {}) {
  const item = {
    appId: `${TEST_APP_ID}#APIKEY#${TEST_KEY_ID}`,
    groupId: `APP#${TEST_APP_ID}`,
    sortId: `APIKEY#${TEST_KEY_ID}`,
    keyId: TEST_KEY_ID,
    name: "default",
    hashedKey: createHash("sha256").update(TEST_API_KEY).digest("hex"),
    prefix: TEST_API_KEY.substring(0, 8),
    status: "ACTIVE",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
  // hashAlg absent marks a legacy record — must not be set even via overrides
  // unless a test explicitly wants a hashAlg-tagged record.
  delete (item as Record<string, unknown>).hashAlg;
  return item;
}

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: "citadel-apps-test",
  };
}

/** Returns a future ISO timestamp (1 hour from now). */
function futureTimestamp(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

/** Returns a past ISO timestamp (1 hour ago). */
function pastTimestamp(): string {
  return new Date(Date.now() - 3600_000).toISOString();
}

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  apiKeyHash.__resetApiKeyPepperCacheForTest();
  jest.spyOn(apiKeyHash, "getApiKeyPepper").mockResolvedValue(TEST_PEPPER);
  // Spy on structured logging — authorizer logs audit entries via console
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Valid Active Key Tests (Req 3.2, 3.3) ───────────────────

describe("valid active key returns Allow", () => {
  test("returns isAuthorized true for valid active key with no expiry", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(true);
  });

  test("returns isAuthorized true for valid active key with future expiry", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem({ expiresAt: futureTimestamp() })],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(true);
  });

  test("queries GroupIndex for APIKEY# items under APP#{appId}", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent(), undefined, makeDeps());

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const input = queryCalls[0].args[0].input;
    expect(input.IndexName).toBe("GroupIndex");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":gid": `APP#${TEST_APP_ID}`,
    });
    // Should filter for APIKEY# items
    expect(input.KeyConditionExpression).toContain("groupId");
    expect(
      input.KeyConditionExpression!.includes("APIKEY") ||
        (input.ExpressionAttributeValues as Record<string, string>)[
          ":sk"
        ]?.includes("APIKEY"),
    ).toBe(true);
  });

  test("matches key by HMAC-SHA-256 hash of provided x-api-key", async () => {
    const otherKeyHash = hashApiKey("some-other-key", TEST_PEPPER);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeActiveKeyItem({ keyId: "key-other", hashedKey: otherKeyHash }),
        makeActiveKeyItem({ keyId: TEST_KEY_ID, hashedKey: TEST_HASHED_KEY }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(true);
  });
});

// ── Dual-Read Migration Window (legacy plain-SHA-256 records) ──────────────

describe("dual-read: legacy plain-SHA-256 record (no hashAlg) still authorizes", () => {
  test("returns isAuthorized true for a legacy record whose hashedKey is plain SHA-256", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeLegacyActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(true);
  });

  test("legacy record status/expiry rules still apply (REVOKED denies)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeLegacyActiveKeyItem({ status: "REVOKED" })],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });
});

describe("no-cross-match: legacy and HMAC digests must not match each other's records", () => {
  test("a legacy record's plain-SHA-256 hash does not match against the HMAC digest path (hashAlg present but stale legacy hash)", async () => {
    // Simulates a corrupted/mis-tagged record: hashAlg present (so the
    // authorizer computes the HMAC comparison) but hashedKey is the legacy
    // plain-SHA-256 digest — must NOT match.
    const legacyDigest = createHash("sha256")
      .update(TEST_API_KEY)
      .digest("hex");
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeActiveKeyItem({ hashedKey: legacyDigest, hashAlg: HASH_ALG }),
      ],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });

  test("an HMAC digest does not match against the legacy comparison path (hashAlg absent but hashedKey is HMAC)", async () => {
    // hashAlg absent → legacy path is used; hashedKey holds the HMAC digest
    // instead — must NOT match, since the two digests differ for the same
    // plaintext+pepper.
    ddbMock.on(QueryCommand).resolves({
      Items: [makeLegacyActiveKeyItem({ hashedKey: TEST_HASHED_KEY })],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });
});

describe("pepper unavailable — fails closed", () => {
  test("returns isAuthorized false when getApiKeyPepper rejects", async () => {
    jest
      .spyOn(apiKeyHash, "getApiKeyPepper")
      .mockRejectedValue(new Error("SSM parameter not found"));
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });

  test("does not query DynamoDB when the pepper is unavailable (fails closed before lookup)", async () => {
    jest
      .spyOn(apiKeyHash, "getApiKeyPepper")
      .mockRejectedValue(new Error("AccessDenied"));

    await handler(makeEvent(), undefined, makeDeps());

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("producer round-trip: produced key authorizes", () => {
  test("a key hashed via hashApiKey(plaintext, pepper) with hashAlg set authorizes end-to-end", async () => {
    const plaintext = "cit_roundtrip_plaintext_key_9876";
    const hashed = hashApiKey(plaintext, TEST_PEPPER);
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem({ hashedKey: hashed, hashAlg: HASH_ALG })],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(
      makeEvent({ headers: { "x-api-key": plaintext } }),
      undefined,
      makeDeps(),
    );

    expect(result.isAuthorized).toBe(true);
  });
});

// ── appId Context Propagation (regression lock — app-invoke contract) ──────
// The app-invoke EventBridge integration reads the trusted appId from
// $context.authorizer.appId (see app-publish-handler.ts provisionApiGateway).
// This locks in that the authorizer already resolves appId from
// stageVariables and returns it in context, so that integration contract
// cannot silently regress.

describe("resolves appId from stageVariables and returns it in context", () => {
  test("returns appId from stageVariables in the authorizer context on allow", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(true);
    expect(result.context?.appId).toBe(TEST_APP_ID);
  });
});

// ── Missing x-api-key Header (Req 3.4) ─────────────────────

describe("missing x-api-key header returns 401", () => {
  test("throws Unauthorized when x-api-key header is missing", async () => {
    const event = makeEvent();
    delete event.headers!["x-api-key"];

    await expect(handler(event, undefined, makeDeps())).rejects.toThrow(
      "Unauthorized",
    );
  });

  test("throws Unauthorized when x-api-key header is empty string", async () => {
    const event = makeEvent({ headers: { "x-api-key": "" } });

    await expect(handler(event, undefined, makeDeps())).rejects.toThrow(
      "Unauthorized",
    );
  });

  test("throws Unauthorized when headers object is undefined", async () => {
    const event: AuthorizerEvent = {
      stageVariables: { appId: TEST_APP_ID },
      requestContext: { http: { sourceIp: TEST_SOURCE_IP } },
    };
    delete (event as { headers?: unknown }).headers;

    await expect(handler(event, undefined, makeDeps())).rejects.toThrow(
      "Unauthorized",
    );
  });
});

// ── Invalid Key — No Matching Hash (Req 3.4) ───────────────

describe("invalid key (no matching hash) returns 401", () => {
  test("returns isAuthorized false when no APIKEY# items exist for app", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });

  test("returns isAuthorized false when hash does not match any stored key", async () => {
    const differentHash = hashApiKey("wrong-key", TEST_PEPPER);
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem({ hashedKey: differentHash })],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });
});

// ── Revoked Key (Req 3.4) ───────────────────────────────────

describe("revoked key returns 401", () => {
  test("returns isAuthorized false when matching key has status REVOKED", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem({ status: "REVOKED" })],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });
});

// ── Expired Key (Req 3.4) ───────────────────────────────────

describe("expired key returns 401", () => {
  test("returns isAuthorized false when expiresAt is in the past", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeActiveKeyItem({ status: "ACTIVE", expiresAt: pastTimestamp() }),
      ],
    });

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });
});

// ── DynamoDB Failure — Fail Closed (Req 3.4) ───────────────

describe("DynamoDB failure returns 401 (fail closed)", () => {
  test("returns isAuthorized false when DynamoDB query throws", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("DynamoDB service unavailable"));

    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(false);
  });

  test("does not throw on DynamoDB failure — fails closed gracefully", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("Internal server error"));

    // Should NOT throw — should return deny
    const result = await handler(makeEvent(), undefined, makeDeps());
    expect(result.isAuthorized).toBe(false);
  });
});

// ── Audit Logging (Req 3.9) ─────────────────────────────────

describe("audit log includes required fields", () => {
  test("logs appId, apiKeyId, sourceIp, timestamp, and result on successful auth", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent(), undefined, makeDeps());

    // Find the audit log call among all console.log/info calls
    const allLogCalls = [
      ...logSpy.mock.calls,
      ...(console.info as jest.Mock).mock.calls,
    ];
    const auditLog = allLogCalls.find((call) => {
      const msg =
        typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
      return msg.includes(TEST_APP_ID) && msg.includes("allow");
    });

    expect(auditLog).toBeDefined();
    const logContent =
      typeof auditLog![0] === "object"
        ? auditLog![0]
        : JSON.parse(auditLog![0]);
    expect(logContent.appId).toBe(TEST_APP_ID);
    expect(logContent.apiKeyId).toBe(TEST_KEY_ID);
    expect(logContent.sourceIp).toBe(TEST_SOURCE_IP);
    expect(logContent.timestamp).toBeDefined();
    expect(logContent.result).toBe("allow");
  });

  test("logs appId, apiKeyId as unknown, sourceIp, timestamp, and deny result on failed auth", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent(), undefined, makeDeps());

    const allLogCalls = [
      ...logSpy.mock.calls,
      ...(console.info as jest.Mock).mock.calls,
    ];
    const auditLog = allLogCalls.find((call) => {
      const msg =
        typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
      return msg.includes(TEST_APP_ID) && msg.includes("deny");
    });

    expect(auditLog).toBeDefined();
    const logContent =
      typeof auditLog![0] === "object"
        ? auditLog![0]
        : JSON.parse(auditLog![0]);
    expect(logContent.appId).toBe(TEST_APP_ID);
    expect(logContent.apiKeyId).toBeDefined(); // "unknown" or similar
    expect(logContent.sourceIp).toBe(TEST_SOURCE_IP);
    expect(logContent.timestamp).toBeDefined();
    expect(logContent.result).toBe("deny");
  });

  test("audit log timestamp is a valid ISO 8601 string", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent(), undefined, makeDeps());

    const allLogCalls = [
      ...logSpy.mock.calls,
      ...(console.info as jest.Mock).mock.calls,
    ];
    const auditLog = allLogCalls.find((call) => {
      const msg =
        typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]);
      return msg.includes(TEST_APP_ID);
    });

    expect(auditLog).toBeDefined();
    const logContent =
      typeof auditLog![0] === "object"
        ? auditLog![0]
        : JSON.parse(auditLog![0]);
    const parsed = new Date(logContent.timestamp);
    expect(parsed.toISOString()).toBe(logContent.timestamp);
  });
});

// ── lastUsedAt Async Update (Req 3.8) ───────────────────────

describe("lastUsedAt updated asynchronously on valid key", () => {
  test("calls UpdateCommand to set lastUsedAt on successful authorization", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent(), undefined, makeDeps());

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the update targets the correct key item
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.TableName).toBe("citadel-apps-test");
    expect(updateInput.UpdateExpression).toContain("lastUsedAt");
  });

  test("does not fail authorization if lastUsedAt update fails (best-effort)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeActiveKeyItem()],
    });
    ddbMock.on(UpdateCommand).rejects(new Error("Update failed"));

    // Authorization should still succeed even if lastUsedAt update fails
    const result = await handler(makeEvent(), undefined, makeDeps());

    expect(result.isAuthorized).toBe(true);
  });

  test("does not call UpdateCommand on failed authorization", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent(), undefined, makeDeps());

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });
});
