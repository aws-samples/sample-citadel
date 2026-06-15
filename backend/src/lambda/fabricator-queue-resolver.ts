import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { AppSyncResolverEvent } from 'aws-lambda';

const sqs = new SQSClient({});
const FABRICATOR_QUEUE_URL = process.env.FABRICATOR_QUEUE_URL!;

interface FabricationQueueItem {
  requestId: string;
  agentName: string;
  taskDescription: string;
  status: 'PENDING' | 'PROCESSING';
  submittedAt: string;
  metadata?: Record<string, any>;
}

export const handler = async (
  event: AppSyncResolverEvent<any>
): Promise<FabricationQueueItem[]> => {
  console.log('Querying fabricator queue:', JSON.stringify(event, null, 2));

  try {
    // Receive messages from SQS without removing them
    const command = new ReceiveMessageCommand({
      QueueUrl: FABRICATOR_QUEUE_URL,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 0, // Don't hide messages
      AttributeNames: ['All'],
    });

    const response = await sqs.send(command);
    const messages = response.Messages || [];

    console.log(`Retrieved ${messages.length} messages from queue`);

    // Parse and format queue items
    const queueItems: FabricationQueueItem[] = messages.map(message => {
      const body = JSON.parse(message.Body || '{}');
      const agentInput = body.agent_input || {};
      const sentTimestamp = message.Attributes?.SentTimestamp;
      const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '0');

      // Extract agent name from task details (first word or fallback)
      const taskDetails = agentInput.taskDetails || '';
      const agentName = taskDetails.split(' ')[0] || 'Unknown Agent';

      return {
        requestId: body.orchestration_id || message.MessageId || '',
        agentName,
        taskDescription: taskDetails || 'No description',
        status: receiveCount > 0 ? 'PROCESSING' : 'PENDING',
        submittedAt: sentTimestamp 
          ? new Date(parseInt(sentTimestamp)).toISOString()
          : new Date().toISOString(),
        metadata: {
          messageId: message.MessageId,
          receiveCount,
        },
      };
    });

    console.log(`Formatted ${queueItems.length} queue items`);
    return queueItems;
  } catch (error) {
    console.error('Error querying fabricator queue:', error);
    // Return empty array on failure as per requirements
    return [];
  }
};
