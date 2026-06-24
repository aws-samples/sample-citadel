import {
  TimestreamWriteClient,
  CreateDatabaseCommand,
  CreateTableCommand,
  DeleteDatabaseCommand,
  DescribeDatabaseCommand,
} from '@aws-sdk/client-timestream-write';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

export class TimestreamAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'TIMESTREAM', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['databaseName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): TimestreamWriteClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new TimestreamWriteClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new TimestreamWriteClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
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
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName ?? `citadel-timestream-${Date.now()}`;

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
              TableName: config.tableName,
              RetentionProperties: config.retentionProperties,
            })
          );
        } catch (tableError: any) {
          if (tableError.name !== 'ConflictException') {
            throw tableError;
          }
        }
      }

      return { resourceArn };
    } catch (error: any) {
      if (error.name === 'ConflictException') {
        return {
          resourceArn: `arn:aws:timestream:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:database/${databaseName}`,
        };
      }
      if (error.message?.includes('discover endpoint')) {
        throw new ProvisioningError(
          `Timestream is not available in this account/region. The endpoint discovery failed. Please check that Timestream for LiveAnalytics is enabled for your account.`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Timestream database ${databaseName}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create Timestream database ${databaseName}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName;

    try {
      const response = await client.send(
        new DescribeDatabaseCommand({ DatabaseName: databaseName })
      );
      if (!response.Database) {
        throw new ResourceNotFoundError(
          `Timestream database ${databaseName} does not exist`
        );
      }
    } catch (error: any) {
      if (error instanceof ResourceNotFoundError) {
        throw error;
      }
      if (error.name === 'ResourceNotFoundException') {
        throw new ResourceNotFoundError(
          `Timestream database ${databaseName} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Timestream database ${databaseName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Timestream database ${databaseName}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from Timestream doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName;

    try {
      await client.send(
        new DeleteDatabaseCommand({ DatabaseName: databaseName })
      );
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        return; // Already gone
      }
      throw error;
    }
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const databaseName = config.databaseName;

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
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to Timestream database ${databaseName}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const databaseName = config.databaseName;

    try {
      const response = await client.send(
        new DescribeDatabaseCommand({ DatabaseName: databaseName })
      );
      const tableCount = response.Database?.TableCount ?? 0;

      return {
        size: '0 MB',
        records: tableCount,
      };
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Timestream database ${databaseName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Timestream database ${databaseName}: ${error.message}`,
        true,
        error
      );
    }
  }
}
