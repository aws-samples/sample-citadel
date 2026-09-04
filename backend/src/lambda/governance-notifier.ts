/**
 * Governance event AppSync subscription relay.
 *
 * Pipeline:
 *
 *   Producer (resolver / Lambda)
 *     └── PutEvents on agentEventBus, DetailType: governance.*
 *           └── EventBridge rule (citadel-governance-events-{env})
 *                 └── this Lambda                              (sign + POST)
 *                       ├── AppSync `publishGovernanceEvent` (IAM-authed, WS fanout)
 *                       ├── [CRITICAL types only] SNS Publish -> alarmTopic
 *                       └── DynamoDB PutItem -> notification-outcomes table
 *
 * Reuses the chatter-publisher.ts shape (single AppSync mutation per
 * EventBridge event, SigV4 signing) plus the lazy-signer pattern from
 * governance-finding-fanout.ts (signer constructed on first invocation
 * and cached for the warm-container's lifetime).
 *
 * Durable delivery + fail-closed semantics (finding e396a7ee, PART B):
 * the WS fanout is EPHEMERAL — AppSync's NONE-datasource passthrough
 * resolver returns HTTP 200 with no `errors` regardless of how many
 * WebSocket connections are subscribed, including zero. A CRITICAL
 * governance event (off-frontier escalation, auto-rollback) that no
 * admin UI was open to receive must still reach a human, so this
 * handler ALSO publishes a whitelist-projected SNS notification to the
 * existing plaintext `alarmTopic` for the CRITICAL subset
 * (CRITICAL_GOVERNANCE_DETAIL_TYPES in notifier-base.ts), and records a
 * durable per-attempt outcome row for every routed event (CRITICAL or
 * not) in NOTIFICATION_OUTCOMES_TABLE.
 *
 * Deliberate fail-closed / degrade ASYMMETRY (design §4 — do not
 * "simplify" this to uniform throw-on-any-failure):
 *   - WS (AppSync) publish failure -> THROW (unchanged prior behaviour;
 *     drives EventBridge retry -> DLQ -> alarm).
 *   - CRITICAL SNS publish failure -> THROW. A critical event that
 *     reached neither the live UI nor the guaranteed channel MUST DLQ +
 *     page — silently downgrading it to WS-only defeats the entire
 *     purpose of this fix.
 *   - Outcome-row (DynamoDB) write failure -> DOES NOT THROW when the
 *     required deliveries above already succeeded. It logs a structured
 *     error and emits the `NotifierOutcomeWriteFailure` CloudWatch
 *     metric instead. Rationale: by this point the event has ALREADY
 *     reached a human (WS and/or SNS succeeded); throwing here would
 *     make EventBridge retry the whole handler, which would re-publish
 *     a DUPLICATE SNS page for an event that was already delivered —
 *     worse than a missing audit row. A lost outcome row degrades
 *     observability, not delivery, and pages via its own alarm instead.
 *     This mirrors the auto-rollback evaluator's D6 precedent (a
 *     committed-but-unrecorded write pages via a dedicated alarm rather
 *     than failing the already-committed operation).
 *
 * Error semantics: log structured error and rethrow for the REQUIRED
 * delivery paths (WS, CRITICAL SNS). EventBridge async invocation
 * retries 2x and routes terminally-failed events to the DLQ configured
 * in governance-stack.ts via configureAsyncInvoke. The project rule "no
 * empty catches around external writes" means every failure surfaces —
 * never swallowed, even the DEGRADE path above (which logs + emits a
 * metric rather than swallowing silently).
 *
 * Defence-in-depth: the EventBridge rule already constrains
 * detail-types to governance.*, but the handler re-checks against the
 * canonical GOVERNANCE_DETAIL_TYPES list from notifier-base.ts so a
 * loosened rule (e.g. for backfill replays) cannot accidentally fan a
 * non-governance event onto the admin-only subscription.
 */

import type { EventBridgeEvent } from "aws-lambda";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  DynamoDBClient,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  GOVERNANCE_DETAIL_TYPES,
  isCriticalGovernanceDetailType,
  buildGovernanceNotification,
  type GovernanceDetailType,
} from "../utils/notifier-base";
import {
  annotateFromCarried,
  extractCarried,
  logFields,
} from "../utils/trace-context";

const PUBLISH_MUTATION = `
  mutation PublishGovernanceEvent($input: GovernanceEventInput!) {
    publishGovernanceEvent(input: $input) {
      detailType
      source
      eventTime
      detail
      version
    }
  }
`;

// Bumped manually when the GovernanceEvent payload contract changes so
// downstream subscribers can branch on `version` rather than guessing
// from shape. Keep in lock-step with the schema.graphql GovernanceEvent
// type and the architecture brief.
const GOVERNANCE_EVENT_VERSION = 1;

const GOVERNANCE_DETAIL_TYPE_SET: ReadonlySet<string> = new Set<string>(
  GOVERNANCE_DETAIL_TYPES,
);

// TTL for the durable outcome row: 90 days of operational retention —
// longer than the 14-day DLQ retention window, short of governance-record
// permanence (design §3).
const OUTCOME_ROW_TTL_SECONDS = 90 * 24 * 60 * 60;

interface GovernanceEventInput {
  detailType: GovernanceDetailType;
  source: string;
  eventTime: string;
  detail: string; // AWSJSON — JSON-encoded original event.detail
  version: number;
}

type WsResult = "OK" | "GRAPHQL_ERROR" | "HTTP_ERROR";
type Outcome = "RELAYED_WS_ONLY" | "RELAYED_WS_AND_SNS" | "FAILED";

/**
 * Typed structured error so callers (and the EventBridge / DLQ
 * pipeline) can branch on `name` rather than parse `message`. Per the
 * project preference: typed errors over generic Error.
 */
class GovernanceNotifierError extends Error {
  public readonly statusCode: number | null;
  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = "GovernanceNotifierError";
    this.statusCode = statusCode;
  }
}

let _signer: SignatureV4 | null = null;
function getSigner(): SignatureV4 {
  if (!_signer) {
    _signer = new SignatureV4({
      credentials: defaultProvider(),
      region: process.env.AWS_REGION || "us-east-1",
      service: "appsync",
      sha256: Sha256,
    });
  }
  return _signer;
}

let _snsClient: SNSClient | null = null;
function snsClient(): SNSClient {
  if (!_snsClient) _snsClient = new SNSClient({});
  return _snsClient;
}

let _ddbClient: DynamoDBClient | null = null;
function ddbClient(): DynamoDBClient {
  if (!_ddbClient) _ddbClient = new DynamoDBClient({});
  return _ddbClient;
}

let _cwClient: CloudWatchClient | null = null;
function cwClient(): CloudWatchClient {
  if (!_cwClient) _cwClient = new CloudWatchClient({});
  return _cwClient;
}

function isGovernanceDetailType(
  detailType: string,
): detailType is GovernanceDetailType {
  return GOVERNANCE_DETAIL_TYPE_SET.has(detailType);
}

async function publishGovernanceEvent(
  input: GovernanceEventInput,
): Promise<void> {
  const endpoint = process.env.APPSYNC_ENDPOINT;
  if (!endpoint) {
    throw new GovernanceNotifierError("APPSYNC_ENDPOINT env var is required");
  }

  const url = new URL(endpoint);
  const body = JSON.stringify({
    query: PUBLISH_MUTATION,
    variables: { input },
  });

  const request = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      "Content-Type": "application/json",
      host: url.hostname,
    },
    body,
  });

  const signed = await getSigner().sign(request);

  const response = await fetch(`https://${url.hostname}${url.pathname}`, {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!response.ok) {
    throw new GovernanceNotifierError(
      `AppSync publishGovernanceEvent failed: HTTP ${response.status}`,
      response.status,
    );
  }

  // GraphQL spec — a 200 response can still carry top-level `errors`.
  // Treat as failure so EventBridge retries / routes to DLQ rather than
  // silently dropping a malformed mutation.
  const payload = (await response.json().catch((err) => {
    // Non-JSON 200 from AppSync is itself a contract violation worth
    // surfacing so operators see it in the DLQ instead of guessing.
    throw new GovernanceNotifierError(
      `AppSync publishGovernanceEvent returned non-JSON 200: ${
        err instanceof Error ? err.message : String(err)
      }`,
      response.status,
    );
  })) as { errors?: unknown[]; data?: unknown };

  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new GovernanceNotifierError(
      `AppSync publishGovernanceEvent GraphQL errors: ${JSON.stringify(
        payload.errors,
      )}`,
      response.status,
    );
  }
}

/**
 * Publish the CRITICAL-tier SNS backstop notification. Returns the SNS
 * MessageId on success. Throws on failure — callers on the CRITICAL path
 * MUST let this propagate (design §4: CRITICAL SNS failure throws so the
 * DLQ + its alarm catch it).
 */
async function publishCriticalSnsNotification(
  detailType: GovernanceDetailType,
  detail: Record<string, unknown>,
  meta: {
    eventId: string;
    eventTime: string;
    correlationId?: string;
    runId?: string;
  },
): Promise<string | undefined> {
  const topicArn = process.env.ALARM_TOPIC_ARN;
  if (!topicArn) {
    throw new GovernanceNotifierError("ALARM_TOPIC_ARN env var is required");
  }
  const { subject, body } = buildGovernanceNotification(detailType, detail, {
    env: process.env.ENVIRONMENT || "unknown",
    eventId: meta.eventId,
    eventTime: meta.eventTime,
    correlationId: meta.correlationId,
    runId: meta.runId,
    governanceUiBaseUrl: process.env.GOVERNANCE_UI_BASE_URL,
  });
  const result = await snsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: body,
    }),
  );
  return result.MessageId;
}

/**
 * Write the durable per-attempt outcome row. Idempotent on retry (eventId
 * is the table's PK, so a retry simply overwrites the same row). Callers
 * MUST NOT let a failure here mask an already-thrown delivery error, and
 * MUST NOT throw when deliveries already succeeded (design §4 DEGRADE
 * path) — see emitOutcomeWriteFailureMetric below for the alternative
 * signal.
 */
async function writeOutcomeRow(row: {
  eventId: string;
  attemptAt: string;
  detailType: string;
  source: string;
  org?: string;
  correlationId?: string;
  runId?: string;
  severity: "CRITICAL" | "INFO";
  wsResult: WsResult;
  snsRouted: boolean;
  snsMessageId?: string;
  outcome: Outcome;
}): Promise<void> {
  const tableName = process.env.NOTIFICATION_OUTCOMES_TABLE;
  if (!tableName) {
    throw new GovernanceNotifierError(
      "NOTIFICATION_OUTCOMES_TABLE env var is required",
    );
  }
  const expiresAt = Math.floor(Date.now() / 1000) + OUTCOME_ROW_TTL_SECONDS;
  const item: Record<string, AttributeValue> = {
    eventId: { S: row.eventId },
    attemptAt: { S: row.attemptAt },
    detailType: { S: row.detailType },
    source: { S: row.source },
    severity: { S: row.severity },
    wsResult: { S: row.wsResult },
    snsRouted: { BOOL: row.snsRouted },
    outcome: { S: row.outcome },
    expiresAt: { N: String(expiresAt) },
  };
  if (row.org) item.org = { S: row.org };
  if (row.correlationId) item.correlationId = { S: row.correlationId };
  if (row.runId) item.runId = { S: row.runId };
  if (row.snsMessageId) item.snsMessageId = { S: row.snsMessageId };

  await ddbClient().send(
    new PutItemCommand({
      TableName: tableName,
      Item: item,
    }),
  );
}

/**
 * DEGRADE-path signal for a lost outcome row (design §4): log a
 * structured error (never an empty catch — project rule) and emit the
 * `NotifierOutcomeWriteFailure` CloudWatch metric so a missing audit row
 * pages via its own dedicated alarm (governance-stack.ts) rather than
 * failing an already-delivered event. Best-effort — a failure to emit
 * the metric itself is logged but never thrown, since there is nothing
 * further to degrade to.
 */
async function emitOutcomeWriteFailureMetric(
  detailType: string,
  eventId: string,
): Promise<void> {
  try {
    await cwClient().send(
      new PutMetricDataCommand({
        Namespace: "Citadel/Governance",
        MetricData: [
          {
            MetricName: "NotifierOutcomeWriteFailure",
            Value: 1,
            Unit: "Count",
            Dimensions: [
              {
                Name: "Environment",
                Value: process.env.ENVIRONMENT || "unknown",
              },
            ],
          },
        ],
      }),
    );
  } catch (metricErr) {
    console.error(
      "governance-notifier: failed to emit NotifierOutcomeWriteFailure metric",
      {
        detailType,
        eventId,
        error:
          metricErr instanceof Error ? metricErr.message : String(metricErr),
      },
    );
  }
}

export const handler = async (
  event: EventBridgeEvent<string, unknown>,
): Promise<{ statusCode: number; body: string }> => {
  const detailType = event["detail-type"];

  // Consumer parse+annotate (design §"Annotation-key contract", H2/H4 hop):
  // no-op-safe when event.detail carries no traceContext (property-tested).
  const carried = extractCarried(event.detail);
  annotateFromCarried({ ...carried, correlationId: carried?.correlationId });
  console.log(
    JSON.stringify({
      level: "info",
      message: "governance-notifier received event",
      detailType,
      eventId: event.id,
      ...logFields(carried),
    }),
  );

  // Defence-in-depth: even though the EventBridge rule already filters
  // to governance.* detail-types, drop unrecognised entries here too.
  // Returning success keeps EventBridge from retrying (the event will
  // never become valid).
  if (!isGovernanceDetailType(detailType)) {
    console.log("governance-notifier: dropping non-governance event", {
      detailType,
      source: event.source,
      eventId: event.id,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, detailType }),
    };
  }

  const detailObj = (event.detail ?? {}) as Record<string, unknown>;
  const input: GovernanceEventInput = {
    detailType,
    source: event.source,
    eventTime: event.time,
    detail: JSON.stringify(detailObj),
    version: GOVERNANCE_EVENT_VERSION,
  };

  const isCritical = isCriticalGovernanceDetailType(detailType);
  let wsResult: WsResult = "OK";

  try {
    await publishGovernanceEvent(input);
  } catch (err) {
    // Structured log so the DLQ message is correlatable from the
    // CloudWatch side. Rethrow is mandatory — EventBridge async invoke
    // relies on the throw to drive the retry / DLQ pipeline. The WS
    // path is REQUIRED (fail-closed) — this is unchanged prior
    // behaviour (design §4: "WS failure throws as today").
    wsResult =
      err instanceof GovernanceNotifierError && err.statusCode
        ? "HTTP_ERROR"
        : "GRAPHQL_ERROR";
    console.error("governance-notifier: publish failed", {
      detailType,
      source: event.source,
      eventId: event.id,
      eventTime: event.time,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : "unknown",
    });
    // Attempt a best-effort outcome row for the failed attempt too (never
    // lets a write failure here mask the original WS error).
    await writeOutcomeRow({
      eventId: event.id,
      attemptAt: new Date().toISOString(),
      detailType,
      source: event.source,
      org: typeof detailObj.orgId === "string" ? detailObj.orgId : undefined,
      correlationId: carried?.correlationId,
      runId: carried?.runId,
      severity: isCritical ? "CRITICAL" : "INFO",
      wsResult,
      snsRouted: false,
      outcome: "FAILED",
    }).catch((writeErr) => {
      console.error(
        "governance-notifier: outcome-row write failed after a WS delivery failure (original error still rethrown)",
        {
          detailType,
          eventId: event.id,
          error:
            writeErr instanceof Error ? writeErr.message : String(writeErr),
        },
      );
      // Deliberately not awaited into a metric emit here — the original
      // WS failure already drives the DLQ/alarm path; a second alarm for
      // the same failed event would be noise. The DEGRADE metric is
      // reserved for the "everything downstream of delivery succeeded but
      // the audit row itself failed" case below.
    });
    throw err;
  }

  // WS succeeded. For the CRITICAL subset, ALSO publish to the durable
  // SNS backstop — this is the crux of finding e396a7ee: a zero-subscriber
  // WS fanout for a CRITICAL event is no longer silent because a human
  // still gets the SNS-routed email/Slack message regardless of whether
  // any WebSocket connection existed.
  let snsRouted = false;
  let snsMessageId: string | undefined;
  if (isCritical) {
    // CRITICAL SNS publish failure -> THROW (design §4). A critical event
    // that reached neither the live UI's zero subscribers nor the
    // guaranteed channel must DLQ + page, so this is NOT caught here.
    snsMessageId = await publishCriticalSnsNotification(detailType, detailObj, {
      eventId: event.id,
      eventTime: event.time,
      correlationId: carried?.correlationId,
      runId: carried?.runId,
    });
    snsRouted = true;
  }

  const outcome: Outcome = snsRouted ? "RELAYED_WS_AND_SNS" : "RELAYED_WS_ONLY";

  // Outcome-row write failure DEGRADES rather than throws (design §4):
  // by this point WS (and, if CRITICAL, SNS) have ALREADY succeeded, so
  // failing the Lambda now would make EventBridge retry the whole
  // handler and re-publish a DUPLICATE SNS page for an event that was
  // already delivered — strictly worse than a missing audit row. Emit
  // the dedicated CloudWatch metric instead so the lost row pages via
  // its own alarm (NotifierOutcomeWriteFailure, governance-stack.ts)
  // without masking or re-triggering the delivery that already worked.
  try {
    await writeOutcomeRow({
      eventId: event.id,
      attemptAt: new Date().toISOString(),
      detailType,
      source: event.source,
      org: typeof detailObj.orgId === "string" ? detailObj.orgId : undefined,
      correlationId: carried?.correlationId,
      runId: carried?.runId,
      severity: isCritical ? "CRITICAL" : "INFO",
      wsResult,
      snsRouted,
      snsMessageId,
      outcome,
    });
  } catch (writeErr) {
    console.error(
      "governance-notifier: outcome-row write failed AFTER successful delivery — degrading (no throw) to avoid a duplicate SNS page; see NotifierOutcomeWriteFailure metric",
      {
        detailType,
        eventId: event.id,
        outcome,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      },
    );
    await emitOutcomeWriteFailureMetric(detailType, event.id);
    // Deliberately NOT rethrown — see the asymmetry rationale in the
    // module-level comment and design §4.
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ relayed: true, detailType }),
  };
};

/** Test-only: reset the cached signer between test cases. */
export function __resetForTest(): void {
  _signer = null;
  _snsClient = null;
  _ddbClient = null;
  _cwClient = null;
}
