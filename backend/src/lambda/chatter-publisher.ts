import { EventBridgeEvent } from 'aws-lambda';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const publishChatterMutation = `
  mutation PublishChatter($input: AgentChatterInput!) {
    publishChatter(input: $input) {
      id
      timestamp
      source
      detailType
      detail
    }
  }
`;

interface ChatterInput {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: any;
}

async function executeGraphQL(query: string, variables: any) {
  const endpoint = new URL(APPSYNC_ENDPOINT);
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: AWS_REGION,
    service: 'appsync',
    sha256: Sha256,
  });

  const requestToBeSigned = new HttpRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: endpoint.host,
    },
    hostname: endpoint.host,
    body: JSON.stringify({ query, variables }),
    path: endpoint.pathname,
  });

  const signed = await signer.sign(requestToBeSigned);
  const response = await fetch(APPSYNC_ENDPOINT, {
    method: 'POST',
    headers: signed.headers as HeadersInit,
    body: signed.body as string,
  });

  const result = await response.json();
  
  if (result.errors) {
    console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

export const handler = async (event: EventBridgeEvent<string, any>) => {
  console.log('Received EventBridge event:', JSON.stringify(event, null, 2));

  try {
    const chatterInput: ChatterInput = {
      id: event.id,
      timestamp: event.time,
      source: event.source,
      detailType: event['detail-type'],
      detail: JSON.stringify(event.detail), // Convert to JSON string for AWSJSON type
    };

    console.log('Publishing chatter message:', JSON.stringify(chatterInput, null, 2));

    const result = await executeGraphQL(publishChatterMutation, {
      input: chatterInput,
    });

    console.log('Successfully published chatter message:', JSON.stringify(result, null, 2));

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result }),
    };
  } catch (error) {
    console.error('Error publishing chatter message:', error);
    throw error;
  }
};
