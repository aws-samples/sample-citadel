/**
 * TDD Tests for KnowledgeBaseAdapter
 *
 * Tests provision config mapping (resourceName → name) and deprovision support.
 * Provides roleArn in config to skip service role creation (tested separately
 * in knowledge-base-adapter-provision.test.ts).
 */
import {
  BedrockAgentClient,
  CreateKnowledgeBaseCommand,
  DeleteKnowledgeBaseCommand,
  GetKnowledgeBaseCommand,
} from '@aws-sdk/client-bedrock-agent';
import { mockClient } from 'aws-sdk-client-mock';

// Mock STS for getAccountContext
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Account: '123456789012' }),
    config: { region: () => Promise.resolve('us-east-1') },
  })),
  GetCallerIdentityCommand: jest.fn(),
}));

const bedrockMock = mockClient(BedrockAgentClient);

import { KnowledgeBaseAdapter } from '../knowledge-base-adapter';

describe('KnowledgeBaseAdapter', () => {
  const adapter = new KnowledgeBaseAdapter();
  adapter.roleCreationDelayMs = 0; // Skip delay in tests

  // Provide roleArn and collectionArn to skip service role creation and AOSS provisioning
  const baseConfig = {
    roleArn: 'arn:aws:iam::123456789012:role/test-role',
    collectionArn: 'arn:aws:aoss:us-east-1:123456789012:collection/test-col',
  };

  beforeEach(() => {
    bedrockMock.reset();
  });

  describe('provision - config field mapping', () => {
    test('uses config.resourceName as the knowledge base name when config.name is absent', async () => {
      bedrockMock.on(CreateKnowledgeBaseCommand).resolves({
        knowledgeBase: {
          knowledgeBaseId: 'KB123',
          knowledgeBaseArn: 'arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB123',
          name: 'og-test-kb',
          roleArn: 'arn:aws:iam::123456789012:role/test',
          status: 'ACTIVE',
          knowledgeBaseConfiguration: { type: 'VECTOR' },
        },
      });

      const result = await adapter.provision(
        { ...baseConfig, resourceName: 'og-test-kb' },
        { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
      );

      expect(result.resourceArn).toContain('knowledge-base');
      const calls = bedrockMock.commandCalls(CreateKnowledgeBaseCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.name).toBe('og-test-kb');
    });

    test('prefers config.name over config.resourceName', async () => {
      bedrockMock.on(CreateKnowledgeBaseCommand).resolves({
        knowledgeBase: {
          knowledgeBaseId: 'KB456',
          knowledgeBaseArn: 'arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB456',
          name: 'explicit-name',
          roleArn: 'arn:aws:iam::123456789012:role/test',
          status: 'ACTIVE',
          knowledgeBaseConfiguration: { type: 'VECTOR' },
        },
      });

      await adapter.provision(
        { ...baseConfig, name: 'explicit-name', resourceName: 'fallback-name' },
        { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
      );

      const calls = bedrockMock.commandCalls(CreateKnowledgeBaseCommand);
      expect(calls[0].args[0].input.name).toBe('explicit-name');
    });
  });

  describe('deprovision', () => {
    test('deprovision method exists', () => {
      expect(adapter.deprovision).toBeDefined();
      expect(typeof adapter.deprovision).toBe('function');
    });

    test('deletes the knowledge base by ID', async () => {
      bedrockMock.on(DeleteKnowledgeBaseCommand).resolves({});

      await adapter.deprovision!(
        { knowledgeBaseId: 'KB123' },
        { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
      );

      const calls = bedrockMock.commandCalls(DeleteKnowledgeBaseCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.knowledgeBaseId).toBe('KB123');
    });

    test('succeeds gracefully if knowledge base already deleted', async () => {
      const notFound = new Error('ResourceNotFoundException');
      notFound.name = 'ResourceNotFoundException';
      bedrockMock.on(DeleteKnowledgeBaseCommand).rejects(notFound);

      await expect(
        adapter.deprovision!(
          { knowledgeBaseId: 'KB-GONE' },
          { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
        )
      ).resolves.toBeUndefined();
    });

    test('throws on access denied during deprovision', async () => {
      const accessDenied = new Error('AccessDeniedException');
      accessDenied.name = 'AccessDeniedException';
      bedrockMock.on(DeleteKnowledgeBaseCommand).rejects(accessDenied);

      await expect(
        adapter.deprovision!(
          { knowledgeBaseId: 'KB-DENIED' },
          { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
        )
      ).rejects.toThrow(/[Pp]ermission denied/);
    });
  });

  describe('provision stores knowledgeBaseId in result for later deprovision', () => {
    test('provision result includes knowledgeBaseId in resourceArn', async () => {
      bedrockMock.on(CreateKnowledgeBaseCommand).resolves({
        knowledgeBase: {
          knowledgeBaseId: 'KBXYZ',
          knowledgeBaseArn: 'arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KBXYZ',
          name: 'test-kb',
          roleArn: 'arn:aws:iam::123456789012:role/test',
          status: 'ACTIVE',
          knowledgeBaseConfiguration: { type: 'VECTOR' },
        },
      });

      const result = await adapter.provision(
        { ...baseConfig, resourceName: 'test-kb' },
        { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
      );

      expect(result.resourceArn).toContain('KBXYZ');
    });
  });
});
