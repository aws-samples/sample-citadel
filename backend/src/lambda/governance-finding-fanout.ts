/**
 * Governance finding fanout Lambda — Wave 3.C.
 *
 * Pipeline:
 *
 *   Python ledger writer (arbiter/governance/ledger.py)
 *     └── put_item on citadel-governance-ledger-{env}      (write authoritative)
 *           └── DynamoDB stream NEW_AND_OLD_IMAGES         (best-effort projection)
 *                 └── this Lambda                           (project + sign + POST)
 *                       └── AppSync `publishGovernanceFinding` (IAM-authed mutation)
 *                             └── @aws_subscribe → onGovernanceFinding (admin only)
 *
 * --------------------------------------------------------------------------
 * Architectural decision — fanout source: PATH A (DynamoDB streams).
 * --------------------------------------------------------------------------
 *
 * Two paths were evaluated in the Wave 3.C task brief:
 *
 *   A. DynamoDB streams on `governanceLedgerTable` → this Lambda.
 *   B. EventBridge `governance.finding.recorded` emitted by the Python
 *      ledger writer after a successful put_item.
 *
 * Path A was selected because:
 *   1. The ledger table currently has NO stream configured (lib/arbiter-stack.ts:
 *      842-849) and uses `RemovalPolicy.DESTROY` (NOT RETAIN). Adding
 *      `StreamSpecification` to a DynamoDB table is an "Update without
 *      interruption" per AWS::DynamoDB::Table CloudFormation update behaviour
 *      — no Replacement: True. `cdk synth` was inspected at deploy time to
 *      confirm. RETAIN-blocked replacement (which would force path B) does
 *      not apply here.
 *   2. Path A keeps the Python ledger writer untouched, preserving
 *      atomicity: the DDB write is the single authoritative event and the
 *      stream guarantees at-least-once delivery without a separate
 *      `put_events` call that could partially fail mid-write.
 *   3. The fanout is best-effort by design — even if this Lambda fails,
 *      the ledger write has already succeeded and the next-page poll on
 *      the Ledger UI surfaces the same finding.
 *
 * If a future change forces RemovalPolicy.RETAIN on the ledger table (or
 * pre-existing data forbids in-place stream addition for some other
 * reason), switch to path B by editing arbiter/governance/ledger.py to
 * emit a best-effort `governance.finding.recorded` EventBridge event
 * after the put_item succeeds (mirroring notifier-base.ts), and replace
 * the DynamoDB EventSourceMapping in arbiter-stack.ts with an
 * EventBridge rule on `agentEventBus` matching that detail-type. The
 * rest of this file (project → sign → POST → metric on failure) is
 * identical between the two paths.
 *
 * --------------------------------------------------------------------------
 * Best-effort guarantee.
 * --------------------------------------------------------------------------
 *
 * Per-record errors are caught, metricised on
 * `Citadel/Governance/Fanout/PublishFailure`, and swallowed. The handler
 * returns success (no `batchItemFailures`) for every batch — the ledger
 * write is the source of truth and the live tail UI is a soft-realtime
 * convenience, not a durable side channel. Throwing here would let DDB
 * stream retry (consuming retryAttempts) without changing the user-
 * visible outcome.
 *
 * The DLQ on the EventSourceMapping catches the rare cases where the
 * Lambda itself crashes (timeout, OOM, init failure) before this
 * handler even runs, so retryAttempts exhaustion does not silently lose
 * the trigger event.
 */

import type {
  DynamoDBStreamEvent,
  DynamoDBRecord,
  DynamoDBStreamHandler,
} from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue as DdbAttributeValue } from '@aws-sdk/client-dynamodb';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

const PUBLISH_MUTATION = `
  mutation PublishGovernanceFinding($input: PublishGovernanceFindingInput!) {
    publishGovernanceFinding(input: $input) {
      findingId
      workflowId
      decision
      reason
      requestingAgent
      targetAgent
      scopeEvaluated
      contractEvaluated
      escalationTarget
      residualAuthorityDenial
      timestamp
    }
  }
`;

const METRIC_NAMESPACE = 'Citadel/Governance/Fanout';
const METRIC_PUBLISH_FAILURE = 'PublishFailure';

// Lazy-instantiate so unit tests can mock the constructors before first
// use without racing module load.
let _cwClient: CloudWatchClient | null = null;
function cwClient(): CloudWatchClient {
  if (!_cwClient) _cwClient = new CloudWatchClient({});
  return _cwClient;
}

let _signer: SignatureV4 | null = null;
function signer(): SignatureV4 {
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

/**
 * GraphQL `PublishGovernanceFindingInput` shape — kept in lock-step with
 * the schema.graphql declaration. Field names are camelCase to match the
 * GraphQL contract; the projection step below maps the snake_case keys
 * the Python ledger writer emits.
 */
export interface PublishGovernanceFindingInput {
  findingId: string;
  workflowId: string;
  decision: string;
  reason: string;
  requestingAgent: string;
  targetAgent: string;
  scopeEvaluated: string | null;
  contractEvaluated: string | null;
  escalationTarget: string | null;
  residualAuthorityDenial: boolean | null;
  timestamp: number;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Project a DynamoDB ledger row (snake_case attributes, written by the
 * Python ledger writer) into the GraphQL `PublishGovernanceFindingInput`
 * shape (camelCase). Mirrors `projectFinding` in
 * governance-ui-resolver.ts but is duplicated here intentionally — the
 * two files target different runtime entry points and we don't want the
 * fanout Lambda to drag in the resolver bundle. Required scalars fall
 * back to empty string / 0 when absent so the GraphQL non-null contract
 * is not violated by a malformed row; nullable fields go to `null`.
 *
 * Returns `null` when the row is missing the bare-minimum fields that
 * make the projection meaningful (findingId + workflowId). The caller
 * skips and metricises in that case rather than emitting a hollow event.
 */
export function projectRow(
  row: Record<string, unknown>,
): PublishGovernanceFindingInput | null {
  const findingId = asString(row.findingId);
  const workflowId = asString(row.workflowId);
  if (!findingId || !workflowId) return null;

  return {
    findingId,
    workflowId,
    decision:
      typeof row.decision === 'string' ? row.decision : '',
    reason: typeof row.reason === 'string' ? row.reason : '',
    requestingAgent:
      typeof row.requesting_agent === 'string' ? row.requesting_agent : '',
    targetAgent:
      typeof row.target_agent === 'string' ? row.target_agent : '',
    scopeEvaluated: asString(row.scope_evaluated),
    contractEvaluated: asString(row.contract_evaluated),
    escalationTarget: asString(row.escalation_target),
    residualAuthorityDenial: asBool(row.residual_authority_denial),
    timestamp: asNumber(row.timestamp),
  };
}

async function emitFailureMetric(): Promise<void> {
  // Best-effort: a metric publish failure must not propagate. Logging
  // here is intentional so the post-mortem can correlate with the
  // earlier publish failure.
  try {
    await cwClient().send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: METRIC_PUBLISH_FAILURE,
            Value: 1,
            Unit: 'Count',
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (metricErr) {
    console.warn(
      'governance-finding-fanout: failed to emit PublishFailure metric',
      metricErr,
    );
  }
}

async function publishFinding(
  input: PublishGovernanceFindingInput,
): Promise<void> {
  const endpoint = process.env.APPSYNC_ENDPOINT;
  if (!endpoint) {
    throw new Error('APPSYNC_ENDPOINT env var is required');
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

  const signed = await signer().sign(request);

  const response = await fetch(`https://${url.hostname}${url.pathname}`, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!response.ok) {
    throw new Error(
      `AppSync publishGovernanceFinding failed: HTTP ${response.status}`,
    );
  }
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Skip non-INSERT records. The EventSourceMapping FilterCriteria already
  // narrows to INSERT, but a defence-in-depth check here keeps the Lambda
  // safe if the filter is ever loosened (e.g. for backfill replays).
  if (record.eventName !== 'INSERT') return;

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return;

  // unmarshall expects AttributeValue<...> shape; the cast bridges the
  // aws-lambda DynamoDBRecord type (which uses a slightly broader shape)
  // to the SDK shape. The unmarshall result is a plain JS object.
  const row = unmarshall(
    newImage as Record<string, DdbAttributeValue>,
  ) as Record<string, unknown>;

  const input = projectRow(row);
  if (!input) {
    console.warn(
      'governance-finding-fanout: skipping malformed ledger row',
      { keys: Object.keys(row) },
    );
    await emitFailureMetric();
    return;
  }

  await publishFinding(input);
}

export const handler: DynamoDBStreamHandler = async (
  event: DynamoDBStreamEvent,
) => {
  const records = event.Records ?? [];
  for (const record of records) {
    try {
      await processRecord(record);
    } catch (err) {
      // Best-effort: log and emit metric, but never throw. The ledger
      // write is authoritative; this fanout is soft-realtime only.
      console.error(
        'governance-finding-fanout: per-record failure',
        {
          eventName: record.eventName,
          eventID: record.eventID,
          err: err instanceof Error ? err.message : String(err),
        },
      );
      await emitFailureMetric();
    }
  }
  // No batchItemFailures — the handler always reports success so the
  // DDB stream pipeline does not redrive on transient AppSync errors.
};

/** Test-only: reset cached SDK clients between test cases. */
export function __resetForTest(): void {
  _cwClient = null;
  _signer = null;
}
