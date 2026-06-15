import { EventBridgeHandler } from 'aws-lambda';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

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

  if (!response.ok) {
    throw new Error(`AppSync mutation failed: ${response.status}`);
  }
};
