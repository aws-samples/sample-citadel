import { SageMakerLakehouseAdapter } from '../sagemaker-lakehouse-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sagemaker', () => {
  return {
    SageMakerClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateFeatureGroupCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateFeatureGroup', input })),
    DescribeFeatureGroupCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeFeatureGroup', input })),
  };
});

describe('SageMakerLakehouseAdapter', () => {
  let adapter: SageMakerLakehouseAdapter;
  const config = { featureGroupName: 'my-feature-group' };

  beforeEach(() => {
    adapter = new SageMakerLakehouseAdapter();
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

    it('returns connect policies for sagemaker:DescribeFeatureGroup, sagemaker:GetRecord, sagemaker:PutRecord', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'sagemaker:DescribeFeatureGroup',
        'sagemaker:GetRecord',
        'sagemaker:PutRecord',
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
    it('creates a feature group and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group');
    });

    it('handles ResourceInUse as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'ResourceInUse';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-feature-group');
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
      (sdkError as any).name = 'ResourceNotFound';
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
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with feature group details', async () => {
      mockSend.mockResolvedValueOnce({
        FeatureGroupStatus: 'Created',
        FeatureGroupArn: 'arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group',
        RecordIdentifierFeatureName: 'record_id',
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.status).toBe('Created');
      expect(result.details?.arn).toBe('arn:aws:sagemaker:us-east-1:123:feature-group/my-feature-group');
      expect(result.details?.recordIdentifierFeatureName).toBe('record_id');
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
      const { SageMakerClient } = require('@aws-sdk/client-sagemaker');
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
