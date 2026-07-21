/**
 * Tests that the list resolvers thread the Lambda remaining-time budget
 * (context.getRemainingTimeInMillis) into RegistryService.listResources so
 * a large registry returns a partial list instead of timing out the
 * resolver (live incident: 340 records × sequential GETs > 30s).
 *
 * The handlers receive the Lambda Context as their SECOND argument — this
 * suite pins that the budget callback is wired through for both
 * listAgentConfigs and listToolConfigs.
 */
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

const mockListResources = jest.fn();

jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
    mapToAgentConfig: jest.fn((record: { recordId: string }) => ({
      agentId: record.recordId,
      name: record.recordId,
      orgId: '',
      config: '',
      state: 'active',
      categories: [] as string[],
    })),
    mapToToolConfig: jest.fn((record: { recordId: string }) => ({
      toolId: record.recordId,
      orgId: '',
      config: '',
      state: 'active',
      categories: [] as string[],
    })),
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

import {
  handler as agentHandler,
  _resetRegistryService as resetAgentRegistry,
} from '../agent-config-resolver';
import {
  handler as toolHandler,
  _resetRegistryService as resetToolRegistry,
} from '../tool-config-resolver';

const adminIdentity = { claims: { 'custom:role': 'admin' } };

describe('list resolvers thread the Lambda time budget into listResources', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: 'true',
      REGISTRY_ID: 'test-registry',
    };
    resetAgentRegistry();
    resetToolRegistry();
    dynamoMock.reset();
    dynamoMock.on(ScanCommand).resolves({ Items: [] });
    mockListResources.mockReset();
    mockListResources.mockResolvedValue([]);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('listAgentConfigs passes a getRemainingTimeMs callback wired to context.getRemainingTimeInMillis', async () => {
    const getRemainingTimeInMillis = jest.fn(() => 25_000);
    const event = {
      info: { fieldName: 'listAgentConfigs' },
      arguments: {},
      identity: adminIdentity,
    };

    await agentHandler(
      event as never,
      { getRemainingTimeInMillis } as never,
    );

    expect(mockListResources).toHaveBeenCalledWith(
      'agent',
      expect.objectContaining({ getRemainingTimeMs: expect.any(Function) }),
    );
    const options = mockListResources.mock.calls[0][1] as {
      getRemainingTimeMs: () => number;
    };
    expect(options.getRemainingTimeMs()).toBe(25_000);
    expect(getRemainingTimeInMillis).toHaveBeenCalled();
  });

  it('listToolConfigs passes a getRemainingTimeMs callback wired to context.getRemainingTimeInMillis', async () => {
    const getRemainingTimeInMillis = jest.fn(() => 12_000);
    const event = {
      info: { fieldName: 'listToolConfigs' },
      arguments: {},
      identity: adminIdentity,
    };

    await toolHandler(
      event as never,
      { getRemainingTimeInMillis } as never,
    );

    expect(mockListResources).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({ getRemainingTimeMs: expect.any(Function) }),
    );
    const options = mockListResources.mock.calls[0][1] as {
      getRemainingTimeMs: () => number;
    };
    expect(options.getRemainingTimeMs()).toBe(12_000);
    expect(getRemainingTimeInMillis).toHaveBeenCalled();
  });

  it('listAgentConfigs still works without a context (no budget guard)', async () => {
    const event = {
      info: { fieldName: 'listAgentConfigs' },
      arguments: {},
      identity: adminIdentity,
    };

    await expect(agentHandler(event as never)).resolves.toBeDefined();
    expect(mockListResources).toHaveBeenCalled();
  });
});
