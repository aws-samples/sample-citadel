import { AppSyncResolverEvent } from "aws-lambda";

export interface AgentChatterInput {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: unknown;
  orgId: string;
}

export interface AgentChatterMessage {
  id: string;
  timestamp: string;
  source: string;
  detailType: string;
  detail: unknown;
  orgId: string;
}

export const handler = async (
  event: AppSyncResolverEvent<{ input: AgentChatterInput }>,
): Promise<AgentChatterMessage> => {
  console.log("Chatter resolver event:", JSON.stringify(event, null, 2));

  const { input } = event.arguments;

  // Wave-2a tenancy (finding 87a171ad): fail closed — never publish
  // chatter without orgId. AppSync's onChatter(orgId: ID!) implicit
  // subscription filter has nothing to filter on for an org-less
  // message, which would otherwise broadcast to every subscriber.
  if (!input.orgId) {
    throw new Error(
      "publishChatter refused: missing orgId on AgentChatterInput",
    );
  }

  // Simply pass through the message to subscribers
  const message: AgentChatterMessage = {
    id: input.id,
    timestamp: input.timestamp,
    source: input.source,
    detailType: input.detailType,
    detail: input.detail,
    orgId: input.orgId,
  };

  console.log("Publishing chatter message:", JSON.stringify(message, null, 2));

  return message;
};
