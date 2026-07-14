import { EventBridgeHandler } from 'aws-lambda';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

const MUTATION = `
  mutation PublishWorkflowProgress($input: WorkflowProgressInput!) {
    publishWorkflowProgress(input: $input) {
      executionId
      workflowId
      eventType
      nodeId
      status
      output
      error
      timestamp
    }
  }
`;

// Shared workflow metric namespace + failure metric name. Kept in sync with the
// arbiter step runner / worker emitters so all workflow telemetry lands in one
// namespace.
const METRIC_NAMESPACE = 'Citadel/Workflows';
const FAILURE_METRIC_NAME = 'FanoutPublishFailure';

let _cw: CloudWatchClient | null = null;
function cwClient(): CloudWatchClient {
  if (!_cw) _cw = new CloudWatchClient({});
  return _cw;
}

/**
 * Best-effort emission of a fan-out publish-failure metric. Never throws —
 * telemetry must not mask (or replace) the underlying publish failure that the
 * caller is about to surface by re-throwing.
 */
async function emitPublishFailureMetric(eventType: string): Promise<void> {
  try {
    await cwClient().send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: FAILURE_METRIC_NAME,
            Value: 1,
            Unit: 'Count',
            Dimensions: [{ Name: 'EventType', Value: eventType || 'unknown' }],
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (err) {
    console.error('workflow-progress-fanout: failure-metric emit failed', err);
  }
}

export const handler: EventBridgeHandler<string, any, void> = async (event) => {
  const detail = event.detail;
  const detailType = event['detail-type'];

  const input = {
    executionId: detail.executionId,
    workflowId: detail.workflowId,
    eventType: detailType,
    nodeId: detail.nodeId || null,
    status: detail.status || null,
    output: detail.output ? JSON.stringify(detail.output) : null,
    error: detail.error || null,
    timestamp: detail.timestamp || new Date().toISOString(),
  };

  const endpoint = process.env.APPSYNC_ENDPOINT!;
  const url = new URL(endpoint);
  const body = JSON.stringify({
    query: MUTATION,
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

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: process.env.AWS_REGION || 'us-east-1',
    service: 'appsync',
    sha256: Sha256,
  });

  const signedRequest = await signer.sign(request);

  const response = await fetch(`https://${url.hostname}${url.pathname}`, {
    method: 'POST',
    headers: signedRequest.headers as Record<string, string>,
    body,
  });

  // AppSync signals a failed publish two ways: a non-2xx HTTP status, OR an
  // HTTP 200 whose GraphQL body carries a non-empty `errors` array (e.g. an
  // unauthorized/resolver error on the publishWorkflowProgress mutation). Both
  // must be treated as failures so partial GraphQL errors surface and alarm
  // rather than being silently swallowed.
  let graphQLErrors: unknown;
  if (response.ok) {
    try {
      const payload = (await response.json()) as { errors?: unknown };
      graphQLErrors = payload?.errors;
    } catch {
      // Body was not JSON — HTTP status is already OK, so treat as success.
      graphQLErrors = undefined;
    }
  }
  const hasGraphQLErrors =
    Array.isArray(graphQLErrors) && graphQLErrors.length > 0;

  if (!response.ok || hasGraphQLErrors) {
    const reason = !response.ok
      ? `HTTP ${response.status}`
      : `GraphQL errors: ${JSON.stringify(graphQLErrors)}`;

    // Structured failure log keyed by executionId for cross-service
    // correlation (matches the arbiter-side executionId log convention).
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'workflow-progress-fanout publish failed',
        executionId: input.executionId,
        workflowId: input.workflowId,
        eventType: input.eventType,
        reason,
      }),
    );

    await emitPublishFailureMetric(input.eventType);

    throw new Error(`AppSync mutation failed: ${reason}`);
  }
};
