import { EventBridgeEvent } from 'aws-lambda';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

interface DesignProgressDetail {
  sessionId: string;
  sectionId: string;
  completionPercentage: number;
  timestamp: string;
}

export const handler = async (event: EventBridgeEvent<'design.progress.updated', DesignProgressDetail>) => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const { sessionId, sectionId, completionPercentage } = event.detail;
  const appsyncEndpoint = process.env.APPSYNC_ENDPOINT!;
  const region = process.env.AWS_REGION || 'ap-southeast-2';
  
  console.log('Processing:', { sessionId, sectionId, completionPercentage });

  const projectId = sessionId;

  const mutation = `
    mutation PublishDesignProgress($input: DesignProgressInput!) {
      publishDesignProgress(input: $input) {
        projectId
        sectionId
        completionPercentage
        timestamp
      }
    }
  `;

  const variables = {
    input: {
      projectId,
      sectionId,
      completionPercentage,
      timestamp: new Date(event.detail.timestamp).toISOString()
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

  const responseText = await response.text();
  console.log('AppSync response status:', response.status);
  console.log('AppSync response body:', responseText);

  if (!response.ok) {
    throw new Error(`AppSync mutation failed: ${response.statusText} - ${responseText}`);
  }

  console.log('Successfully published design progress');
  return { statusCode: 200, body: responseText };
};
