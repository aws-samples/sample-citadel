import { OpenSearchAdapter } from '../opensearch-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-opensearchserverless', () => {
  return {
    OpenSearchServerlessClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateCollectionCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateCollection', input })),
    CreateSecurityPolicyCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateSecurityPolicy', input })),
    BatchGetCollectionCommand: jest.fn().mockImplementation((input) => ({ _type: 'BatchGetCollection', input })),
  };
});

describe('OpenSearchAdapter', () => {
  let adapter: OpenSearchAdapter;
  const config = { collectionName: 'my-test-collection' };

  beforeEach(() => {
    adapter = new OpenSearchAdapter();
    mockSend.mockReset();
    // Default: security policy calls succeed, other calls need explicit mocking
    mockSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'CreateSecurityPolicy') return Promise.resolve({ securityPolicyDetail: {} });
      return Promise.resolve({});
    });
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateCollection and BatchGetCollection', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(2);
      expect(policies.provision[0].actions).toEqual([
        'aoss:CreateCollection',
        'aoss:DeleteCollection',
        'aoss:BatchGetCollection',
      ]);
      expect(policies.provision[0].resources).toEqual([
        'arn:aws:aoss:us-east-1:123456789012:collection/*',
      ]);
      expect(policies.provision[1].actions).toContain('aoss:CreateSecurityPolicy');
      expect(policies.provision[1].resources).toEqual(['*']);
      expect(policies.provision[0].resources).toEqual([
        'arn:aws:aoss:us-east-1:123456789012:collection/*',
      ]);
    });

    it('returns connect policies for BatchGetCollection and APIAccessAll', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'aoss:BatchGetCollection',
        'aoss:APIAccessAll',
      ]);
      expect(policies.connect[0].resources).toEqual([
        'arn:aws:aoss:us-east-1:123456789012:collection/*',
      ]);
    });
  });

  describe('provision', () => {
    beforeEach(() => {
      // Default: security policies succeed, collection creation succeeds
      mockSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'CreateSecurityPolicy') return Promise.resolve({ securityPolicyDetail: {} });
        if (cmd._type === 'CreateCollection') return Promise.resolve({
          createCollectionDetail: { arn: 'arn:aws:aoss:us-east-1:123:collection/my-test-collection' },
        });
        return Promise.resolve({});
      });
    });

    it('creates a collection and returns the ARN', async () => {
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:aoss:us-east-1:123:collection/my-test-collection');
    });

    it('uses SEARCH type by default', async () => {
      const { CreateCollectionCommand } = require('@aws-sdk/client-opensearchserverless');
      await adapter.provision(config);
      expect(CreateCollectionCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SEARCH' })
      );
    });

    it('uses VECTORSEARCH type when specified in config', async () => {
      const { CreateCollectionCommand } = require('@aws-sdk/client-opensearchserverless');
      await adapter.provision({ ...config, collectionType: 'VECTORSEARCH' });
      expect(CreateCollectionCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'VECTORSEARCH' })
      );
    });

    it('handles ConflictException as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'ConflictException';
      mockSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'CreateSecurityPolicy') return Promise.resolve({ securityPolicyDetail: {} });
        if (cmd._type === 'CreateCollection') return Promise.reject(sdkError);
        return Promise.resolve({});
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-test-collection');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'CreateSecurityPolicy') return Promise.resolve({ securityPolicyDetail: {} });
        if (cmd._type === 'CreateCollection') return Promise.reject(sdkError);
        return Promise.resolve({});
      });
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalError';
      mockSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'CreateSecurityPolicy') return Promise.resolve({ securityPolicyDetail: {} });
        if (cmd._type === 'CreateCollection') return Promise.reject(sdkError);
        return Promise.resolve({});
      });
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect(err.cause).toBe(sdkError);
      }
    });

    it('generates a name when collectionName is not in config', async () => {
      const { CreateCollectionCommand } = require('@aws-sdk/client-opensearchserverless');
      await adapter.provision({});
      expect(CreateCollectionCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringMatching(/^citadel-os-\d+$/),
        })
      );
    });
  });

  describe('connect', () => {
    it('succeeds when collection status is ACTIVE', async () => {
      mockSend.mockResolvedValueOnce({
        collectionDetails: [{ name: 'my-test-collection', status: 'ACTIVE' }],
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when collection is not ACTIVE', async () => {
      mockSend.mockResolvedValueOnce({
        collectionDetails: [{ name: 'my-test-collection', status: 'CREATING' }],
      });
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when collection is not found', async () => {
      mockSend.mockResolvedValueOnce({ collectionDetails: [] });
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDeniedException', async () => {
      const sdkError = new Error('Forbidden');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError with cause', async () => {
      const sdkError = new Error('Network issue');
      (sdkError as any).name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect(err.cause).toBe(sdkError);
      }
    });

    it('uses collectionId when collectionName is not provided', async () => {
      const { BatchGetCollectionCommand } = require('@aws-sdk/client-opensearchserverless');
      mockSend.mockResolvedValueOnce({
        collectionDetails: [{ name: 'test', status: 'ACTIVE' }],
      });
      await adapter.connect({ collectionId: 'abc123' });
      expect(BatchGetCollectionCommand).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ['abc123'], names: undefined })
      );
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with collection details', async () => {
      mockSend.mockResolvedValueOnce({
        collectionDetails: [{
          name: 'my-test-collection',
          status: 'ACTIVE',
          arn: 'arn:aws:aoss:us-east-1:123:collection/abc',
          collectionEndpoint: 'https://abc.us-east-1.aoss.amazonaws.com',
        }],
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.status).toBe('ACTIVE');
      expect(result.details?.arn).toBe('arn:aws:aoss:us-east-1:123:collection/abc');
      expect(result.details?.endpoint).toBe('https://abc.us-east-1.aoss.amazonaws.com');
    });

    it('returns failure when collection is not found', async () => {
      mockSend.mockResolvedValueOnce({ collectionDetails: [] });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });

    it('returns failure when BatchGetCollection fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Service error'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns placeholder metrics', async () => {
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('N/A');
      expect(result.records).toBe(0);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      const { OpenSearchServerlessClient } = require('@aws-sdk/client-opensearchserverless');
      mockSend.mockResolvedValueOnce({
        collectionDetails: [{ name: 'test', status: 'ACTIVE' }],
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(OpenSearchServerlessClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
