/**
 * Tests for agent-config-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

// Mock the RegistryService so registry-backed paths (activateProjectAgents)
// can be driven without hitting the AgentCore Registry SDK. DynamoDB-only
// tests never construct a RegistryService, so this mock does not affect them.
const mockListResources = jest.fn();
const mockUpdateResourceStatus = jest.fn();
// Faithful to the real registry-service: the activation gate (US-IMP) added to
// activateProjectAgents reads customMetadata via deserializeCustomMetadata.
// These records carry no governanceAttestation, so the gate is a no-op here.
const mockDeserializeCustomMetadata = jest.fn((json: string | null, defaults: any) => {
  if (!json) return defaults;
  try {
    return { ...defaults, ...JSON.parse(json) };
  } catch {
    return defaults;
  }
});

jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
    updateResourceStatus: mockUpdateResourceStatus,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
  })),
  RegistryRecordStatusValues: {
    DRAFT: 'DRAFT',
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    DEPRECATED: 'DEPRECATED',
    CREATING: 'CREATING',
    UPDATING: 'UPDATING',
    CREATE_FAILED: 'CREATE_FAILED',
    UPDATE_FAILED: 'UPDATE_FAILED',
  },
}));

import { handler, _resetRegistryService } from '../agent-config-resolver';

describe('agent-config-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.AGENT_CONFIG_TABLE = 'test-agent-config';
  });

  afterEach(() => {
    delete process.env.AGENT_CONFIG_TABLE;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('listAgentConfigs', () => {
    test('returns all configs with stringified config field', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { agentId: 'a1', config: { name: 'Agent1' }, state: 'active', categories: ['cat1'] },
          { agentId: 'a2', config: '{"name":"Agent2"}', state: 'inactive' },
        ],
      });

      const result = await handler(makeEvent('listAgentConfigs', {}));

      expect(result).toHaveLength(2);
      expect(result[0].agentId).toBe('a1');
      expect(typeof result[0].config).toBe('string');
      expect(JSON.parse(result[0].config)).toEqual({ name: 'Agent1' });
      expect(result[1].state).toBe('inactive');
    });

    test('returns empty array when no configs exist', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const result = await handler(makeEvent('listAgentConfigs', {}));
      expect(result).toEqual([]);
    });
  });

  describe('getAgentConfig', () => {
    test('returns config when found', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { name: 'Agent1' }, state: 'active' },
      });

      const result = await handler(makeEvent('getAgentConfig', { agentId: 'a1' }));
      expect(result).toBeDefined();
      expect(result!.agentId).toBe('a1');
    });

    test('returns null when not found', async () => {
      dynamoMock.on(GetCommand).resolves({});
      const result = await handler(makeEvent('getAgentConfig', { agentId: 'missing' }));
      expect(result).toBeNull();
    });
  });

  describe('createAgentConfig', () => {
    test('creates config and returns stringified config', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createAgentConfig', {
        input: { agentId: 'new-agent', config: '{"name":"New"}', state: 'active' },
      }));

      expect(result.agentId).toBe('new-agent');
      expect(typeof result.config).toBe('string');
      expect(result.createdAt).toBeDefined();
    });
  });

  describe('updateAgentConfig', () => {
    test('throws when config not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('updateAgentConfig', { input: { agentId: 'missing' } }))
      ).rejects.toThrow('Agent config not found');
    });

    test('updates existing config', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: '{"old":true}', state: 'active', createdAt: '2025-01-01' },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('updateAgentConfig', {
        input: { agentId: 'a1', config: '{"new":true}' },
      }));

      expect(result.agentId).toBe('a1');
      expect(JSON.parse(result.config)).toEqual({ new: true });
    });
  });

  describe('deleteAgentConfig', () => {
    test('returns success on delete', async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteAgentConfig', { agentId: 'a1' }));
      expect(result.success).toBe(true);
    });
  });

  describe('activateProjectAgents', () => {
    beforeEach(() => {
      process.env.REGISTRY_ID = 'reg-123';
      _resetRegistryService();
      mockListResources.mockReset();
      mockUpdateResourceStatus.mockReset();
    });

    afterEach(() => {
      delete process.env.REGISTRY_ID;
    });

    const agentRecord = (
      recordId: string,
      name: string,
      sourceProjectId: string | undefined,
      status: string,
    ) => ({
      recordId,
      name,
      status,
      customDescriptorContent: JSON.stringify({ sourceProjectId, manifest: {} }),
    });

    test('filters by sourceProjectId, activates non-active, skips already-active', async () => {
      mockListResources.mockResolvedValue([
        agentRecord('r1', 'Agent One', 'proj-1', 'DRAFT'),
        agentRecord('r2', 'Agent Two', 'proj-1', 'APPROVED'),
        agentRecord('r3', 'Other Project', 'proj-2', 'DRAFT'),
      ]);
      mockUpdateResourceStatus.mockResolvedValue({});

      const result = await handler(makeEvent('activateProjectAgents', { projectId: 'proj-1' }));

      expect(mockListResources).toHaveBeenCalledWith('agent');
      expect(mockUpdateResourceStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'r1', 'APPROVED');
      expect(result.activated).toEqual(['Agent One']);
      expect(result.alreadyActive).toEqual(['Agent Two']);
      expect(result.failed).toEqual([]);
    });

    test('continues and records failed when one agent errors', async () => {
      mockListResources.mockResolvedValue([
        agentRecord('r1', 'Agent One', 'proj-1', 'DRAFT'),
        agentRecord('r2', 'Agent Two', 'proj-1', 'DRAFT'),
      ]);
      mockUpdateResourceStatus
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({});

      const result = await handler(makeEvent('activateProjectAgents', { projectId: 'proj-1' }));

      expect(result.activated).toEqual(['Agent Two']);
      expect(result.failed).toEqual(['Agent One']);
      expect(result.alreadyActive).toEqual([]);
    });

    test('returns empty arrays when no agents match the project', async () => {
      mockListResources.mockResolvedValue([
        agentRecord('r3', 'Other Project', 'proj-2', 'DRAFT'),
        agentRecord('r4', 'No Project', undefined, 'DRAFT'),
      ]);

      const result = await handler(makeEvent('activateProjectAgents', { projectId: 'proj-1' }));

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ activated: [], failed: [], alreadyActive: [] });
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
