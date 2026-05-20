import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';

const sqsClient = new SQSClient({});
const FABRICATOR_QUEUE_URL = process.env.FABRICATOR_QUEUE_URL!;

interface CreateAgentRequest {
  agentName: string;
  taskDescription: string;
  tools?: string[];
  integrations?: string[];
  dataStores?: string[];
}

interface CreateToolRequest {
  toolName: string;
  toolDescription: string;
  integrations?: string[];
  dataStores?: string[];
}

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    if (fieldName === 'requestAgentCreation') {
      return await requestAgentCreation(event.arguments.input);
    }

    if (fieldName === 'requestToolCreation') {
      return await requestToolCreation(event.arguments.input);
    }

    throw new Error(`Unknown field: ${fieldName}`);
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

async function sendToFabricatorQueue(
  requestId: string,
  taskDetails: string,
  requestType: 'agent-creation' | 'tool-creation'
) {
  const fabricatorMessage = {
    orchestration_id: '0', // Direct request, not part of orchestration
    agent_use_id: requestId,
    node: 'fabricator',
    agent_input: {
      taskDetails,
    },
  };

  console.log('Sending message to Fabricator queue:', fabricatorMessage);

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: FABRICATOR_QUEUE_URL,
        MessageBody: JSON.stringify(fabricatorMessage),
        MessageAttributes: {
          requestType: {
            DataType: 'String',
            StringValue: requestType,
          },
          requestId: {
            DataType: 'String',
            StringValue: requestId,
          },
        },
      })
    );

    console.log('Message sent successfully to Fabricator queue');
  } catch (error) {
    console.error('Error sending message to Fabricator queue:', error);
    throw new Error(`Failed to send request to Fabricator: ${error}`);
  }
}

async function requestAgentCreation(input: CreateAgentRequest) {
  const requestId = randomUUID();

  // Build the task details with all the information
  let taskDetails = `Create an agent with the following specifications:

Agent Name: ${input.agentName}

Task Description:
${input.taskDescription}`;

  if (input.tools && input.tools.length > 0) {
    taskDetails += `\n\nRequired Tools:\n${input.tools.map(t => `- ${t}`).join('\n')}`;
  }

  if (input.integrations && input.integrations.length > 0) {
    taskDetails += `\n\nRequired Integrations:\n${input.integrations.map(i => `- ${i}`).join('\n')}`;
  }

  if (input.dataStores && input.dataStores.length > 0) {
    taskDetails += `\n\nRequired Data Stores:\n${input.dataStores.map(d => `- ${d}`).join('\n')}`;
  }

  await sendToFabricatorQueue(requestId, taskDetails, 'agent-creation');

  return {
    success: true,
    requestId,
    message: 'Agent creation request sent to Fabricator successfully',
  };
}

async function requestToolCreation(input: CreateToolRequest) {
  const requestId = randomUUID();

  // Build the task details for tool creation
  let taskDetails = `Create a tool with the following specifications:

Tool Name: ${input.toolName}

Tool Description:
${input.toolDescription}`;

  if (input.integrations && input.integrations.length > 0) {
    taskDetails += `\n\nRequired Integrations:\n${input.integrations.map(i => `- ${i}`).join('\n')}`;
  }

  if (input.dataStores && input.dataStores.length > 0) {
    taskDetails += `\n\nRequired Data Stores:\n${input.dataStores.map(d => `- ${d}`).join('\n')}`;
  }

  await sendToFabricatorQueue(requestId, taskDetails, 'tool-creation');

  return {
    success: true,
    requestId,
    message: 'Tool creation request sent to Fabricator successfully',
  };
}
