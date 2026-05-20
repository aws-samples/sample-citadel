import { KeyspacesAdapter } from '../keyspaces-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-keyspaces', () => {
  return {
    KeyspacesClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateKeyspaceCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateKeyspace', input })),
    GetKeyspaceCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetKeyspace', input })),
  };
});

describe('KeyspacesAdapter', () => {
  let adapter: KeyspacesAdapter;
  const config = { keyspaceName: 'my_test_keyspace' };

  beforeEach(() => {
    adapter = new KeyspacesAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for cassandra:Create, cassandra:Select', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'cassandra:Create',
        'cassandra:Drop',
        'cassandra:Select',
      ]);
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
    });

    it('returns connect policies for cassandra:Select, cassandra:Modify', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'cassandra:Select',
        'cassandra:Modify',
      ]);
    });

    it('uses wildcard when keyspaceName is not in config', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a keyspace and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        resourceArn: 'arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace',
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace');
    });

    it('handles ConflictException as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'ConflictException';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my_test_keyspace');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect(err.cause).toBe(sdkError);
      }
    });
  });

  describe('connect', () => {
    it('succeeds when keyspace exists', async () => {
      mockSend.mockResolvedValueOnce({
        keyspaceName: 'my_test_keyspace',
        resourceArn: 'arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace',
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ResourceNotFoundError when keyspace does not exist', async () => {
      const sdkError = new Error('Not found');
      (sdkError as any).name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(sdkError);
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

    it('throws ResourceNotFoundError when keyspaceName is null in response', async () => {
      mockSend.mockResolvedValueOnce({ keyspaceName: null });
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with keyspace details', async () => {
      mockSend.mockResolvedValueOnce({
        keyspaceName: 'my_test_keyspace',
        resourceArn: 'arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace',
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.arn).toBe('arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace');
      expect(result.details?.status).toBe('ACTIVE');
    });

    it('returns failure when GetKeyspace fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns placeholder metrics', async () => {
      mockSend.mockResolvedValueOnce({
        keyspaceName: 'my_test_keyspace',
        resourceArn: 'arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace',
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('0 MB');
      expect(result.records).toBe(0);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      (sdkError as any).name = 'RequestTimeout';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      const { KeyspacesClient } = require('@aws-sdk/client-keyspaces');
      mockSend.mockResolvedValueOnce({
        keyspaceName: 'my_test_keyspace',
        resourceArn: 'arn:aws:cassandra:us-east-1:123:/keyspace/my_test_keyspace',
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(KeyspacesClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
