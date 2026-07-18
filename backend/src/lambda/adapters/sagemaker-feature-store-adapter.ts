import {
  SageMakerClient,
  CreateFeatureGroupCommand,
  DescribeFeatureGroupCommand,
  type FeatureDefinition,
  type OnlineStoreConfig,
  type OfflineStoreConfig,
} from '@aws-sdk/client-sagemaker';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class SageMakerFeatureStoreAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'SAGEMAKER_FEATURE_STORE', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['featureGroupName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): SageMakerClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new SageMakerClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new SageMakerClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
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
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const featureGroupName =
      (config.featureGroupName as string | undefined) ?? `citadel-feature-store-${Date.now()}`;

    try {
      const result = await client.send(
        new CreateFeatureGroupCommand({
          FeatureGroupName: featureGroupName,
          RecordIdentifierFeatureName: (config.recordIdentifierFeatureName as string | undefined) ?? 'record_id',
          EventTimeFeatureName: (config.eventTimeFeatureName as string | undefined) ?? 'event_time',
          FeatureDefinitions: (config.featureDefinitions as FeatureDefinition[] | undefined) ?? [
            { FeatureName: 'record_id', FeatureType: 'String' },
            { FeatureName: 'event_time', FeatureType: 'String' },
          ],
          OnlineStoreConfig: (config.onlineStoreConfig as OnlineStoreConfig | undefined) ?? { EnableOnlineStore: true },
          OfflineStoreConfig: (config.offlineStoreConfig as OfflineStoreConfig | undefined) ?? {
            S3StorageConfig: {
              S3Uri: (config.s3Uri as string | undefined) ?? `s3://citadel-feature-store-${featureGroupName}`,
            },
          },
        })
      );

      const resourceArn =
        result.FeatureGroupArn ??
        `arn:aws:sagemaker:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:feature-group/${featureGroupName}`;

      return { resourceArn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ResourceInUse') {
        return {
          resourceArn: `arn:aws:sagemaker:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:feature-group/${featureGroupName}`,
        };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating SageMaker feature group ${featureGroupName}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create SageMaker feature group ${featureGroupName}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const featureGroupName = config.featureGroupName as string | undefined;

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
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (err.name === 'ResourceNotFound') {
        throw new ResourceNotFoundError(
          `SageMaker feature group ${featureGroupName} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing SageMaker feature group ${featureGroupName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to SageMaker feature group ${featureGroupName}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from SageMaker Feature Store doesn't require cleanup
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const featureGroupName = config.featureGroupName as string | undefined;

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
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to SageMaker feature group ${featureGroupName}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const featureGroupName = config.featureGroupName as string | undefined;

    try {
      await client.send(
        new DescribeFeatureGroupCommand({ FeatureGroupName: featureGroupName })
      );

      return {
        size: '0 MB',
        records: 0,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing SageMaker feature group ${featureGroupName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for SageMaker feature group ${featureGroupName}: ${err.message}`,
        true,
        err
      );
    }
  }
}
