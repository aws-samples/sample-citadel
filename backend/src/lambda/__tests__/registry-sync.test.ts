/**
 * Tests for registry-sync Lambda — event validation, routing, and cache operations
 */

// Set env vars before importing the module
process.env.AGENT_CONFIG_TABLE = 'test-agents-table';
process.env.TOOLS_CONFIG_TABLE = 'test-tools-table';
process.env.REGISTRY_ID = 'test-registry-id';
process.env.DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-dlq';

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

import {
  handler,
  validateEvent,
  getTableForResourceType,
  toInternalState,
  deserializeCustomMetadata,
  buildAgentCacheRecord,
  buildToolCacheRecord,
  handleCreateOrUpdate,
  handleDelete,
  handleStatusChanged,
  sendToDlq,
  emitSyncFailureMetric,
} from '../registry-sync';
import type { RegistryEvent, RegistryResourcePayload, ResourceType } from '../registry-sync';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  cwMock.reset();
  // Default: SQS and CloudWatch succeed
  sqsMock.on(SendMessageCommand).resolves({});
  cwMock.on(PutMetricDataCommand).resolves({});
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Loosely-typed overrides so tests can build deliberately malformed events. */
interface EventOverrides {
  source?: string;
  'detail-type'?: string;
  detail?: Record<string, unknown>;
}

function makeEvent(overrides: EventOverrides = {}): RegistryEvent {
  return {
    source: 'aws.bedrock-agentcore',
    'detail-type': 'AgentCore Registry Resource Change',
    detail: {
      resourceId: 'res-123',
      resourceType: 'agent',
      eventType: 'CREATED',
      resource: { name: 'TestAgent' },
      ...overrides.detail,
    },
    ...overrides,
    ...(overrides.detail ? { detail: { ...makeEvent().detail, ...overrides.detail } } : {}),
  } as RegistryEvent;
}

function makeAgentResource(overrides: RegistryResourcePayload = {}): RegistryResourcePayload {
  return {
    description: JSON.stringify({ name: 'TestAgent', filename: 'test.py' }),
    customDescriptorContent: JSON.stringify({
      categories: ['cat1'],
      icon: 'icon.png',
      state: 'active',
      appId: 'app-1',
      manifest: { name: 'TestAgent', version: '1.0', description: 'A test agent' },
    }),
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeToolResource(overrides: RegistryResourcePayload = {}): RegistryResourcePayload {
  return {
    description: JSON.stringify({ name: 'TestTool', filename: 'tool.py' }),
    customDescriptorContent: JSON.stringify({
      categories: ['toolcat'],
      icon: 'tool-icon.png',
      state: 'active',
      integrationBindings: [{ integrationId: 'int-1', integrationType: 'REST' }],
      dataStoreBindings: [{ dataStoreId: 'ds-1', dataStoreType: 'S3' }],
      appId: 'app-2',
    }),
    createdAt: '2024-02-01T00:00:00.000Z',
    updatedAt: '2024-02-02T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateEvent (from task 4.1 — preserved)
// ---------------------------------------------------------------------------

describe('validateEvent', () => {
  test('returns null for a valid event', () => {
    expect(validateEvent(makeEvent())).toBeNull();
  });

  test('rejects null event', () => {
    expect(validateEvent(null)).toBe('Event is null or undefined');
  });

  test('rejects wrong source', () => {
    expect(validateEvent(makeEvent({ source: 'aws.s3' }))).toContain('Unexpected event source');
  });

  test('rejects wrong detail-type', () => {
    expect(validateEvent(makeEvent({ 'detail-type': 'SomethingElse' }))).toContain('Unexpected detail-type');
  });

  test('rejects missing detail', () => {
    const event = { source: 'aws.bedrock-agentcore', 'detail-type': 'AgentCore Registry Resource Change' };
    expect(validateEvent(event)).toBe('Event detail is missing');
  });

  test('rejects missing resourceId', () => {
    const event = makeEvent({ detail: { resourceId: '', resourceType: 'agent', eventType: 'CREATED' } });
    expect(validateEvent(event)).toContain('resourceId');
  });

  test('rejects invalid resourceType', () => {
    const event = makeEvent({ detail: { resourceId: 'r1', resourceType: 'widget', eventType: 'CREATED' } });
    expect(validateEvent(event)).toContain('Invalid resourceType');
  });

  test('rejects invalid eventType', () => {
    const event = makeEvent({ detail: { resourceId: 'r1', resourceType: 'agent', eventType: 'EXPLODED' } });
    expect(validateEvent(event)).toContain('Invalid eventType');
  });

  test('accepts all valid eventTypes', () => {
    for (const eventType of ['CREATED', 'UPDATED', 'DELETED', 'STATUS_CHANGED']) {
      const event = makeEvent({ detail: { resourceId: 'r1', resourceType: 'agent', eventType } });
      expect(validateEvent(event)).toBeNull();
    }
  });

  test('accepts both agent and tool resourceTypes', () => {
    for (const resourceType of ['agent', 'tool']) {
      const event = makeEvent({ detail: { resourceId: 'r1', resourceType, eventType: 'CREATED' } });
      expect(validateEvent(event)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// getTableForResourceType (from task 4.1 — preserved)
// ---------------------------------------------------------------------------

describe('getTableForResourceType', () => {
  test('routes agent to AGENT_CONFIG_TABLE', () => {
    expect(getTableForResourceType('agent')).toBe('test-agents-table');
  });

  test('routes tool to TOOLS_CONFIG_TABLE', () => {
    expect(getTableForResourceType('tool')).toBe('test-tools-table');
  });

  test('throws for unknown resourceType', () => {
    expect(() => getTableForResourceType('widget' as unknown as ResourceType)).toThrow('Unknown resourceType');
  });
});

// ---------------------------------------------------------------------------
// toInternalState
// ---------------------------------------------------------------------------

describe('toInternalState', () => {
  test('maps APPROVED to active', () => {
    expect(toInternalState('APPROVED')).toBe('active');
  });

  test('maps DEPRECATED to inactive', () => {
    expect(toInternalState('DEPRECATED')).toBe('inactive');
  });

  test('maps DRAFT to maintenance', () => {
    expect(toInternalState('DRAFT')).toBe('maintenance');
  });

  test('maps PENDING_APPROVAL to pending', () => {
    expect(toInternalState('PENDING_APPROVAL')).toBe('pending');
  });

  test('maps unknown status to inactive with warning', () => {
    expect(toInternalState('UNKNOWN_STATUS')).toBe('inactive');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown registry status'),
    );
  });
});

// ---------------------------------------------------------------------------
// deserializeCustomMetadata
// ---------------------------------------------------------------------------

describe('deserializeCustomMetadata', () => {
  const defaults = { categories: [] as string[], icon: '', state: 'active' };

  test('returns defaults for null input', () => {
    expect(deserializeCustomMetadata(null, defaults)).toEqual(defaults);
  });

  test('returns defaults for empty string', () => {
    expect(deserializeCustomMetadata('', defaults)).toEqual(defaults);
  });

  test('returns defaults for invalid JSON', () => {
    expect(deserializeCustomMetadata('not-json', defaults)).toEqual(defaults);
  });

  test('returns defaults for JSON array', () => {
    expect(deserializeCustomMetadata('[1,2]', defaults)).toEqual(defaults);
  });

  test('merges valid JSON with defaults', () => {
    const result = deserializeCustomMetadata(
      JSON.stringify({ categories: ['a'], icon: 'x' }),
      defaults,
    );
    expect(result).toEqual({ categories: ['a'], icon: 'x', state: 'active' });
  });

  test('overrides all defaults when all fields present', () => {
    const result = deserializeCustomMetadata(
      JSON.stringify({ categories: ['b'], icon: 'y', state: 'inactive' }),
      defaults,
    );
    expect(result).toEqual({ categories: ['b'], icon: 'y', state: 'inactive' });
  });
});

// ---------------------------------------------------------------------------
// buildAgentCacheRecord
// ---------------------------------------------------------------------------

describe('buildAgentCacheRecord', () => {
  test('maps all fields from resource with custom metadata', () => {
    const resource = makeAgentResource();
    const record = buildAgentCacheRecord('agent-1', resource);

    expect(record.agentId).toBe('agent-1');
    expect(record.config).toBe(resource.description);
    expect(record.state).toBe('active');
    expect(record.categories).toEqual(['cat1']);
    expect(record.icon).toBe('icon.png');
    expect(record.appId).toBe('app-1');
    expect(record.manifest).toEqual({ name: 'TestAgent', version: '1.0', description: 'A test agent' });
    expect(record.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(record.updatedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  test('uses defaults when custom metadata is missing', () => {
    const resource = { description: 'desc' };
    const record = buildAgentCacheRecord('agent-2', resource);

    expect(record.agentId).toBe('agent-2');
    expect(record.config).toBe('desc');
    expect(record.state).toBe('active');
    expect(record.categories).toEqual([]);
    expect(record.icon).toBe('');
    expect(record.appId).toBeUndefined();
    expect(record.manifest).toBeUndefined();
  });

  test('generates timestamps when not provided', () => {
    const record = buildAgentCacheRecord('agent-3', {});
    expect(record.createdAt).toBeDefined();
    expect(record.updatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildToolCacheRecord
// ---------------------------------------------------------------------------

describe('buildToolCacheRecord', () => {
  test('maps all fields from resource with custom metadata', () => {
    const resource = makeToolResource();
    const record = buildToolCacheRecord('tool-1', resource);

    expect(record.toolId).toBe('tool-1');
    expect(record.config).toBe(resource.description);
    expect(record.state).toBe('active');
    expect(record.categories).toEqual(['toolcat']);
    expect(record.icon).toBe('tool-icon.png');
    expect(record.integrationBindings).toEqual([{ integrationId: 'int-1', integrationType: 'REST' }]);
    expect(record.dataStoreBindings).toEqual([{ dataStoreId: 'ds-1', dataStoreType: 'S3' }]);
    expect(record.appId).toBe('app-2');
    expect(record.createdAt).toBe('2024-02-01T00:00:00.000Z');
    expect(record.updatedAt).toBe('2024-02-02T00:00:00.000Z');
  });

  test('uses defaults when custom metadata is missing', () => {
    const resource = { description: 'tool-desc' };
    const record = buildToolCacheRecord('tool-2', resource);

    expect(record.toolId).toBe('tool-2');
    expect(record.state).toBe('active');
    expect(record.categories).toEqual([]);
    expect(record.integrationBindings).toBeUndefined();
    expect(record.dataStoreBindings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleCreateOrUpdate
// ---------------------------------------------------------------------------

describe('handleCreateOrUpdate', () => {
  test('sends PutCommand for agent CREATED with conditional write', async () => {
    ddbMock.on(PutCommand).resolves({});

    const resource = makeAgentResource();
    await handleCreateOrUpdate('test-agents-table', 'agent', 'agent-1', resource);

    const call = ddbMock.commandCalls(PutCommand)[0];
    const input = call.args[0].input;

    expect(input.TableName).toBe('test-agents-table');
    expect(input.Item!.agentId).toBe('agent-1');
    expect(input.ConditionExpression).toContain('attribute_not_exists');
    expect(input.ConditionExpression).toContain('#updatedAt < :newUpdatedAt');
  });

  test('sends PutCommand for tool CREATED with correct key', async () => {
    ddbMock.on(PutCommand).resolves({});

    const resource = makeToolResource();
    await handleCreateOrUpdate('test-tools-table', 'tool', 'tool-1', resource);

    const call = ddbMock.commandCalls(PutCommand)[0];
    const input = call.args[0].input;

    expect(input.TableName).toBe('test-tools-table');
    expect(input.Item!.toolId).toBe('tool-1');
    expect(input.ExpressionAttributeNames!['#key']).toBe('toolId');
  });

  test('sends PutCommand for UPDATED event (same logic as CREATED)', async () => {
    ddbMock.on(PutCommand).resolves({});

    const resource = makeAgentResource({ updatedAt: '2024-06-01T00:00:00.000Z' });
    await handleCreateOrUpdate('test-agents-table', 'agent', 'agent-1', resource);

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item!.updatedAt).toBe('2024-06-01T00:00:00.000Z');
  });

  test('propagates DynamoDB errors (non-conditional)', async () => {
    const error = new Error('DynamoDB failure');
    error.name = 'InternalServerError';
    ddbMock.on(PutCommand).rejects(error);

    await expect(
      handleCreateOrUpdate('test-agents-table', 'agent', 'agent-1', makeAgentResource()),
    ).rejects.toThrow('DynamoDB failure');
  });
});

// ---------------------------------------------------------------------------
// handleDelete
// ---------------------------------------------------------------------------

describe('handleDelete', () => {
  test('sends DeleteCommand for agent with correct key', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    await handleDelete('test-agents-table', 'agent', 'agent-1');

    const call = ddbMock.commandCalls(DeleteCommand)[0];
    const input = call.args[0].input;

    expect(input.TableName).toBe('test-agents-table');
    expect(input.Key).toEqual({ agentId: 'agent-1' });
  });

  test('sends DeleteCommand for tool with correct key', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    await handleDelete('test-tools-table', 'tool', 'tool-1');

    const call = ddbMock.commandCalls(DeleteCommand)[0];
    expect(call.args[0].input.Key).toEqual({ toolId: 'tool-1' });
  });

  test('propagates DynamoDB errors', async () => {
    ddbMock.on(DeleteCommand).rejects(new Error('Delete failed'));

    await expect(handleDelete('test-agents-table', 'agent', 'a-1')).rejects.toThrow('Delete failed');
  });
});

// ---------------------------------------------------------------------------
// handleStatusChanged
// ---------------------------------------------------------------------------

describe('handleStatusChanged', () => {
  test('sends UpdateCommand with mapped state for APPROVED', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged('test-agents-table', 'agent', 'agent-1', 'APPROVED');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    expect(input.TableName).toBe('test-agents-table');
    expect(input.Key).toEqual({ agentId: 'agent-1' });
    expect(input.ExpressionAttributeValues![':newState']).toBe('active');
    expect(input.ConditionExpression).toContain('attribute_exists');
    expect(input.ConditionExpression).toContain('#state <> :newState');
  });

  test('maps DEPRECATED to inactive', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged('test-tools-table', 'tool', 'tool-1', 'DEPRECATED');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':newState']).toBe('inactive');
    expect(call.args[0].input.Key).toEqual({ toolId: 'tool-1' });
  });

  test('maps DRAFT to maintenance', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged('test-agents-table', 'agent', 'a-1', 'DRAFT');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':newState']).toBe('maintenance');
  });

  test('maps unknown status to inactive', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged('test-agents-table', 'agent', 'a-1', 'SOME_UNKNOWN');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':newState']).toBe('inactive');
  });

  test('updates updatedAt timestamp', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handleStatusChanged('test-agents-table', 'agent', 'a-1', 'APPROVED');

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.UpdateExpression).toContain('#updatedAt');
    expect(call.args[0].input.ExpressionAttributeValues![':now']).toBeDefined();
  });

  test('propagates DynamoDB errors (non-conditional)', async () => {
    const error = new Error('Update failed');
    error.name = 'InternalServerError';
    ddbMock.on(UpdateCommand).rejects(error);

    await expect(
      handleStatusChanged('test-agents-table', 'agent', 'a-1', 'APPROVED'),
    ).rejects.toThrow('Update failed');
  });
});

// ---------------------------------------------------------------------------
// handler — full integration with DynamoDB mock
// ---------------------------------------------------------------------------

describe('handler — cache operations', () => {
  test('CREATED agent event writes to DynamoDB', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: makeAgentResource(),
      },
    });

    await handler(event);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.TableName).toBe('test-agents-table');
    expect(input.Item!.agentId).toBe('agent-1');
  });

  test('UPDATED tool event writes to DynamoDB', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent({
      detail: {
        resourceId: 'tool-1',
        resourceType: 'tool',
        eventType: 'UPDATED',
        resource: makeToolResource(),
      },
    });

    await handler(event);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.TableName).toBe('test-tools-table');
    expect(input.Item!.toolId).toBe('tool-1');
  });

  test('DELETED event sends DeleteCommand', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'DELETED',
      },
    });

    await handler(event);

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ agentId: 'agent-1' });
  });

  test('STATUS_CHANGED event sends UpdateCommand', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'STATUS_CHANGED',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
      },
    });

    await handler(event);

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':newState']).toBe('active');
  });

  test('CREATED event without resource payload skips write', async () => {
    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: undefined,
      },
    });

    await handler(event);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No resource payload'));
  });

  test('STATUS_CHANGED event without newStatus skips update', async () => {
    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'STATUS_CHANGED',
        newStatus: undefined,
      },
    });

    await handler(event);

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No newStatus'));
  });

  test('ConditionalCheckFailedException is swallowed (idempotency)', async () => {
    const error = new Error('Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: makeAgentResource(),
      },
    });

    // Should not throw
    await expect(handler(event)).resolves.toBeUndefined();
  });

  test('ConditionalCheckFailedException on STATUS_CHANGED is swallowed', async () => {
    const error = new Error('Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'STATUS_CHANGED',
        newStatus: 'APPROVED',
      },
    });

    await expect(handler(event)).resolves.toBeUndefined();
  });

  test('non-conditional DynamoDB errors propagate and route to DLQ', async () => {
    const error = new Error('DynamoDB is down');
    error.name = 'InternalServerError';
    ddbMock.on(PutCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: makeAgentResource(),
      },
    });

    await expect(handler(event)).rejects.toThrow('DynamoDB is down');
    // DLQ and metric are verified in the dedicated DLQ routing tests
  });

  test('malformed event sends to DLQ then throws', async () => {
    const badEvent = { source: 'aws.s3', 'detail-type': 'wrong', detail: {} } as unknown as RegistryEvent;
    await expect(handler(badEvent)).rejects.toThrow('Malformed registry sync event');

    // Verify DLQ was called
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    const sqsInput = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(sqsInput.QueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456789/test-dlq');
    const body = JSON.parse(sqsInput.MessageBody!);
    expect(body.reason).toContain('Malformed event');
  });
});

// ---------------------------------------------------------------------------
// sendToDlq
// ---------------------------------------------------------------------------

describe('sendToDlq', () => {
  test('sends event and reason to SQS', async () => {
    const event = { foo: 'bar' };
    await sendToDlq(event, 'test reason');

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    const input = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(input.QueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456789/test-dlq');
    const body = JSON.parse(input.MessageBody!);
    expect(body.event).toEqual({ foo: 'bar' });
    expect(body.reason).toBe('test reason');
    expect(body.timestamp).toBeDefined();
  });

  test('does not throw when SQS fails', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS down'));
    await expect(sendToDlq({}, 'reason')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      'Failed to send event to DLQ:',
      expect.any(Error),
    );
  });
});

// ---------------------------------------------------------------------------
// emitSyncFailureMetric
// ---------------------------------------------------------------------------

describe('emitSyncFailureMetric', () => {
  test('emits SyncFailure metric to CloudWatch', async () => {
    await emitSyncFailureMetric();

    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
    const input = cwMock.commandCalls(PutMetricDataCommand)[0].args[0].input;
    expect(input.Namespace).toBe('RegistrySync');
    expect(input.MetricData![0].MetricName).toBe('SyncFailure');
    expect(input.MetricData![0].Value).toBe(1);
    expect(input.MetricData![0].Unit).toBe('Count');
  });

  test('does not throw when CloudWatch fails', async () => {
    cwMock.on(PutMetricDataCommand).rejects(new Error('CW down'));
    await expect(emitSyncFailureMetric()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      'Failed to emit SyncFailure metric:',
      expect.any(Error),
    );
  });
});

// ---------------------------------------------------------------------------
// handler — DLQ routing and metric emission
// ---------------------------------------------------------------------------

describe('handler — DLQ routing and metrics', () => {
  test('DynamoDB write failure sends to DLQ and emits SyncFailure metric', async () => {
    const error = new Error('DynamoDB is down');
    error.name = 'InternalServerError';
    ddbMock.on(PutCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: makeAgentResource(),
      },
    });

    await expect(handler(event)).rejects.toThrow('DynamoDB is down');

    // Verify DLQ
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    const sqsBody = JSON.parse(
      sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!,
    );
    expect(sqsBody.reason).toContain('DynamoDB write failure');

    // Verify CloudWatch metric
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
    expect(
      cwMock.commandCalls(PutMetricDataCommand)[0].args[0].input.MetricData![0].MetricName,
    ).toBe('SyncFailure');
  });

  test('DynamoDB delete failure sends to DLQ and emits metric', async () => {
    const error = new Error('Delete failed');
    error.name = 'InternalServerError';
    ddbMock.on(DeleteCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'DELETED',
      },
    });

    await expect(handler(event)).rejects.toThrow('Delete failed');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('DynamoDB update failure sends to DLQ and emits metric', async () => {
    const error = new Error('Update failed');
    error.name = 'InternalServerError';
    ddbMock.on(UpdateCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'STATUS_CHANGED',
        newStatus: 'APPROVED',
      },
    });

    await expect(handler(event)).rejects.toThrow('Update failed');
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('ConditionalCheckFailedException does NOT send to DLQ or emit metric', async () => {
    const error = new Error('Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(error);

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: makeAgentResource(),
      },
    });

    await expect(handler(event)).resolves.toBeUndefined();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('malformed event sends to DLQ but does NOT emit SyncFailure metric', async () => {
    const badEvent = { source: 'aws.s3', 'detail-type': 'wrong', detail: {} } as unknown as RegistryEvent;
    await expect(handler(badEvent)).rejects.toThrow('Malformed registry sync event');

    // DLQ should be called
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    // No CloudWatch metric for malformed events (not a DynamoDB failure)
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('handler still throws even if DLQ send fails', async () => {
    const ddbError = new Error('DynamoDB is down');
    ddbError.name = 'InternalServerError';
    ddbMock.on(PutCommand).rejects(ddbError);
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS also down'));

    const event = makeEvent({
      detail: {
        resourceId: 'agent-1',
        resourceType: 'agent',
        eventType: 'CREATED',
        resource: makeAgentResource(),
      },
    });

    // Original error still propagates
    await expect(handler(event)).rejects.toThrow('DynamoDB is down');
  });
});
