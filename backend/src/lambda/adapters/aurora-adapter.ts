import {
  RDSClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  DescribeDBClustersCommand,
} from '@aws-sdk/client-rds';
import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import {
  ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError,
} from './errors';

export class AuroraAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec;

  constructor(private engine: 'postgres' | 'mysql') {
    this.spec = { type: engine === 'postgres' ? 'AURORA_POSTGRESQL' : 'AURORA_MYSQL', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['clusterIdentifier'], optional: [], ssmParameters: [] } };
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
    const clusterArn = `arn:aws:rds:${region}:${accountId}:cluster:${config.dbClusterIdentifier ?? '*'}`;

    return {
      provision: [
        {
          actions: [
            'rds:CreateDBCluster',
            'rds:DeleteDBCluster',
            'rds:DescribeDBClusters',
            'rds:AddTagsToResource',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['rds:DescribeDBClusters'],
          resources: [clusterArn],
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
      config.dbClusterIdentifier ??
      `citadel-aurora-${this.engine}-${Date.now()}`;
    const engineName = this.engine === 'postgres' ? 'aurora-postgresql' : 'aurora-mysql';

    const masterUsername = credentials?.masterUsername ?? config.masterUsername;
    const masterPassword = credentials?.masterPassword ?? config.masterPassword;

    if (!masterUsername || !masterPassword) {
      throw new ProvisioningError(
        'masterUsername and masterPassword are required to provision an Aurora cluster'
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
        new CreateDBClusterCommand({
          DBClusterIdentifier: identifier,
          Engine: engineName,
          MasterUsername: masterUsername,
          MasterUserPassword: masterPassword,
        })
      );

      const arn =
        result.DBCluster?.DBClusterArn ??
        `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`;

      return { resourceArn: arn };
    } catch (error: any) {
      if (error.name === 'DBClusterAlreadyExistsFault') {
        return {
          resourceArn: `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`,
        };
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Aurora cluster ${identifier}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create Aurora cluster ${identifier}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbClusterIdentifier;

    try {
      const response = await client.send(
        new DescribeDBClustersCommand({
          DBClusterIdentifier: identifier,
        })
      );
      const status = response.DBClusters?.[0]?.Status;
      if (status !== 'available') {
        throw new ConnectionError(
          `Aurora cluster ${identifier} is not available (status: ${status})`,
          true
        );
      }
    } catch (error: any) {
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error.name === 'DBClusterNotFoundFault') {
        throw new ResourceNotFoundError(
          `Aurora cluster ${identifier} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Aurora cluster ${identifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Aurora cluster ${identifier}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from Aurora doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbClusterIdentifier;

    try {
      await client.send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: identifier,
          SkipFinalSnapshot: true,
        })
      );
    } catch (error: any) {
      if (error.name === 'DBClusterNotFoundFault') {
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
    const identifier = config.dbClusterIdentifier;

    try {
      const response = await client.send(
        new DescribeDBClustersCommand({
          DBClusterIdentifier: identifier,
        })
      );
      const cluster = response.DBClusters?.[0];
      return {
        success: true,
        message: `Successfully connected to Aurora cluster ${identifier}`,
        details: {
          status: cluster?.Status,
          endpoint: cluster?.Endpoint,
          port: cluster?.Port,
          engine: cluster?.Engine,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to Aurora cluster ${identifier}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const identifier = config.dbClusterIdentifier;

    try {
      const response = await client.send(
        new DescribeDBClustersCommand({
          DBClusterIdentifier: identifier,
        })
      );
      const cluster = response.DBClusters?.[0];
      const allocatedGB = cluster?.AllocatedStorage ?? 0;

      return {
        size: `${allocatedGB} GB`,
        records: 0, // Aurora doesn't expose row count via API
      };
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Aurora cluster ${identifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Aurora cluster ${identifier}: ${error.message}`,
        true,
        error
      );
    }
  }
}
