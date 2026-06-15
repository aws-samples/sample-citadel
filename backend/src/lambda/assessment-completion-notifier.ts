import { EventBridgeEvent } from 'aws-lambda';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

interface AssessmentCompletedDetail {
  sessionId: string;
  projectId: string;
  allDimensionsComplete: boolean;
  timestamp: string;
}

export const handler = async (event: EventBridgeEvent<'assessment.completed', AssessmentCompletedDetail>) => {
  const { projectId } = event.detail;
  const appsyncEndpoint = process.env.APPSYNC_ENDPOINT!;
  const region = process.env.AWS_REGION || 'ap-southeast-2';

  const mutation = `
    mutation PublishAssessmentCompletion($projectId: ID!) {
      publishAssessmentCompletion(projectId: $projectId) {
        projectId
        allDimensionsComplete
        timestamp
      }
    }
  `;

  const variables = { projectId };
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
