/**
 * Governance event AppSync subscription relay.
 *
 * Pipeline:
 *
 *   Producer (resolver / Lambda)
 *     └── PutEvents on agentEventBus, DetailType: governance.*
 *           └── EventBridge rule (citadel-governance-events-{env})
 *                 └── this Lambda                              (sign + POST)
 *                       └── AppSync `publishGovernanceEvent` (IAM-authed)
 *                             └── @aws_subscribe → onGovernanceEvent
 *
 * Reuses the chatter-publisher.ts shape (single AppSync mutation per
 * EventBridge event, SigV4 signing) plus the lazy-signer pattern from
 * governance-finding-fanout.ts (signer constructed on first invocation
 * and cached for the warm-container's lifetime).
 *
 * Error semantics: log structured error and rethrow. EventBridge async
 * invocation retries 2x and routes terminally-failed events to the DLQ
 * configured in governance-stack.ts via configureAsyncInvoke. The
 * project rule "no empty catches around external writes" means every
 * failure surfaces — never swallowed.
 *
 * Defence-in-depth: the EventBridge rule already constrains
 * detail-types to governance.*, but the handler re-checks against the
 * canonical GOVERNANCE_DETAIL_TYPES list from notifier-base.ts so a
 * loosened rule (e.g. for backfill replays) cannot accidentally fan a
 * non-governance event onto the admin-only subscription.
 */

import type { EventBridgeEvent } from 'aws-lambda';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  GOVERNANCE_DETAIL_TYPES,
  type GovernanceDetailType,
} from '../utils/notifier-base';

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

interface GovernanceEventInput {
  detailType: GovernanceDetailType;
  source: string;
  eventTime: string;
  detail: string; // AWSJSON — JSON-encoded original event.detail
  version: number;
}

/**
 * Typed structured error so callers (and the EventBridge / DLQ
 * pipeline) can branch on `name` rather than parse `message`. Per the
 * project preference: typed errors over generic Error.
 */
class GovernanceNotifierError extends Error {
  public readonly statusCode: number | null;
  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'GovernanceNotifierError';
    this.statusCode = statusCode;
  }
}

let _signer: SignatureV4 | null = null;
function getSigner(): SignatureV4 {
  if (!_signer) {
    _signer = new SignatureV4({
      credentials: defaultProvider(),
      region: process.env.AWS_REGION || 'us-east-1',
      service: 'appsync',
      sha256: Sha256,
    });
  }
  return _signer;
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
    throw new GovernanceNotifierError(
      'APPSYNC_ENDPOINT env var is required',
    );
  }

  const url = new URL(endpoint);
  const body = JSON.stringify({
    query: PUBLISH_MUTATION,
    variables: { input },
  });

  const request = new HttpRequest({
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      host: url.hostname,
    },
    body,
  });

  const signed = await getSigner().sign(request);

  const response = await fetch(`https://${url.hostname}${url.pathname}`, {
    method: 'POST',
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

export const handler = async (
  event: EventBridgeEvent<string, unknown>,
): Promise<{ statusCode: number; body: string }> => {
  const detailType = event['detail-type'];

  // Defence-in-depth: even though the EventBridge rule already filters
  // to governance.* detail-types, drop unrecognised entries here too.
  // Returning success keeps EventBridge from retrying (the event will
  // never become valid).
  if (!isGovernanceDetailType(detailType)) {
    console.log('governance-notifier: dropping non-governance event', {
      detailType,
      source: event.source,
      eventId: event.id,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, detailType }),
    };
  }

  const input: GovernanceEventInput = {
    detailType,
    source: event.source,
    eventTime: event.time,
    detail: JSON.stringify(event.detail ?? {}),
    version: GOVERNANCE_EVENT_VERSION,
  };

  try {
    await publishGovernanceEvent(input);
  } catch (err) {
    // Structured log so the DLQ message is correlatable from the
    // CloudWatch side. Rethrow is mandatory — EventBridge async invoke
    // relies on the throw to drive the retry / DLQ pipeline.
    console.error('governance-notifier: publish failed', {
      detailType,
      source: event.source,
      eventId: event.id,
      eventTime: event.time,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    throw err;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ relayed: true, detailType }),
  };
};

/** Test-only: reset the cached signer between test cases. */
export function __resetForTest(): void {
  _signer = null;
}
