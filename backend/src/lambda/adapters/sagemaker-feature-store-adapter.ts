import {
  SageMakerClient,
  CreateFeatureGroupCommand,
  DescribeFeatureGroupCommand,
} from '@aws-sdk/client-sagemaker';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

export class SageMakerFeatureStoreAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'SAGEMAKER_FEATURE_STORE', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['featureGroupName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): SageMakerClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new SageMakerClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new SageMakerClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const featureGroupArn = `arn:aws:sagemaker:${region}:${accountId}:feature-group/*`;

    return {
      provision: [
        {
          actions: ['sagemaker:CreateFeatureGroup', 'sagemaker:DescribeFeatureGroup'],
          resources: [featureGroupArn],
        },
      ],
      connect: [
        {
          actions: [
            'sagemaker:DescribeFeatureGroup',
            'sagemaker:GetRecord',
            'sagemaker:PutRecord',
            'sagemaker:BatchGetRecord',
          ],
          resources: [featureGroupArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const featureGroupName = config.featureGroupName ?? `citadel-feature-store-${Date.now()}`;

    try {
      const result = await client.send(
        new CreateFeatureGroupCommand({
          FeatureGroupName: featureGroupName,
          RecordIdentifierFeatureName: config.recordIdentifierFeatureName ?? 'record_id',
          EventTimeFeatureName: config.eventTimeFeatureName ?? 'event_time',
          FeatureDefinitions: config.featureDefinitions ?? [
            { FeatureName: 'record_id', FeatureType: 'String' },
            { FeatureName: 'event_time', FeatureType: 'String' },
          ],
          OnlineStoreConfig: config.onlineStoreConfig ?? { EnableOnlineStore: true },
          OfflineStoreConfig: config.offlineStoreConfig ?? {
            S3StorageConfig: {
              S3Uri: config.s3Uri ?? `s3://citadel-feature-store-${featureGroupName}`,
            },
          },
        })
      );

      const resourceArn =
        result.FeatureGroupArn ??
        `arn:aws:sagemaker:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:feature-group/${featureGroupName}`;

      return { resourceArn };
    } catch (error: any) {
      if (error.name === 'ResourceInUse') {
        return {
          resourceArn: `arn:aws:sagemaker:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:feature-group/${featureGroupName}`,
        };
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating SageMaker feature group ${featureGroupName}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create SageMaker feature group ${featureGroupName}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const featureGroupName = config.featureGroupName;

    try {
      const response = await client.send(
        new DescribeFeatureGroupCommand({ FeatureGroupName: featureGroupName })
      );
      if (response.FeatureGroupStatus !== 'Created') {
        throw new ConnectionError(
          `SageMaker feature group ${featureGroupName} is not ready (status: ${response.FeatureGroupStatus})`,
          true
        );
      }
    } catch (error: any) {
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error.name === 'ResourceNotFound') {
        throw new ResourceNotFoundError(
          `SageMaker feature group ${featureGroupName} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing SageMaker feature group ${featureGroupName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to SageMaker feature group ${featureGroupName}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from SageMaker Feature Store doesn't require cleanup
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const featureGroupName = config.featureGroupName;

    try {
      const response = await client.send(
        new DescribeFeatureGroupCommand({ FeatureGroupName: featureGroupName })
      );
      return {
        success: true,
        message: `Successfully connected to SageMaker feature group ${featureGroupName}`,
        details: {
          status: response.FeatureGroupStatus,
          arn: response.FeatureGroupArn,
          creationTime: response.CreationTime?.toISOString(),
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to SageMaker feature group ${featureGroupName}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const featureGroupName = config.featureGroupName;

    try {
      await client.send(
        new DescribeFeatureGroupCommand({ FeatureGroupName: featureGroupName })
      );

      return {
        size: '0 MB',
        records: 0,
      };
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing SageMaker feature group ${featureGroupName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for SageMaker feature group ${featureGroupName}: ${error.message}`,
        true,
        error
      );
    }
  }
}
