import {
  S3TablesClient,
  CreateTableBucketCommand,
  GetTableBucketCommand,
  ListTablesCommand,
} from '@aws-sdk/client-s3tables';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class S3TablesAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'S3_TABLES', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['tableBucketArn'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): S3TablesClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new S3TablesClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new S3TablesClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const bucketArn = `arn:aws:s3tables:${region}:${accountId}:bucket/*`;

    return {
      provision: [
        {
          actions: [
            's3tables:CreateTableBucket',
            's3tables:CreateTable',
            's3tables:GetTableBucket',
          ],
          resources: [bucketArn],
        },
      ],
      connect: [
        {
          actions: [
            's3tables:GetTableBucket',
            's3tables:GetTable',
            's3tables:ListTables',
          ],
          resources: [bucketArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const bucketName =
      (config.tableBucketName as string | undefined) ?? `citadel-s3tables-${Date.now()}`;

    try {
      const result = await client.send(
        new CreateTableBucketCommand({ name: bucketName })
      );

      const resourceArn =
        result.arn ??
        `arn:aws:s3tables:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:bucket/${bucketName}`;

      return { resourceArn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ConflictException') {
        return {
          resourceArn: `arn:aws:s3tables:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:bucket/${bucketName}`,
        };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating S3 Tables bucket ${bucketName}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create S3 Tables bucket ${bucketName}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const tableBucketARN = config.tableBucketARN as string | undefined;

    try {
      const response = await client.send(
        new GetTableBucketCommand({ tableBucketARN })
      );
      if (!response.arn) {
        throw new ResourceNotFoundError(
          `S3 Tables bucket ${tableBucketARN} does not exist`
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ResourceNotFoundError) {
        throw err;
      }
      if (err.name === 'NotFoundException') {
        throw new ResourceNotFoundError(
          `S3 Tables bucket ${tableBucketARN} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing S3 Tables bucket ${tableBucketARN}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to S3 Tables bucket ${tableBucketARN}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from S3 Tables doesn't require cleanup
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const tableBucketARN = config.tableBucketARN as string | undefined;

    try {
      const response = await client.send(
        new GetTableBucketCommand({ tableBucketARN })
      );
      return {
        success: true,
        message: `Successfully connected to S3 Tables bucket`,
        details: {
          arn: response.arn,
          name: response.name,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to S3 Tables bucket ${tableBucketARN}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const tableBucketARN = config.tableBucketARN as string | undefined;

    try {
      const response = await client.send(
        new ListTablesCommand({ tableBucketARN })
      );

      const tableCount = response.tables?.length ?? 0;

      return {
        size: '0 MB',
        records: tableCount,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied listing S3 Tables in bucket ${tableBucketARN}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for S3 Tables bucket ${tableBucketARN}: ${err.message}`,
        true,
        err
      );
    }
  }
}
