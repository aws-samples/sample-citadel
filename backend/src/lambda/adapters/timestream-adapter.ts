import {
  TimestreamWriteClient,
  CreateDatabaseCommand,
  CreateTableCommand,
  DeleteDatabaseCommand,
  DescribeDatabaseCommand,
  type RetentionProperties,
} from '@aws-sdk/client-timestream-write';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class TimestreamAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'TIMESTREAM', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['databaseName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): TimestreamWriteClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new TimestreamWriteClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new TimestreamWriteClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const databaseArn = `arn:aws:timestream:${region}:${accountId}:database/${config.databaseName ?? '*'}`;

    return {
      provision: [
        {
          actions: [
            'timestream:CreateDatabase',
            'timestream:DeleteDatabase',
            'timestream:CreateTable',
            'timestream:DescribeDatabase',
            'timestream:DescribeEndpoints',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: [
            'timestream:DescribeDatabase',
            'timestream:DescribeTable',
            'timestream:WriteRecords',
            'timestream:Select',
          ],
          resources: [databaseArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const databaseName =
      (config.databaseName as string | undefined) ?? `citadel-timestream-${Date.now()}`;

    try {
      const dbResult = await client.send(
        new CreateDatabaseCommand({ DatabaseName: databaseName })
      );

      const resourceArn =
        dbResult.Database?.Arn ??
        `arn:aws:timestream:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:database/${databaseName}`;

      if (config.tableName) {
        try {
          await client.send(
            new CreateTableCommand({
              DatabaseName: databaseName,
              TableName: config.tableName as string,
              RetentionProperties: config.retentionProperties as RetentionProperties | undefined,
            })
          );
        } catch (tableError) {
          const err = tableError as SdkError;
          if (err.name !== 'ConflictException') {
            throw err;
          }
        }
      }

      return { resourceArn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ConflictException') {
        return {
          resourceArn: `arn:aws:timestream:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:database/${databaseName}`,
        };
      }
      if (err.message?.includes('discover endpoint')) {
        throw new ProvisioningError(
          `Timestream is not available in this account/region. The endpoint discovery failed. Please check that Timestream for LiveAnalytics is enabled for your account.`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Timestream database ${databaseName}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create Timestream database ${databaseName}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName as string | undefined;

    try {
      const response = await client.send(
        new DescribeDatabaseCommand({ DatabaseName: databaseName })
      );
      if (!response.Database) {
        throw new ResourceNotFoundError(
          `Timestream database ${databaseName} does not exist`
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ResourceNotFoundError) {
        throw err;
      }
      if (err.name === 'ResourceNotFoundException') {
        throw new ResourceNotFoundError(
          `Timestream database ${databaseName} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Timestream database ${databaseName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to Timestream database ${databaseName}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from Timestream doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName as string | undefined;

    try {
      await client.send(
        new DeleteDatabaseCommand({ DatabaseName: databaseName })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ResourceNotFoundException') {
        return; // Already gone
      }
      throw err;
    }
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName as string | undefined;

    try {
      const response = await client.send(
        new DescribeDatabaseCommand({ DatabaseName: databaseName })
      );
      const database = response.Database;
      return {
        success: true,
        message: `Successfully connected to Timestream database ${databaseName}`,
        details: {
          arn: database?.Arn,
          tableCount: database?.TableCount,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to Timestream database ${databaseName}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const databaseName = config.databaseName as string | undefined;

    try {
      const response = await client.send(
        new DescribeDatabaseCommand({ DatabaseName: databaseName })
      );
      const tableCount = response.Database?.TableCount ?? 0;

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
          `Permission denied describing Timestream database ${databaseName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Timestream database ${databaseName}: ${err.message}`,
        true,
        err
      );
    }
  }
}
