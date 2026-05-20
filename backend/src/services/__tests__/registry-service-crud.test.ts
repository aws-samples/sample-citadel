/**
 * Unit tests for RegistryService CRUD operations:
 * - createResource, getResource, updateResource, deleteResource, listResources
 * - Retry with exponential backoff for transient errors
 * - Return null on 404 for getResource
 *
 * Validates: Requirements 3.3, 3.4, 3.5, 4.3, 4.4, 4.5
 */

import {
  BedrockAgentCoreControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  UpdateRegistryRecordCommand,
  DeleteRegistryRecordCommand,
  ListRegistryRecordsCommand,
  DescriptorType,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';
import { RegistryService, RegistryRecord, CreateResourceInput, UpdateResourceInput } from '../registry-service';

const sdkMock = mockClient(BedrockAgentCoreControlClient);

describe('RegistryService CRUD operations', () => {
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

  // -- createResource ------------------------------------------------------

  describe('createResource', () => {
    it('sends CreateRegistryRecordCommand then GetRegistryRecordCommand and returns record', async () => {
      const now = new Date();
      // CreateRegistryRecordCommand returns recordArn + status
      sdkMock.on(CreateRegistryRecordCommand).resolves({
        recordArn: 'arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry/record/agent-1',
        status: 'DRAFT',
      });
      // Follow-up GetRegistryRecordCommand returns full record
      sdkMock.on(GetRegistryRecordCommand).resolves({
        recordId: 'agent-1',
        name: 'My Agent',
        description: 'A test agent',
        status: 'DRAFT',
        descriptorType: DescriptorType.CUSTOM,
        descriptors: {
          custom: { inlineContent: '{"categories":["ai"]}' },
        },
        createdAt: now,
        updatedAt: now,
      });

      const input: CreateResourceInput = {
        name: 'My Agent',
        description: 'A test agent',
        customMetadata: '{"categories":["ai"]}',
      };

      const result = await service.createResource('agent', 'agent-1', input);

      expect(result).toEqual<RegistryRecord>({
        recordId: 'agent-1',
        name: 'My Agent',
        description: 'A test agent',
        status: 'DRAFT',
        customDescriptorContent: '{"categories":["ai"]}',
        createdAt: now,
        updatedAt: now,
      });

      const createCalls = sdkMock.commandCalls(CreateRegistryRecordCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].args[0].input).toEqual({
        registryId: 'test-registry',
        name: 'My Agent',
        description: 'A test agent',
        descriptorType: DescriptorType.CUSTOM,
        descriptors: {
          custom: { inlineContent: '{"categories":["ai"]}' },
        },
      });
    });

    it('uses fallback when GetRegistryRecordCommand fails after create', async () => {
      sdkMock.on(CreateRegistryRecordCommand).resolves({
        recordArn: 'arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry/record/agent-2',
        status: 'DRAFT',
      });
      // Get fails with 404
      const err = new Error('Not found') as any;
      err.name = 'ResourceNotFoundException';
      err.$metadata = { httpStatusCode: 404 };
      sdkMock.on(GetRegistryRecordCommand).rejects(err);

      const input: CreateResourceInput = {
        name: 'Fallback Agent',
        customMetadata: '{}',
      };

      const result = await service.createResource('agent', 'agent-2', input);

      expect(result.recordId).toBe('agent-2');
      expect(result.name).toBe('Fallback Agent');
      expect(result.status).toBe('DRAFT');
    });
  });

  // -- getResource ---------------------------------------------------------

  describe('getResource', () => {
    it('returns record when found', async () => {
      const now = new Date();
      sdkMock.on(GetRegistryRecordCommand).resolves({
        recordId: 'tool-1',
        name: 'My Tool',
        description: 'A test tool',
        status: 'APPROVED',
        descriptorType: DescriptorType.CUSTOM,
        descriptors: {
          custom: { inlineContent: '{"categories":["data"]}' },
        },
        createdAt: now,
        updatedAt: now,
      });

      const result = await service.getResource('tool', 'tool-1');

      expect(result).not.toBeNull();
      expect(result!.recordId).toBe('tool-1');
      expect(result!.status).toBe('APPROVED');
      expect(result!.customDescriptorContent).toBe('{"categories":["data"]}');
    });

    it('returns null on ResourceNotFoundException', async () => {
      const err = new Error('Not found') as any;
      err.name = 'ResourceNotFoundException';
      err.$metadata = { httpStatusCode: 404 };
      sdkMock.on(GetRegistryRecordCommand).rejects(err);

      const result = await service.getResource('agent', 'nonexistent');

      expect(result).toBeNull();
    });

    it('returns null on 404 status code', async () => {
      const err = new Error('Not found') as any;
      err.name = 'SomeOtherError';
      err.$metadata = { httpStatusCode: 404 };
      sdkMock.on(GetRegistryRecordCommand).rejects(err);

      const result = await service.getResource('agent', 'nonexistent');

      expect(result).toBeNull();
    });

    it('throws non-404 errors', async () => {
      const err = new Error('Access denied') as any;
      err.name = 'AccessDeniedException';
      err.$metadata = { httpStatusCode: 403 };
      sdkMock.on(GetRegistryRecordCommand).rejects(err);

      await expect(service.getResource('agent', 'agent-1')).rejects.toThrow(
        'Access denied',
      );
    });
  });

  // -- updateResource ------------------------------------------------------

  describe('updateResource', () => {
    it('sends UpdateRegistryRecordCommand with correct params and returns record', async () => {
      const now = new Date();
      sdkMock.on(UpdateRegistryRecordCommand).resolves({
        recordId: 'agent-1',
        name: 'Updated Agent',
        description: 'Updated desc',
        status: 'APPROVED',
        descriptorType: DescriptorType.CUSTOM,
        descriptors: {
          custom: { inlineContent: '{"categories":["updated"]}' },
        },
        createdAt: now,
        updatedAt: now,
      });

      const input: UpdateResourceInput = {
        name: 'Updated Agent',
        description: 'Updated desc',
        customMetadata: '{"categories":["updated"]}',
      };

      const result = await service.updateResource('agent', 'agent-1', input);

      expect(result.recordId).toBe('agent-1');
      expect(result.name).toBe('Updated Agent');
      expect(result.customDescriptorContent).toBe('{"categories":["updated"]}');

      const calls = sdkMock.commandCalls(UpdateRegistryRecordCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        registryId: 'test-registry',
        recordId: 'agent-1',
        name: 'Updated Agent',
        description: { optionalValue: 'Updated desc' },
        descriptors: {
          optionalValue: {
            custom: {
              optionalValue: {
                inlineContent: '{"categories":["updated"]}',
              },
            },
          },
        },
      });
    });

    it('sends only provided fields (partial update)', async () => {
      sdkMock.on(UpdateRegistryRecordCommand).resolves({
        recordId: 'tool-1',
        name: 'Tool',
        status: 'APPROVED',
        descriptorType: DescriptorType.CUSTOM,
        descriptors: {
          custom: { inlineContent: '{"categories":["new-cat"]}' },
        },
      });

      const input: UpdateResourceInput = {
        customMetadata: '{"categories":["new-cat"]}',
      };

      await service.updateResource('tool', 'tool-1', input);

      const calls = sdkMock.commandCalls(UpdateRegistryRecordCommand);
      expect(calls[0].args[0].input).toEqual({
        registryId: 'test-registry',
        recordId: 'tool-1',
        name: undefined,
        description: undefined,
        descriptors: {
          optionalValue: {
            custom: {
              optionalValue: {
                inlineContent: '{"categories":["new-cat"]}',
              },
            },
          },
        },
      });
    });
  });

  // -- deleteResource ------------------------------------------------------

  describe('deleteResource', () => {
    it('sends DeleteRegistryRecordCommand with correct params', async () => {
      sdkMock.on(DeleteRegistryRecordCommand).resolves({});

      await service.deleteResource('agent', 'agent-1');

      const calls = sdkMock.commandCalls(DeleteRegistryRecordCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        registryId: 'test-registry',
        recordId: 'agent-1',
      });
    });

    it('throws on non-transient errors', async () => {
      const err = new Error('Not found') as any;
      err.name = 'ResourceNotFoundException';
      err.$metadata = { httpStatusCode: 404 };
      sdkMock.on(DeleteRegistryRecordCommand).rejects(err);

      await expect(service.deleteResource('tool', 'tool-1')).rejects.toThrow(
        'Not found',
      );
    });
  });

  // -- listResources -------------------------------------------------------

  describe('listResources', () => {
    it('returns all records for a resource type', async () => {
      const now = new Date();
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: [
          {
            recordId: 'agent-1',
            name: 'Agent 1',
            status: 'APPROVED',
            recordArn: 'arn:1',
            registryArn: 'arn:reg',
            descriptorType: DescriptorType.CUSTOM,
            recordVersion: '1',
            createdAt: now,
            updatedAt: now,
          },
          {
            recordId: 'agent-2',
            name: 'Agent 2',
            status: 'DRAFT',
            recordArn: 'arn:2',
            registryArn: 'arn:reg',
            descriptorType: DescriptorType.CUSTOM,
            recordVersion: '1',
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextToken: undefined,
      });

      const results = await service.listResources('agent');

      expect(results).toHaveLength(2);
      expect(results[0].recordId).toBe('agent-1');
      expect(results[1].recordId).toBe('agent-2');

      const calls = sdkMock.commandCalls(ListRegistryRecordsCommand);
      expect(calls[0].args[0].input).toEqual({
        registryId: 'test-registry',
        descriptorType: DescriptorType.CUSTOM,
        nextToken: undefined,
      });
    });

    it('handles pagination across multiple pages', async () => {
      sdkMock
        .on(ListRegistryRecordsCommand)
        .resolvesOnce({
          registryRecords: [{
            recordId: 'tool-1',
            name: 'Tool 1',
            status: 'APPROVED',
            recordArn: 'arn:1',
            registryArn: 'arn:reg',
            descriptorType: DescriptorType.CUSTOM,
            recordVersion: '1',
            createdAt: new Date(),
            updatedAt: new Date(),
          }],
          nextToken: 'page2',
        })
        .resolvesOnce({
          registryRecords: [{
            recordId: 'tool-2',
            name: 'Tool 2',
            status: 'DRAFT',
            recordArn: 'arn:2',
            registryArn: 'arn:reg',
            descriptorType: DescriptorType.CUSTOM,
            recordVersion: '1',
            createdAt: new Date(),
            updatedAt: new Date(),
          }],
          nextToken: undefined,
        });

      const results = await service.listResources('tool');

      expect(results).toHaveLength(2);
      expect(results[0].recordId).toBe('tool-1');
      expect(results[1].recordId).toBe('tool-2');

      const calls = sdkMock.commandCalls(ListRegistryRecordsCommand);
      expect(calls).toHaveLength(2);
    });

    it('returns empty array when no records exist', async () => {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: [],
        nextToken: undefined,
      });

      const results = await service.listResources('agent');

      expect(results).toEqual([]);
    });

    it('returns empty array when registryRecords field is undefined', async () => {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        nextToken: undefined,
      } as any);

      const results = await service.listResources('tool');

      expect(results).toEqual([]);
    });
  });

  // -- Retry with exponential backoff --------------------------------------

  describe('retry with exponential backoff', () => {
    it('retries on 5xx errors and succeeds on subsequent attempt', async () => {
      const serverError = new Error('Internal Server Error') as any;
      serverError.$metadata = { httpStatusCode: 500 };

      sdkMock
        .on(GetRegistryRecordCommand)
        .rejectsOnce(serverError)
        .resolves({
          recordId: 'agent-1',
          name: 'Agent',
          status: 'APPROVED',
          descriptorType: DescriptorType.CUSTOM,
          descriptors: {},
        });

      const result = await service.getResource('agent', 'agent-1');

      expect(result).not.toBeNull();
      expect(result!.recordId).toBe('agent-1');
      expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(2);
    });

    it('retries on ThrottlingException', async () => {
      const throttleError = new Error('Rate exceeded') as any;
      throttleError.name = 'ThrottlingException';

      // First call to CreateRegistryRecordCommand throttles, second succeeds
      sdkMock
        .on(CreateRegistryRecordCommand)
        .rejectsOnce(throttleError)
        .resolves({
          recordArn: 'arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry/record/agent-1',
          status: 'DRAFT',
        });
      // GetRegistryRecordCommand for the follow-up fetch
      sdkMock.on(GetRegistryRecordCommand).resolves({
        recordId: 'agent-1',
        name: 'Agent',
        status: 'DRAFT',
        descriptorType: DescriptorType.CUSTOM,
        descriptors: {},
      });

      const result = await service.createResource('agent', 'agent-1', {
        name: 'Agent',
        customMetadata: '{}',
      });

      expect(result.recordId).toBe('agent-1');
      expect(sdkMock.commandCalls(CreateRegistryRecordCommand)).toHaveLength(2);
    });

    it('retries on ServiceUnavailableException', async () => {
      const unavailableError = new Error('Service unavailable') as any;
      unavailableError.name = 'ServiceUnavailableException';

      sdkMock
        .on(DeleteRegistryRecordCommand)
        .rejectsOnce(unavailableError)
        .resolves({});

      await service.deleteResource('tool', 'tool-1');

      expect(sdkMock.commandCalls(DeleteRegistryRecordCommand)).toHaveLength(2);
    });

    it('throws after exhausting all 3 retry attempts', async () => {
      const serverError = new Error('Persistent failure') as any;
      serverError.$metadata = { httpStatusCode: 503 };

      sdkMock.on(GetRegistryRecordCommand).rejects(serverError);

      await expect(service.getResource('agent', 'agent-1')).rejects.toThrow(
        'Persistent failure',
      );

      // 3 attempts total
      expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(3);
    });

    it('does not retry on non-transient errors (4xx)', async () => {
      const clientError = new Error('Bad request') as any;
      clientError.name = 'ValidationException';
      clientError.$metadata = { httpStatusCode: 400 };

      sdkMock.on(UpdateRegistryRecordCommand).rejects(clientError);

      await expect(
        service.updateResource('agent', 'agent-1', {
          name: 'Updated',
          customMetadata: '{}',
        }),
      ).rejects.toThrow('Bad request');

      // Only 1 attempt — no retries
      expect(sdkMock.commandCalls(UpdateRegistryRecordCommand)).toHaveLength(1);
    });

    it('does not retry on AccessDeniedException', async () => {
      const authError = new Error('Access denied') as any;
      authError.name = 'AccessDeniedException';
      authError.$metadata = { httpStatusCode: 403 };

      sdkMock.on(ListRegistryRecordsCommand).rejects(authError);

      await expect(service.listResources('agent')).rejects.toThrow(
        'Access denied',
      );

      expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(1);
    });

    it('retries on InternalServerException by name', async () => {
      const internalError = new Error('Internal error') as any;
      internalError.name = 'InternalServerException';

      sdkMock
        .on(GetRegistryRecordCommand)
        .rejectsOnce(internalError)
        .resolves({
          recordId: 'agent-1',
          name: 'Agent',
          status: 'APPROVED',
          descriptorType: DescriptorType.CUSTOM,
          descriptors: {},
        });

      const result = await service.getResource('agent', 'agent-1');

      expect(result).not.toBeNull();
      expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(2);
    });
  });
});
