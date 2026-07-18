import { LakeFormationAdapter } from '../lake-formation-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { LakeFormationClient } from '@aws-sdk/client-lakeformation';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-lakeformation', () => {
  return {
    LakeFormationClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    RegisterResourceCommand: jest.fn().mockImplementation((input) => ({ _type: 'RegisterResource', input })),
    GetDataLakeSettingsCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetDataLakeSettings', input })),
  };
});

describe('LakeFormationAdapter', () => {
  let adapter: LakeFormationAdapter;
  const config = { resourceArn: 'arn:aws:s3:::my-data-lake-bucket' };

  beforeEach(() => {
    adapter = new LakeFormationAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for lakeformation actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'lakeformation:RegisterResource',
        'lakeformation:GetDataLakeSettings',
        'lakeformation:GrantPermissions',
      ]);
      expect(policies.provision[0].resources).toEqual(['*']);
    });

    it('returns connect policies for lakeformation read actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'lakeformation:GetDataLakeSettings',
        'lakeformation:ListPermissions',
      ]);
      expect(policies.connect[0].resources).toEqual([
        'arn:aws:lakeformation:us-east-1:123456789012:*',
      ]);
    });
  });

  describe('provision', () => {
    it('registers a resource and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:s3:::my-data-lake-bucket');
    });

    it('handles AlreadyExistsException as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      sdkError.name = 'AlreadyExistsException';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:s3:::my-data-lake-bucket');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      sdkError.name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe('connect', () => {
    it('succeeds when data lake settings exist', async () => {
      mockSend.mockResolvedValueOnce({
        DataLakeSettings: {
          DataLakeAdmins: [{ DataLakePrincipalIdentifier: 'arn:aws:iam::123:role/admin' }],
          TrustedResourceOwners: ['123456789012'],
        },
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ResourceNotFoundError when settings are null', async () => {
      mockSend.mockResolvedValueOnce({ DataLakeSettings: null });
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws ResourceNotFoundError on EntityNotFoundException', async () => {
      const sdkError = new Error('Not found');
      sdkError.name = 'EntityNotFoundException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDeniedException', async () => {
      const sdkError = new Error('Forbidden');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError with cause', async () => {
      const sdkError = new Error('Network issue');
      sdkError.name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with data lake settings details', async () => {
      mockSend.mockResolvedValueOnce({
        DataLakeSettings: {
          DataLakeAdmins: [{ DataLakePrincipalIdentifier: 'arn:aws:iam::123:role/admin' }],
          TrustedResourceOwners: ['123456789012'],
        },
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.dataLakeAdmins).toHaveLength(1);
      expect(result.details?.trustedResourceOwners).toEqual(['123456789012']);
    });

    it('returns failure when GetDataLakeSettings fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });

    it('returns empty arrays when settings fields are undefined', async () => {
      mockSend.mockResolvedValueOnce({
        DataLakeSettings: {},
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.dataLakeAdmins).toEqual([]);
      expect(result.details?.trustedResourceOwners).toEqual([]);
    });
  });

  describe('getMetrics', () => {
    it('returns placeholder metrics', async () => {
      mockSend.mockResolvedValueOnce({
        DataLakeSettings: {},
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('0 MB');
      expect(result.records).toBe(0);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      sdkError.name = 'RequestTimeout';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      mockSend.mockResolvedValueOnce({
        DataLakeSettings: {
          DataLakeAdmins: [],
          TrustedResourceOwners: [],
        },
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(LakeFormationClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
