import {
  NeptuneClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  DescribeDBClustersCommand,
} from '@aws-sdk/client-neptune';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

export class NeptuneAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'NEPTUNE', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['clusterIdentifier'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): NeptuneClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new NeptuneClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new NeptuneClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const identifier = config.dbClusterIdentifier ?? '*';
    const clusterArn = `arn:aws:rds:${region}:${accountId}:cluster:${identifier}`;
    const neptuneDbArn = `arn:aws:neptune-db:${region}:${accountId}:*`;

    return {
      provision: [
        {
          actions: ['neptune-db:*'],
          resources: ['*'],
        },
        {
          actions: ['rds:CreateDBCluster', 'rds:DeleteDBCluster', 'rds:DescribeDBClusters'],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['neptune-db:*'],
          resources: [neptuneDbArn],
        },
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
      config.dbClusterIdentifier ?? `citadel-neptune-${Date.now()}`;

    try {
      const result = await client.send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: identifier,
          Engine: 'neptune',
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
          `Permission denied creating Neptune cluster ${identifier}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create Neptune cluster ${identifier}: ${error.message}`,
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
          `Neptune cluster ${identifier} is not available (status: ${status})`,
          true
        );
      }
    } catch (error: any) {
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (error.name === 'DBClusterNotFoundFault') {
        throw new ResourceNotFoundError(
          `Neptune cluster ${identifier} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Neptune cluster ${identifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Neptune cluster ${identifier}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from Neptune doesn't require cleanup
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
        message: `Successfully connected to Neptune cluster ${identifier}`,
        details: {
          status: cluster?.Status,
          endpoint: cluster?.Endpoint,
          port: cluster?.Port,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to Neptune cluster ${identifier}: ${error.message}`,
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
        records: 0, // Neptune doesn't expose record count via API
      };
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Neptune cluster ${identifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Neptune cluster ${identifier}: ${error.message}`,
        true,
        error
      );
    }
  }
}
