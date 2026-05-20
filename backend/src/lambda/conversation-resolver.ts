/**
 * Conversation Resolver Lambda
 * Handles sendMessage mutation - stores message and publishes to EventBridge
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { v4 as uuidv4 } from "uuid";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface ConversationMessageInput {
  agentId: string;
  message: string;
  messageType:
    | "USER_INPUT"
    | "AGENT_RESPONSE"
    | "SYSTEM_NOTIFICATION"
    | "PROGRESS_UPDATE";
  metadata?: string;
  correlationId?: string;
}

interface AppSyncEvent {
  arguments: {
    projectId: string;
    message: ConversationMessageInput;
  };
  identity: {
    sub: string;
    username?: string;
  };
  info: {
    fieldName: string;
  };
}

/**
 * Send message mutation handler
 */
async function sendMessage(event: AppSyncEvent) {
  const { projectId, message } = event.arguments;
  const userId = event.identity.sub;

  console.log("Sending message:", {
    projectId,
    agentId: message.agentId,
    userId,
  });

  // Create message record
  const messageId = uuidv4();
  const timestamp = new Date().toISOString();

  const messageRecord = {
    projectId,
    timestamp,
    id: messageId,
    agentId: message.agentId,
    message: message.message,
    messageType: message.messageType,
    userId,
    ...(message.metadata && { metadata: message.metadata }),
    ...(message.correlationId && { correlationId: message.correlationId }),
  };

  // Store in DynamoDB
  await docClient.send(
    new PutCommand({
      TableName: CONVERSATIONS_TABLE,
      Item: messageRecord,
    })
  );

  console.log("Message stored in DynamoDB:", messageRecord.id);

  // Publish to EventBridge (async - don't wait for agent)
  if (message.messageType === "USER_INPUT") {
    try {
      // Check if metadata is already an object or a string
      let parsedMetadata;
      if (message.metadata) {
        if (typeof message.metadata === 'string') {
          parsedMetadata = JSON.parse(message.metadata);
        } else {
          parsedMetadata = message.metadata;
        }
      }
      
      console.log('Publishing to EventBridge with metadata:', {
        metadataRaw: message.metadata,
        metadataType: typeof message.metadata,
        parsedMetadata,
        parsedType: typeof parsedMetadata,
      });

      await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: "citadel",
              DetailType: "message.sent_to_agent",
              Detail: JSON.stringify({
                projectId,
                agentId: message.agentId,
                message: message.message,
                messageId: messageRecord.id,
                userId,
                timestamp: messageRecord.timestamp,
                metadata: parsedMetadata,
              }),
              EventBusName: EVENT_BUS_NAME,
            },
          ],
        })
      );

      console.log("Event published to EventBridge");
    } catch (error) {
      console.error("Failed to publish to EventBridge:", error);
      // Don't fail the mutation - message is already stored
    }
  }

  // Return message immediately (frontend gets it right away)
  return messageRecord;
}

/**
 * Get conversation history query handler
 */
async function getConversationHistory(event: AppSyncEvent) {
  const { projectId, limit, nextToken } = event.arguments as any;

  console.log("Getting conversation history for project:", projectId);

  const effectiveLimit = Math.min(Math.max(limit || 50, 1), 200);

  const result = await docClient.send(
    new QueryCommand({
      TableName: CONVERSATIONS_TABLE,
      KeyConditionExpression: "projectId = :projectId",
      ExpressionAttributeValues: {
        ":projectId": projectId,
      },
      ScanIndexForward: false, // newest first for pagination
      Limit: effectiveLimit,
      ...(nextToken && {
        ExclusiveStartKey: JSON.parse(Buffer.from(nextToken, 'base64').toString()),
      }),
    })
  );

  const items = (result.Items || []).reverse(); // return in chronological order
  const responseNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : null;

  return { items, nextToken: responseNextToken };
}

/**
 * Publish conversation message mutation handler (IAM auth only)
 * Called by agent-message-handler Lambda to trigger subscriptions
 */
async function publishConversationMessage(event: AppSyncEvent) {
  const { input } = event.arguments as any;

  console.log("Publishing conversation message:", input.id);

  // Simply return the input - AppSync will trigger the subscription
  // The message is already stored in DynamoDB by agent-message-handler
  return input;
}

/**
 * Send message to agent (simplified interface for direct calls)
 */
async function sendMessageToAgent(event: AppSyncEvent) {
  const { projectId, agentId, message } = event.arguments as any;
  
  // Convert to sendMessage format
  const convertedEvent = {
    ...event,
    arguments: {
      projectId,
      message: {
        agentId,
        message,
        messageType: "USER_INPUT" as const,
      },
    },
  };
  
  return await sendMessage(convertedEvent as AppSyncEvent);
}

/**
 * Lambda handler
 */
export const handler = async (event: AppSyncEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    switch (event.info.fieldName) {
      case "sendMessage":
        return await sendMessage(event);
      case "sendMessageToAgent":
        return await sendMessageToAgent(event);
      case "getConversationHistory":
        return await getConversationHistory(event);
      case "publishConversationMessage":
        return await publishConversationMessage(event);
      default:
        throw new Error(`Unknown field: ${event.info.fieldName}`);
    }
  } catch (error) {
    console.error("Error handling request:", error);
    throw error;
  }
};
