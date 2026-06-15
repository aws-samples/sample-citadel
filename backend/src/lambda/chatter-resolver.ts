import { AppSyncResolverEvent } from 'aws-lambda';

interface AgentChatterInput {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: any;
}

interface AgentChatterMessage {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: any;
}

export const handler = async (
  event: AppSyncResolverEvent<{ input: AgentChatterInput }>
): Promise<AgentChatterMessage> => {
  console.log('Chatter resolver event:', JSON.stringify(event, null, 2));

  const { input } = event.arguments;

  // Simply pass through the message to subscribers
  const message: AgentChatterMessage = {
    id: input.id,
    timestamp: input.timestamp,
    source: input.source,
    detailType: input.detailType,
    detail: input.detail,
  };

  console.log('Publishing chatter message:', JSON.stringify(message, null, 2));

  return message;
};
