import {
  RDSClient,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import {
  ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError,
} from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class RdsAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec;

  constructor(private engine: 'postgres' | 'mysql') {
    this.spec = { type: engine === 'postgres' ? 'RDS_POSTGRESQL' : 'RDS_MYSQL', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['instanceIdentifier'], optional: [], ssmParameters: [] } };
  }

  private makeClient(creds?: Record<string, unknown>): RDSClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new RDSClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new RDSClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const dbArn = `arn:aws:rds:${region}:${accountId}:db:${config.dbInstanceIdentifier ?? '*'}`;

    return {
      provision: [
        {
          actions: [
            'rds:CreateDBInstance',
            'rds:DeleteDBInstance',
            'rds:DescribeDBInstances',
            'rds:AddTagsToResource',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['rds:DescribeDBInstances'],
          resources: [dbArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const identifier =
      (config.dbInstanceIdentifier as string | undefined) ??
      `citadel-${this.engine}-${Date.now()}`;
    const engineName = this.engine === 'postgres' ? 'postgres' : 'mysql';

    const masterUsername = (credentials?.masterUsername ?? config.masterUsername) as string | undefined;
    const masterPassword = (credentials?.masterPassword ?? config.masterPassword) as string | undefined;

    if (!masterUsername || !masterPassword) {
      throw new ProvisioningError(
        'masterUsername and masterPassword are required to provision an RDS instance'
      );
    }

    // PostgreSQL reserves certain usernames
    const POSTGRES_RESERVED_USERNAMES = ['admin', 'postgres', 'rdsadmin'];
    if (this.engine === 'postgres' && POSTGRES_RESERVED_USERNAMES.includes(masterUsername.toLowerCase())) {
      throw new ProvisioningError(
        `masterUsername "${masterUsername}" is a reserved word for PostgreSQL. Use a different username (e.g. "dbadmin").`
      );
    }

    try {
      const result = await client.send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          Engine: engineName,
          DBInstanceClass: (config.dbInstanceClass as string | undefined) ?? 'db.t3.micro',
          AllocatedStorage: (config.allocatedStorage as number | undefined) ?? 20,
          MasterUsername: masterUsername,
          MasterUserPassword: masterPassword,
        })
      );

      const arn =
        result.DBInstance?.DBInstanceArn ??
        `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:db:${identifier}`;

      return { resourceArn: arn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'DBInstanceAlreadyExistsFault') {
        return {
          resourceArn: `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:db:${identifier}`,
        };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating RDS instance ${identifier}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create RDS instance ${identifier}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: identifier,
        })
      );
      const status = response.DBInstances?.[0]?.DBInstanceStatus;
      if (status !== 'available') {
        throw new ConnectionError(
          `RDS instance ${identifier} is not available (status: ${status})`,
          true
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (err.name === 'DBInstanceNotFoundFault') {
        throw new ResourceNotFoundError(
          `RDS instance ${identifier} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing RDS instance ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to RDS instance ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from RDS doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      await client.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          SkipFinalSnapshot: true,
        })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'DBInstanceNotFoundFault') {
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
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: identifier,
        })
      );
      const instance = response.DBInstances?.[0];
      return {
        success: true,
        message: `Successfully connected to RDS instance ${identifier}`,
        details: {
          status: instance?.DBInstanceStatus,
          endpoint: instance?.Endpoint?.Address,
          port: instance?.Endpoint?.Port,
          engine: instance?.Engine,
          allocatedStorage: instance?.AllocatedStorage,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to RDS instance ${identifier}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: identifier,
        })
      );
      const instance = response.DBInstances?.[0];
      const allocatedGB = instance?.AllocatedStorage ?? 0;

      return {
        size: `${allocatedGB} GB`,
        records: 0, // RDS doesn't expose row count via API
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing RDS instance ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for RDS instance ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }
}
