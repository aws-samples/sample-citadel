/**
 * Unit tests for RegistryService.searchResources:
 * - Calls ListRegistryRecordsCommand with name filter and descriptorType
 * - Handles pagination across multiple pages
 * - Returns empty array when no results match
 * - Uses retry with exponential backoff for transient errors
 *
 * Validates: Requirements 9.3
 */

import {
  BedrockAgentCoreControlClient,
  ListRegistryRecordsCommand,
  DescriptorType,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';
import { RegistryService } from '../registry-service';

const sdkMock = mockClient(BedrockAgentCoreControlClient);

/** Helper to build a minimal RegistryRecordSummary-like object for mocks. */
function makeSummary(overrides: Record<string, any>) {
  return {
    recordArn: 'arn:mock',
    registryArn: 'arn:reg',
    descriptorType: DescriptorType.CUSTOM,
    recordVersion: '1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RegistryService searchResources', () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: 'test-registry',
      region: 'us-east-1',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends ListRegistryRecordsCommand with name filter and descriptorType', async () => {
    const now = new Date();
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        makeSummary({
          recordId: 'agent-1',
          name: 'Search Agent',
          description: 'Matches query',
          status: 'APPROVED',
          createdAt: now,
          updatedAt: now,
        }),
      ],
      nextToken: undefined,
    });

    const results = await service.searchResources('agent', 'Search');

    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe('agent-1');
    expect(results[0].name).toBe('Search Agent');
    // Summaries don't include custom descriptor content
    expect(results[0].customDescriptorContent).toBeUndefined();

    const calls = sdkMock.commandCalls(ListRegistryRecordsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      registryId: 'test-registry',
      descriptorType: DescriptorType.CUSTOM,
      name: 'Search',
      nextToken: undefined,
    });
  });

  it('filters by tool resource type', async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        makeSummary({ recordId: 'tool-1', name: 'Data Tool', status: 'APPROVED' }),
      ],
      nextToken: undefined,
    });

    const results = await service.searchResources('tool', 'Data');

    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe('tool-1');

    const calls = sdkMock.commandCalls(ListRegistryRecordsCommand);
    expect(calls[0].args[0].input).toMatchObject({
      descriptorType: DescriptorType.CUSTOM,
      name: 'Data',
    });
  });

  it('handles pagination across multiple pages', async () => {
    sdkMock
      .on(ListRegistryRecordsCommand)
      .resolvesOnce({
        registryRecords: [makeSummary({ recordId: 'agent-1', name: 'Agent A', status: 'APPROVED' })],
        nextToken: 'page2',
      })
      .resolvesOnce({
        registryRecords: [makeSummary({ recordId: 'agent-2', name: 'Agent B', status: 'DRAFT' })],
        nextToken: undefined,
      });

    const results = await service.searchResources('agent', 'Agent');

    expect(results).toHaveLength(2);
    expect(results[0].recordId).toBe('agent-1');
    expect(results[1].recordId).toBe('agent-2');

    const calls = sdkMock.commandCalls(ListRegistryRecordsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input.nextToken).toBeUndefined();
    expect(calls[1].args[0].input.nextToken).toBe('page2');
  });

  it('returns empty array when no records match', async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [],
      nextToken: undefined,
    });

    const results = await service.searchResources('tool', 'nonexistent');

    expect(results).toEqual([]);
  });

  it('returns empty array when registryRecords field is undefined', async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      nextToken: undefined,
    } as any);

    const results = await service.searchResources('agent', 'missing');

    expect(results).toEqual([]);
  });

  it('retries on transient 5xx errors', async () => {
    const serverError = new Error('Internal Server Error') as any;
    serverError.$metadata = { httpStatusCode: 500 };

    sdkMock
      .on(ListRegistryRecordsCommand)
      .rejectsOnce(serverError)
      .resolves({
        registryRecords: [makeSummary({ recordId: 'agent-1', name: 'Recovered', status: 'APPROVED' })],
        nextToken: undefined,
      });

    const results = await service.searchResources('agent', 'Recovered');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Recovered');
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(2);
  });

  it('throws non-transient errors without retry', async () => {
    const clientError = new Error('Access denied') as any;
    clientError.name = 'AccessDeniedException';
    clientError.$metadata = { httpStatusCode: 403 };

    sdkMock.on(ListRegistryRecordsCommand).rejects(clientError);

    await expect(
      service.searchResources('agent', 'forbidden'),
    ).rejects.toThrow('Access denied');

    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(1);
  });

  it('maps record fields with defaults for missing values', async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        makeSummary({
          // Override with undefined to test defaults
          recordId: undefined,
          name: undefined,
          description: undefined,
          status: undefined,
        }),
      ],
      nextToken: undefined,
    });

    const results = await service.searchResources('tool', 'partial');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      recordId: '',
      name: '',
      status: '',
      customDescriptorContent: undefined,
    });
  });
});
