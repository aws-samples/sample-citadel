import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type { RegistryRecord } from '../services/registry-service';
import { extractOrgFromEvent } from '../utils/auth-event';

const sqsClient = new SQSClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const FABRICATOR_QUEUE_URL = process.env.FABRICATOR_QUEUE_URL!;
// Optional — when set, we look up the app row to pull its
// sourceProjectId and forward it into agent_input.projectId. If the env var
// is unset, we skip the lookup entirely and the fabricator gate stays a no-op,
// which preserves backward compatibility for environments that haven't wired
// the apps table into this resolver yet. Read at call-time (not module-load
// time) so unit tests can toggle the env var per case.
function getAppsTable(): string | undefined {
  return process.env.APPS_TABLE;
}

/**
 * Extract the governance sourceProjectId (branch's AgentApp.sourceProjectId
 * field) from the registry record's customDescriptorContent JSON. Used by
 * the fabricator design-assessment gate when resolving projectId from an
 * appId that has already been migrated to the registry.
 *
 * PR 6a: inlined here from the deleted `agent-record-factory.ts` module.
 * Kept as a file-private helper to avoid re-introducing a cross-module
 * dependency; the `projectIdFromRegistryRecord` surface is used by this
 * resolver only.
 */
function projectIdFromRegistryRecord(
  record: RegistryRecord,
): string | undefined {
  if (!record.customDescriptorContent) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(record.customDescriptorContent);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof parsed.sourceProjectId === 'string'
    ) {
      return parsed.sourceProjectId;
    }
  } catch {
    // Malformed JSON — treat as absent.
  }
  return undefined;
}

interface CreateAgentRequest {
  agentName: string;
  taskDescription: string;
  tools?: string[];
  integrations?: string[];
  dataStores?: string[];
  appId?: string;
}

interface CreateToolRequest {
  toolName: string;
  toolDescription: string;
  integrations?: string[];
  dataStores?: string[];
  appId?: string;
}

/**
 * Extract the AppSync caller's user id from the event identity.
 *
 * AppSync `event.identity` shape varies by auth mode:
 *  - Cognito (AppSyncIdentityCognito): has `sub` (JWT sub) and `username`.
 *  - IAM (AppSyncIdentityIAM): has `username` but no `sub`.
 *  - API key / no identity: `event.identity` is undefined.
 *
 * We check property presence rather than relying on a specific type so both
 * Cognito and IAM callers are attributed correctly. Falls back to
 * `'unknown'` when no identity is available. The value is forwarded to the
 * Python fabricator via `requested_by` on the SQS body, where it becomes
 * `createdBy` on the Registry record.
 */
function extractRequestedBy(event: any): string {
  return (
    (event.identity && ('sub' in event.identity ? event.identity.sub : undefined)) ||
    (event.identity && ('username' in event.identity ? event.identity.username : undefined)) ||
    'unknown'
  );
}

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;
  const requestedBy = extractRequestedBy(event);
  // Phase 2b: thread the caller's orgId so the fabricator can stamp it into
  // custom metadata. Null is acceptable during the transition — the Python
  // side falls back to '' rather than blocking fabrication.
  const orgId = await extractOrgFromEvent(event);

  try {
    if (fieldName === 'requestAgentCreation') {
      return await requestAgentCreation(event.arguments.input, requestedBy, orgId);
    }

    if (fieldName === 'requestToolCreation') {
      return await requestToolCreation(event.arguments.input, requestedBy, orgId);
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
  requestType: 'agent-creation' | 'tool-creation',
  requestedBy: string,
  orgId: string | null,
  sourceProjectId?: string,
) {
  const agent_input: Record<string, any> = { taskDetails };
  if (sourceProjectId) {
    // Picked up by arbiter/fabricator/index.py:928 where the
    // design_assessment_gate enforces preconditions.
    agent_input.projectId = sourceProjectId;
  }

  const fabricatorMessage = {
    orchestration_id: '0', // Direct request, not part of orchestration
    agent_use_id: requestId,
    node: 'fabricator',
    agent_input,
    requested_by: requestedBy,
    // Phase 2b: carry caller org through the SQS boundary. Python fabricator
    // falls back to '' when this is null, so no blocking during transition.
    org_id: orgId || null,
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

/**
 * Look up the source project id for an app, if any.
 * Degraded-mode safe: returns undefined on any failure and logs a warning.
 * A missing projectId means the fabricator design-assessment gate is a no-op,
 * which is the forward-compatible default.
 */
async function resolveSourceProjectId(appId?: string): Promise<string | undefined> {
  if (!appId) return undefined;
  const appsTable = getAppsTable();
  if (!appsTable) {
    console.warn('APPS_TABLE env var unset; skipping sourceProjectId lookup for app', appId);
    return undefined;
  }
  try {
    const result = await docClient.send(new GetCommand({
      TableName: appsTable,
      Key: { appId },
    }));
    const row = result.Item;
    if (!row) {
      console.warn('App row not found for sourceProjectId lookup:', appId);
      return undefined;
    }
    return row.sourceProjectId || undefined;
  } catch (error) {
    console.warn('Failed to look up sourceProjectId for app (continuing without):', appId, error);
    return undefined;
  }
}

async function requestAgentCreation(input: CreateAgentRequest, requestedBy: string, orgId: string | null) {
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

  const sourceProjectId = await resolveSourceProjectId(input.appId);
  await sendToFabricatorQueue(requestId, taskDetails, 'agent-creation', requestedBy, orgId, sourceProjectId);

  return {
    success: true,
    requestId,
    message: 'Agent creation request sent to Fabricator successfully',
  };
}

async function requestToolCreation(input: CreateToolRequest, requestedBy: string, orgId: string | null) {
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

  const sourceProjectId = await resolveSourceProjectId(input.appId);
  await sendToFabricatorQueue(requestId, taskDetails, 'tool-creation', requestedBy, orgId, sourceProjectId);

  return {
    success: true,
    requestId,
    message: 'Tool creation request sent to Fabricator successfully',
  };
}
