/**
 * TDD Tests for KnowledgeBaseAdapter.deprovision
 *
 * When a Knowledge Base data store is deleted and was provisioned (CREATE_NEW mode),
 * the underlying Bedrock Knowledge Base should be deleted.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => {
  return {
    BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateKnowledgeBaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateKnowledgeBase', input })),
    GetKnowledgeBaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetKnowledgeBase', input })),
    DeleteKnowledgeBaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteKnowledgeBase', input })),
  };
});

import { KnowledgeBaseAdapter } from '../knowledge-base-adapter';
import { PermissionError } from '../errors';
import { BedrockAgentClient, DeleteKnowledgeBaseCommand } from '@aws-sdk/client-bedrock-agent';

describe('KnowledgeBaseAdapter.deprovision', () => {
  let adapter: KnowledgeBaseAdapter;

  beforeEach(() => {
    adapter = new KnowledgeBaseAdapter();
    mockSend.mockReset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteKnowledgeBaseCommand with the knowledgeBaseId', async () => {
    mockSend.mockResolvedValueOnce({});

    await adapter.deprovision!({ knowledgeBaseId: 'kb-12345' });

    expect(DeleteKnowledgeBaseCommand).toHaveBeenCalledWith({
      knowledgeBaseId: 'kb-12345',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('succeeds gracefully if knowledge base already deleted', async () => {
    const sdkError = new Error('Not found');
    sdkError.name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(sdkError);

    await expect(
      adapter.deprovision!({ knowledgeBaseId: 'kb-gone' })
    ).resolves.toBeUndefined();
  });

  test('throws PermissionError on AccessDeniedException', async () => {
    const sdkError = new Error('Access Denied');
    sdkError.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(sdkError);

    await expect(
      adapter.deprovision!({ knowledgeBaseId: 'kb-12345' })
    ).rejects.toThrow(PermissionError);
  });

  test('uses scoped credentials when provided', async () => {
    mockSend.mockResolvedValueOnce({});

    await adapter.deprovision!(
      { knowledgeBaseId: 'kb-12345' },
      { accessKeyId: 'AKIA...', secretAccessKey: 'secret', sessionToken: 'token' }
    );

    expect(BedrockAgentClient).toHaveBeenCalledWith({
      credentials: {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      },
    });
  });

  test('propagates unexpected errors', async () => {
    const sdkError = new Error('Internal failure');
    sdkError.name = 'InternalServerError';
    mockSend.mockRejectedValueOnce(sdkError);

    await expect(
      adapter.deprovision!({ knowledgeBaseId: 'kb-12345' })
    ).rejects.toThrow('Internal failure');
  });
});
