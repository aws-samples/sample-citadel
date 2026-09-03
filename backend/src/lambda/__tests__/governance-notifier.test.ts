// ---------------------------------------------------------------------------
// R1-R7 — durable SNS delivery + outcome records (finding e396a7ee, PART B).
// Fail-closed semantics: WS failure throws (pinned above); CRITICAL SNS
// failure throws (DLQ + alarm); outcome-row write failure DEGRADES (log +
// metric, no throw) — see design §4 for the asymmetry rationale.
// ---------------------------------------------------------------------------

function makeAutoRollbackEvent(): EventBridgeEvent<
  string,
  Record<string, unknown>
> {
  return makeEvent("governance.release.auto_rollback", {
    orgId: "org_ACME",
    agentTargetId: "agent-1",
    environment: "prod",
    action: "AUTO_ABORT_CANARY",
    metric: "error_rate",
    observedValue: 0.42,
    threshold: 0.05,
    sampleCount: 500,
    fromReleaseId: "rel-1",
    toReleaseId: "rel-2",
    candidateReleaseId: "rel-2",
    fromVersion: 3,
    traceContext: { correlationId: "corr-1" },
  });
}

describe("R1: CRITICAL type publishes SNS + writes RELAYED_WS_AND_SNS outcome row", () => {
  test("publishes to ALARM_TOPIC_ARN with expected Subject/Message and writes an outcome row", async () => {
    const event = makeAutoRollbackEvent();
    await handler(event);

    const snsCalls = snsMock.commandCalls(PublishCommand);
    expect(snsCalls).toHaveLength(1);
    const snsInput = snsCalls[0].args[0].input;
    expect(snsInput.TopicArn).toBe(process.env.ALARM_TOPIC_ARN);
    expect(snsInput.Subject!.length).toBeLessThanOrEqual(100);
    expect(snsInput.Message).toContain("governance.release.auto_rollback");
    expect(snsInput.Message).toContain("org_ACME");

    const ddbCalls = ddbMock.commandCalls(PutItemCommand);
    expect(ddbCalls).toHaveLength(1);
    const item = ddbCalls[0].args[0].input.Item as Record<
      string,
      { S?: string; BOOL?: boolean; N?: string }
    >;
    expect(item.eventId?.S).toBe(event.id);
    expect(item.outcome?.S).toBe("RELAYED_WS_AND_SNS");
    expect(item.snsRouted?.BOOL).toBe(true);
    expect(item.snsMessageId?.S).toBe("sns-msg-1");
  });
});

describe("R2: INFO-tier type — no SNS publish, RELAYED_WS_ONLY outcome row", () => {
  test("does not publish to SNS and records RELAYED_WS_ONLY", async () => {
    const event = makeEvent("governance.round.started", {
      projectId: "p1",
      roundN: 1,
    });
    await handler(event);

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    const ddbCalls = ddbMock.commandCalls(PutItemCommand);
    expect(ddbCalls).toHaveLength(1);
    const item = ddbCalls[0].args[0].input.Item as Record<
      string,
      { S?: string; BOOL?: boolean }
    >;
    expect(item.outcome?.S).toBe("RELAYED_WS_ONLY");
    expect(item.snsRouted?.BOOL).toBe(false);
  });
});

describe("R3: SNS message body whitelist projection + redaction + Subject cap", () => {
  test("body contains detailType/org/correlationId/deep-link, excludes non-whitelisted fields, strips <script>, Subject <=100", async () => {
    const event = makeEvent("governance.offfrontier.escalated", {
      projectId: "p1",
      agentId: "agent-1",
      reason: "drift<script>alert(1)</script>",
      // Simulated non-whitelisted sensitive field on the raw detail.
      secretToken: "sk-super-secret-value",
      traceContext: { correlationId: "corr-9" },
    });
    await handler(event);

    const snsCalls = snsMock.commandCalls(PublishCommand);
    expect(snsCalls).toHaveLength(1);
    const { Subject, Message } = snsCalls[0].args[0].input;
    expect(Subject!.length).toBeLessThanOrEqual(100);
    expect(Message).toContain("governance.offfrontier.escalated");
    expect(Message).toContain("corr-9");
    expect(Message).toContain("https://ui.example.com");
    expect(Message).not.toContain("sk-super-secret-value");
    expect(Message).not.toContain("<script>");
  });
});

describe("R4: CRITICAL SNS publish failure — handler THROWS", () => {
  test("rethrows when SNS PublishCommand rejects for a CRITICAL type (drives DLQ + alarm)", async () => {
    snsMock.on(PublishCommand).rejects(new Error("Sns.Throttling"));
    const event = makeAutoRollbackEvent();
    await expect(handler(event)).rejects.toThrow();
  });
});

describe("R5: AppSync (WS) failure — handler THROWS (regression pin)", () => {
  test("rethrows when AppSync responds non-OK, unchanged from prior behaviour", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: "Server error" }] }),
      text: async () => "Server error",
    });
    const event = makeAutoRollbackEvent();
    await expect(handler(event)).rejects.toThrow();
  });
});

describe("R6: outcome-row write failure DEGRADES (no throw) + emits metric", () => {
  test("does not throw when PutItem fails after successful WS+SNS delivery; emits NotifierOutcomeWriteFailure metric", async () => {
    ddbMock
      .on(PutItemCommand)
      .rejects(new Error("Ddb.ProvisionedThroughputExceeded"));
    const event = makeAutoRollbackEvent();
    await expect(handler(event)).resolves.toBeDefined();

    const cwCalls = cwMock.commandCalls(PutMetricDataCommand);
    expect(cwCalls.length).toBeGreaterThanOrEqual(1);
    const metricData = cwCalls[0].args[0].input.MetricData ?? [];
    expect(
      metricData.some((m) => m.MetricName === "NotifierOutcomeWriteFailure"),
    ).toBe(true);
  });

  test("does not mask a WS delivery failure by throwing an outcome-write error instead", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: "boom" }] }),
      text: async () => "boom",
    });
    ddbMock.on(PutItemCommand).rejects(new Error("Ddb.Unavailable"));
    const event = makeAutoRollbackEvent();
    // Must throw the ORIGINAL delivery error, not an outcome-write error.
    await expect(handler(event)).rejects.toThrow(
      /AppSync|500|Server error|boom/i,
    );
  });
});

describe("R7: idempotency — same event.id twice writes a single overwritten row, no error", () => {
  test("processing the same eventId twice does not throw and PutItem is called with the same key both times", async () => {
    const event = makeAutoRollbackEvent();
    await handler(event);
    await handler(event);

    const ddbCalls = ddbMock.commandCalls(PutItemCommand);
    expect(ddbCalls).toHaveLength(2);
    const firstKey = (
      ddbCalls[0].args[0].input.Item as Record<string, { S?: string }>
    ).eventId?.S;
    const secondKey = (
      ddbCalls[1].args[0].input.Item as Record<string, { S?: string }>
    ).eventId?.S;
    expect(firstKey).toBe(event.id);
    expect(secondKey).toBe(event.id);
  });
});
/**
 * Tests for governance-notifier Lambda — AppSync subscription relay.
 *
 * Mirrors governance-finding-fanout.test.ts mock style: jest.mock() the
 * SignatureV4 / Sha256 / credential-provider modules, mock global fetch,
 * then assert on signing + posting + rethrow semantics for each of the
 * 17 governance.* detail-types declared in
 * backend/src/utils/notifier-base.ts.
 */

// Mock global fetch before any imports (handler uses node 18+ global fetch).
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockSign = jest.fn();
jest.mock("@smithy/signature-v4", () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({
    sign: mockSign,
  })),
}));

jest.mock("@aws-crypto/sha256-js", () => ({
  Sha256: jest.fn(),
}));

jest.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: jest.fn().mockReturnValue("mock-credentials"),
}));

import type { EventBridgeEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { GOVERNANCE_DETAIL_TYPES } from "../../utils/notifier-base";

// Lazy-import the handler (must come after the env var setup) so the
// production module is required only once per test process and the
// internal lazy-signer cache is exercised under realistic conditions.
import { handler, __resetForTest } from "../governance-notifier";

const APPSYNC_ENDPOINT_VAL =
  "https://test-api.appsync-api.us-east-1.amazonaws.com/graphql";

const snsMock = mockClient(SNSClient);
const ddbMock = mockClient(DynamoDBClient);
const cwMock = mockClient(CloudWatchClient);

beforeAll(() => {
  process.env.APPSYNC_ENDPOINT = APPSYNC_ENDPOINT_VAL;
  process.env.AWS_REGION = "us-east-1";
  process.env.ALARM_TOPIC_ARN =
    "arn:aws:sns:us-east-1:123456789012:citadel-alarms-test";
  process.env.NOTIFICATION_OUTCOMES_TABLE =
    "citadel-governance-notification-outcomes-test";
  process.env.GOVERNANCE_UI_BASE_URL = "https://ui.example.com";
});

beforeEach(() => {
  mockFetch.mockReset();
  mockSign.mockReset();
  snsMock.reset();
  ddbMock.reset();
  cwMock.reset();
  __resetForTest();
  mockSign.mockResolvedValue({
    headers: {
      "Content-Type": "application/json",
      host: "test-api.appsync-api.us-east-1.amazonaws.com",
      authorization:
        "AWS4-HMAC-SHA256 Credential=test/20260519/us-east-1/appsync/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc",
      "x-amz-date": "20260519T000000Z",
      "x-amz-security-token": "test-session-token",
    },
    body: JSON.stringify({ query: "mutation", variables: {} }),
  });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        publishGovernanceEvent: {
          detailType: "governance.adr.locked",
          source: "citadel.backend",
          eventTime: "2026-04-30T00:00:00Z",
          detail: "{}",
          version: 1,
        },
      },
    }),
  });
  snsMock.on(PublishCommand).resolves({ MessageId: "sns-msg-1" });
  ddbMock.on(PutItemCommand).resolves({});
  cwMock.on(PutMetricDataCommand).resolves({});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

afterAll(() => {
  delete process.env.APPSYNC_ENDPOINT;
  delete process.env.AWS_REGION;
  delete process.env.ALARM_TOPIC_ARN;
  delete process.env.NOTIFICATION_OUTCOMES_TABLE;
  delete process.env.GOVERNANCE_UI_BASE_URL;
});

function makeEvent(
  detailType: string,
  detail: Record<string, unknown> = { projectId: "p1" },
): EventBridgeEvent<string, Record<string, unknown>> {
  return {
    version: "0",
    id: `evt-${detailType}`,
    "detail-type": detailType,
    source: "citadel.backend",
    account: "123456789012",
    time: "2026-04-30T00:00:00Z",
    region: "us-east-1",
    resources: [],
    detail,
  };
}

// ---------------------------------------------------------------------------
// Sanity: notifier-base.ts is the single source of truth for governance.*
// detail-types. The test suite must iterate every entry it exposes.
// ---------------------------------------------------------------------------

describe("governance-notifier — detail-type catalogue invariant", () => {
  test("GOVERNANCE_DETAIL_TYPES has exactly 26 entries (canonical list, CIT-103 adds governance.eval.case.completed/judge.requested/judged; Phase 2 adds governance.eval.sample.captured; CIT-105 adds governance.eval.baseline.designated/comparison.completed/eval.seed.heal.blocked; auto-rollback adds governance.release.auto_rollback)", () => {
    expect(GOVERNANCE_DETAIL_TYPES).toHaveLength(26);
  });

  test('every entry begins with the "governance." namespace prefix', () => {
    for (const dt of GOVERNANCE_DETAIL_TYPES) {
      expect(dt.startsWith("governance.")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Parameterised happy path — POSTs the right mutation input for each of the
// governance.* detail-types (count tracks GOVERNANCE_DETAIL_TYPES; 20 as of
// CIT-103).
// ---------------------------------------------------------------------------

describe("governance-notifier — relays each governance.* detail-type", () => {
  test.each(GOVERNANCE_DETAIL_TYPES.map((d) => [d]))(
    "POSTs publishGovernanceEvent for %s",
    async (detailType) => {
      const detail = { projectId: "p1", marker: detailType };
      const event = makeEvent(detailType, detail);

      await handler(event);

      expect(mockSign).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.query).toContain("publishGovernanceEvent");
      expect(body.variables.input).toEqual({
        detailType,
        source: "citadel.backend",
        eventTime: "2026-04-30T00:00:00Z",
        detail: JSON.stringify(detail),
        version: 1,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Defence-in-depth — drop non-governance-prefixed events.
// ---------------------------------------------------------------------------

describe("governance-notifier — defence in depth", () => {
  test("drops a non-governance-prefixed detail-type without POSTing", async () => {
    const event = makeEvent("design.progress.updated", { projectId: "p1" });

    await handler(event);

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("drops an unknown governance.* detail-type without POSTing", async () => {
    const event = makeEvent("governance.unknown.future", { projectId: "p1" });

    await handler(event);

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Configuration errors — missing APPSYNC_ENDPOINT must throw.
// ---------------------------------------------------------------------------

describe("governance-notifier — configuration errors", () => {
  test("throws a structured error when APPSYNC_ENDPOINT is missing", async () => {
    const saved = process.env.APPSYNC_ENDPOINT;
    delete process.env.APPSYNC_ENDPOINT;
    try {
      const event = makeEvent("governance.adr.locked", { projectId: "p1" });
      await expect(handler(event)).rejects.toThrow(/APPSYNC_ENDPOINT/);
    } finally {
      process.env.APPSYNC_ENDPOINT = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Failure paths — AppSync 4xx and 5xx must rethrow so EventBridge retries.
// ---------------------------------------------------------------------------

describe("governance-notifier — AppSync failure paths", () => {
  test("rethrows when AppSync responds 4xx (so EventBridge retries / DLQ)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ errors: [{ message: "Bad request" }] }),
      text: async () => '{"errors":[{"message":"Bad request"}]}',
    });

    const event = makeEvent("governance.adr.locked", { projectId: "p1" });
    await expect(handler(event)).rejects.toThrow();
  });

  test("rethrows when AppSync responds 5xx", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: "Server error" }] }),
      text: async () => "Server error",
    });

    const event = makeEvent("governance.round.started", {
      projectId: "p1",
      roundN: 1,
    });
    await expect(handler(event)).rejects.toThrow();
  });

  test("rethrows when GraphQL returns errors with HTTP 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: "Field publishGovernanceEvent unknown" }],
      }),
    });

    const event = makeEvent("governance.adr.locked", { projectId: "p1" });
    await expect(handler(event)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SigV4 wiring — the signed HttpRequest reaches the fetch call with the
// AWS auth headers our SignatureV4 mock produced.
// ---------------------------------------------------------------------------

describe("governance-notifier — SigV4 signing", () => {
  test("forwards Authorization, x-amz-date, x-amz-security-token headers from the signer", async () => {
    const event = makeEvent("governance.specification.created", {
      projectId: "p1",
      specId: "s1",
      version: 1,
    });

    await handler(event);

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers).toEqual(
      expect.objectContaining({
        authorization: expect.stringContaining("AWS4-HMAC-SHA256"),
        "x-amz-date": "20260519T000000Z",
        "x-amz-security-token": "test-session-token",
      }),
    );
  });

  test("signs the request once per invocation (lazy-singleton signer survives multiple calls)", async () => {
    const event = makeEvent("governance.archetype.classified", {
      projectId: "p1",
      archetype: "MONOLITHIC_DB",
      confidence: 0.9,
    });

    await handler(event);
    await handler(event);

    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
