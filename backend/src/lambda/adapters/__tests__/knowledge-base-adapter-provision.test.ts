/**
 * TDD Tests for KnowledgeBaseAdapter.provision
 *
 * The Bedrock CreateKnowledgeBase API requires:
 * 1. A service role ARN (IAM role with bedrock.amazonaws.com trust)
 * 2. An embedding model ARN
 * 3. A storage configuration (AOSS VECTORSEARCH collection for VECTOR type)
 *
 * When no storage is provided, the adapter provisions an OpenSearch Serverless
 * VECTORSEARCH collection with encryption, network, and data access policies.
 */

const mockSend = jest.fn();
const mockIamSend = jest.fn();
const mockStsSend = jest.fn();
const mockOssSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateKnowledgeBaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateKnowledgeBase', input })),
  GetKnowledgeBaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetKnowledgeBase', input })),
  DeleteKnowledgeBaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteKnowledgeBase', input })),
}));

jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn().mockImplementation(() => ({ send: mockIamSend })),
  CreateRoleCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateRole', input })),
  PutRolePolicyCommand: jest.fn().mockImplementation((input) => ({ _type: 'PutRolePolicy', input })),
  DeleteRolePolicyCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteRolePolicy', input })),
  DeleteRoleCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteRole', input })),
}));

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    config: { region: () => Promise.resolve('us-west-2') },
  })),
  GetCallerIdentityCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetCallerIdentity', input })),
}));

jest.mock('@aws-sdk/client-opensearchserverless', () => ({
  OpenSearchServerlessClient: jest.fn().mockImplementation(() => ({ send: mockOssSend })),
  CreateSecurityPolicyCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateSecurityPolicy', input })),
  CreateAccessPolicyCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateAccessPolicy', input })),
  CreateCollectionCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateCollection', input })),
  DeleteCollectionCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteCollection', input })),
  BatchGetCollectionCommand: jest.fn().mockImplementation((input) => ({ _type: 'BatchGetCollection', input })),
}));

import { KnowledgeBaseAdapter } from '../knowledge-base-adapter';
import { CreateKnowledgeBaseCommand } from '@aws-sdk/client-bedrock-agent';
import { CreateRoleCommand, DeleteRolePolicyCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';
import { CreateCollectionCommand, CreateSecurityPolicyCommand } from '@aws-sdk/client-opensearchserverless';

describe('KnowledgeBaseAdapter.provision - service role and defaults', () => {
  let adapter: KnowledgeBaseAdapter;

  beforeEach(() => {
    adapter = new KnowledgeBaseAdapter();
    adapter.roleCreationDelayMs = 0;
    adapter.collectionPollIntervalMs = 0;
    adapter.collectionMaxWaitMs = 5000;
    mockSend.mockReset();
    mockIamSend.mockReset();
    mockStsSend.mockReset();
    mockOssSend.mockReset();

    // Default: STS returns account info
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    // Default: IAM role creation succeeds
    mockIamSend.mockResolvedValue({ Role: { Arn: 'arn:aws:iam::123456789012:role/citadel-kb-service-role-test' } });
    // Default: AOSS operations succeed
    mockOssSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'CreateSecurityPolicy') return Promise.resolve({ securityPolicyDetail: {} });
      if (cmd._type === 'CreateAccessPolicy') return Promise.resolve({ accessPolicyDetail: {} });
      if (cmd._type === 'CreateCollection') return Promise.resolve({
        createCollectionDetail: {
          id: 'col-abc123',
          arn: 'arn:aws:aoss:us-west-2:123456789012:collection/col-abc123',
          status: 'CREATING',
        },
      });
      if (cmd._type === 'BatchGetCollection') return Promise.resolve({
        collectionDetails: [{
          id: 'col-abc123',
          arn: 'arn:aws:aoss:us-west-2:123456789012:collection/col-abc123',
          collectionEndpoint: 'https://col-abc123.us-west-2.aoss.amazonaws.com',
          status: 'ACTIVE',
        }],
      });
      return Promise.resolve({});
    });

    // Stub createVectorIndex (private) to avoid real HTTP calls
    (adapter as unknown as { createVectorIndex: jest.Mock }).createVectorIndex = jest
      .fn()
      .mockResolvedValue(undefined);
  });

  test('creates a Bedrock service role when roleArn is not provided', async () => {
    mockSend.mockResolvedValueOnce({
      knowledgeBase: {
        knowledgeBaseId: 'KB123',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB123',
        status: 'CREATING',
      },
    });

    await adapter.provision({ name: 'test-kb' });

    expect(CreateRoleCommand).toHaveBeenCalled();
    const createRoleInput = jest.mocked(CreateRoleCommand).mock.calls[0][0];
    const trustPolicy = JSON.parse(String(createRoleInput.AssumeRolePolicyDocument));
    expect(trustPolicy.Statement[0].Principal.Service).toBe('bedrock.amazonaws.com');
  });

  test('provisions AOSS VECTORSEARCH collection when no storage config provided', async () => {
    mockSend.mockResolvedValueOnce({
      knowledgeBase: {
        knowledgeBaseId: 'KB123',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB123',
        status: 'CREATING',
      },
    });

    await adapter.provision({ name: 'test-kb' });

    expect(CreateCollectionCommand).toHaveBeenCalled();
    const collInput = jest.mocked(CreateCollectionCommand).mock.calls[0][0];
    expect(collInput.type).toBe('VECTORSEARCH');
  });

  test('creates encryption and network policies for the AOSS collection', async () => {
    mockSend.mockResolvedValueOnce({
      knowledgeBase: {
        knowledgeBaseId: 'KB123',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB123',
        status: 'CREATING',
      },
    });

    await adapter.provision({ name: 'test-kb' });

    // Should have created both encryption and network policies
    const secPolicyCalls = jest.mocked(CreateSecurityPolicyCommand).mock.calls;
    const types = secPolicyCalls.map((c) => c[0].type);
    expect(types).toContain('encryption');
    expect(types).toContain('network');
  });

  test('passes real AOSS collection ARN in storageConfiguration', async () => {
    mockSend.mockResolvedValueOnce({
      knowledgeBase: {
        knowledgeBaseId: 'KB123',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB123',
        status: 'CREATING',
      },
    });

    await adapter.provision({ name: 'test-kb' });

    expect(CreateKnowledgeBaseCommand).toHaveBeenCalled();
    const kbInput = jest.mocked(CreateKnowledgeBaseCommand).mock.calls[0][0];
    expect(kbInput.storageConfiguration).toBeDefined();
    expect(kbInput.storageConfiguration?.type).toBe('OPENSEARCH_SERVERLESS');
    expect(kbInput.storageConfiguration?.opensearchServerlessConfiguration?.collectionArn).toContain('arn:aws:aoss:');
  });

  test('uses provided roleArn without creating a new service role', async () => {
    mockIamSend.mockClear();
    jest.mocked(CreateRoleCommand).mockClear();

    mockSend.mockResolvedValueOnce({
      knowledgeBase: {
        knowledgeBaseId: 'KB456',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB456',
        status: 'CREATING',
      },
    });

    await adapter.provision({
      name: 'test-kb',
      roleArn: 'arn:aws:iam::123456789012:role/my-custom-role',
      collectionArn: 'arn:aws:aoss:us-west-2:123456789012:collection/real-col',
    });

    expect(CreateRoleCommand).not.toHaveBeenCalled();

    const kbCalls = jest.mocked(CreateKnowledgeBaseCommand).mock.calls;
    const kbInput = kbCalls[kbCalls.length - 1][0];
    expect(kbInput.roleArn).toBe('arn:aws:iam::123456789012:role/my-custom-role');
  });

  test('uses a default embedding model ARN when not provided', async () => {
    mockSend.mockResolvedValueOnce({
      knowledgeBase: {
        knowledgeBaseId: 'KB789',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB789',
        status: 'CREATING',
      },
    });

    await adapter.provision({ name: 'test-kb' });

    const kbInput = jest.mocked(CreateKnowledgeBaseCommand).mock.calls[0][0];
    expect(kbInput.knowledgeBaseConfiguration?.vectorKnowledgeBaseConfiguration?.embeddingModelArn).toContain('amazon.titan-embed-text-v2');
  });

  test('returns empty provision policies so Lambda credentials are used', () => {
    const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
    expect(policies.provision).toEqual([]);
  });

  test('deprovision cleans up the service role it created', async () => {
    mockSend.mockResolvedValueOnce({});

    await adapter.deprovision({ knowledgeBaseId: 'KB123', serviceRoleName: 'citadel-ds-kb-svc-KB123' });

    expect(DeleteRolePolicyCommand).toHaveBeenCalled();
    expect(DeleteRoleCommand).toHaveBeenCalled();
  });
});
