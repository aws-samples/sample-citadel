import { EventBridgeEvent } from 'aws-lambda';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

interface PlanningProgressDetail {
  sessionId: string;
  taskId: string;
  completionPercentage: number;
  timestamp: string;
}

export const handler = async (event: EventBridgeEvent<'planning.progress.updated', PlanningProgressDetail>) => {
  const { sessionId, taskId, completionPercentage } = event.detail;
  const appsyncEndpoint = process.env.APPSYNC_ENDPOINT!;
  const region = process.env.AWS_REGION || 'ap-southeast-2';

  const projectId = sessionId;

  const mutation = `
    mutation PublishPlanningProgress($input: PlanningProgressInput!) {
      publishPlanningProgress(input: $input) {
        projectId
        taskId
        completionPercentage
        timestamp
      }
    }
  `;

  const variables = {
    input: {
      projectId,
      taskId,
      completionPercentage,
      timestamp: event.detail.timestamp
    }
  };
  const body = JSON.stringify({ query: mutation, variables });

  const url = new URL(appsyncEndpoint);
  const request = new HttpRequest({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: url.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    service: 'appsync',
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const signedRequest = await signer.sign(request);

  const response = await fetch(appsyncEndpoint, {
    method: signedRequest.method,
    headers: signedRequest.headers,
    body: signedRequest.body,
  });

  if (!response.ok) {
    throw new Error(`AppSync mutation failed: ${response.statusText}`);
  }

  return { statusCode: 200 };
};
