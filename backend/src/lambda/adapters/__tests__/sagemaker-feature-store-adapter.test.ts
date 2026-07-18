import { SageMakerFeatureStoreAdapter } from '../sagemaker-feature-store-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { SageMakerClient, CreateFeatureGroupCommand } from '@aws-sdk/client-sagemaker';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sagemaker', () => {
  return {
    SageMakerClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateFeatureGroupCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateFeatureGroup', input })),
    DescribeFeatureGroupCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeFeatureGroup', input })),
  };
});

describe('SageMakerFeatureStoreAdapter', () => {
  let adapter: SageMakerFeatureStoreAdapter;
  const config = { featureGroupName: 'my-feature-group' };

  beforeEach(() => {
    adapter = new SageMakerFeatureStoreAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for sagemaker:CreateFeatureGroup, sagemaker:DescribeFeatureGroup', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'sagemaker:CreateFeatureGroup',
        'sagemaker:DescribeFeatureGroup',
      ]);
      expect(policies.provision[0].resources).toEqual([
        'arn:aws:sagemaker:us-east-1:123456789012:feature-group/*',
      ]);
    });

    it('returns connect policies including sagemaker:BatchGetRecord', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'sagemaker:DescribeFeatureGroup',
        'sagemaker:GetRecord',
        'sagemaker:PutRecord',
        'sagemaker:BatchGetRecord',
      ]);
    });

    it('uses wildcard resource ARN pattern', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual([
        'arn:aws:sagemaker:us-west-2:123456789012:feature-group/*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a feature group with online and offline store config and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group');
      const cmdInput = CreateFeatureGroupCommand.mock.calls[0][0];
      expect(cmdInput.OnlineStoreConfig).toBeDefined();
      expect(cmdInput.OfflineStoreConfig).toBeDefined();
    });

    it('handles ResourceInUse as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      sdkError.name = 'ResourceInUse';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-feature-group');
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
    it('succeeds when feature group status is Created', async () => {
      mockSend.mockResolvedValueOnce({
        FeatureGroupStatus: 'Created',
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when feature group status is not Created', async () => {
      mockSend.mockResolvedValueOnce({
        FeatureGroupStatus: 'Creating',
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
      });
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when feature group does not exist', async () => {
      const sdkError = new Error('Not found');
      sdkError.name = 'ResourceNotFound';
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
    it('returns success with feature group details including creation time', async () => {
      const creationTime = new Date('2024-01-15T10:30:00Z');
      mockSend.mockResolvedValueOnce({
        FeatureGroupStatus: 'Created',
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
        CreationTime: creationTime,
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.status).toBe('Created');
      expect(result.details?.arn).toBe('arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group');
      expect(result.details?.creationTime).toBe('2024-01-15T10:30:00.000Z');
    });

    it('returns failure when DescribeFeatureGroup fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns placeholder metrics', async () => {
      mockSend.mockResolvedValueOnce({
        FeatureGroupStatus: 'Created',
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
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
        FeatureGroupStatus: 'Created',
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(SageMakerClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
