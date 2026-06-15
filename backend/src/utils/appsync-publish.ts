/**
 * Utility for publishing AppSync mutations (e.g., for triggering subscriptions).
 * Uses AWS SigV4 signed HTTP requests to call @aws_iam mutations.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';

const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';

export interface AppStatusEventInput {
  appId: string;
  previousStatus: string;
  newStatus: string;
  timestamp: string;
}

/**
 * Calls the publishAppStatusEvent AppSync mutation to trigger onAppStatusChange subscriptions.
 * Uses IAM SigV4 signing since the mutation has @aws_iam authorization.
 * Best-effort — failures are logged but do not block the status transition.
 */
export async function publishAppStatusEvent(input: AppStatusEventInput): Promise<void> {
  if (!APPSYNC_ENDPOINT) {
    console.warn('APPSYNC_ENDPOINT not configured, skipping publishAppStatusEvent');
    return;
  }

  const mutation = `
    mutation PublishAppStatusEvent($input: AppStatusEventInput!) {
      publishAppStatusEvent(input: $input) {
        appId
        previousStatus
        newStatus
        timestamp
      }
    }
  `;

  const body = JSON.stringify({
    query: mutation,
    variables: { input },
  });

  try {
    const url = new URL(APPSYNC_ENDPOINT);

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
      region: AWS_REGION,
      service: 'appsync',
      sha256: Sha256,
    });

    const signed = await signer.sign(request);

    const response = await fetch(APPSYNC_ENDPOINT, {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('AppSync publishAppStatusEvent failed:', response.status, text);
    } else {
      console.log('AppSync publishAppStatusEvent succeeded for', input.appId);
    }
  } catch (error) {
    console.error('AppSync publishAppStatusEvent error (non-fatal):', error);
  }
}
