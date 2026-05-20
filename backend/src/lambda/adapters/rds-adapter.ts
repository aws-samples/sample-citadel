import {
  RDSClient,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  AddTagsToResourceCommand,
} from '@aws-sdk/client-rds';
import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import {
  ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError,
} from './errors';

export class RdsAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec;

  constructor(private engine: 'postgres' | 'mysql') {
    this.spec = { type: engine === 'postgres' ? 'RDS_POSTGRESQL' : 'RDS_MYSQL', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['instanceIdentifier'], optional: [], ssmParameters: [] } };
  }

  private makeClient(creds?: Record<string, any>): RDSClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new RDSClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new RDSClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
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
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const identifier =
      config.dbInstanceIdentifier ??
      `citadel-${this.engine}-${Date.now()}`;
    const engineName = this.engine === 'postgres' ? 'postgres' : 'mysql';

    const masterUsername = credentials?.masterUsername ?? config.masterUsername;
    const masterPassword = credentials?.masterPassword ?? config.masterPassword;

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
          DBInstanceClass: config.dbInstanceClass ?? 'db.t3.micro',
          AllocatedStorage: config.allocatedStorage ?? 20,
          MasterUsername: masterUsername,
          MasterUserPassword: masterPassword,
        })
      );

      const arn =
        result.DBInstance?.DBInstanceArn ??
        `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:db:${identifier}`;

      return { resourceArn: arn };
    } catch (error: any) {
      if (error.name === 'DBInstanceAlreadyExistsFault') {
        return {
          resourceArn: `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:db:${identifier}`,
        };
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating RDS instance ${identifier}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create RDS instance ${identifier}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbInstanceIdentifier;

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
    } catch (error: any) {
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error.name === 'DBInstanceNotFoundFault') {
        throw new ResourceNotFoundError(
          `RDS instance ${identifier} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing RDS instance ${identifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to RDS instance ${identifier}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from RDS doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbInstanceIdentifier;

    try {
      await client.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          SkipFinalSnapshot: true,
        })
      );
    } catch (error: any) {
      if (error.name === 'DBInstanceNotFoundFault') {
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
    const identifier = config.dbInstanceIdentifier;

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
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to RDS instance ${identifier}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const identifier = config.dbInstanceIdentifier;

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
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing RDS instance ${identifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for RDS instance ${identifier}: ${error.message}`,
        true,
        error
      );
    }
  }
}
