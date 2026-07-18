import {
  NeptuneClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  DescribeDBClustersCommand,
} from '@aws-sdk/client-neptune';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class NeptuneAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'NEPTUNE', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['clusterIdentifier'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): NeptuneClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new NeptuneClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new NeptuneClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
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
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const identifier =
      (config.dbClusterIdentifier as string | undefined) ?? `citadel-neptune-${Date.now()}`;

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
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'DBClusterAlreadyExistsFault') {
        return {
          resourceArn: `arn:aws:rds:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`,
        };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Neptune cluster ${identifier}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create Neptune cluster ${identifier}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbClusterIdentifier as string | undefined;

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
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (err.name === 'DBClusterNotFoundFault') {
        throw new ResourceNotFoundError(
          `Neptune cluster ${identifier} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Neptune cluster ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to Neptune cluster ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from Neptune doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.dbClusterIdentifier as string | undefined;

    try {
      await client.send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: identifier,
          SkipFinalSnapshot: true,
        })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'DBClusterNotFoundFault') {
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
    const identifier = config.dbClusterIdentifier as string | undefined;

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
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to Neptune cluster ${identifier}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const identifier = config.dbClusterIdentifier as string | undefined;

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
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Neptune cluster ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Neptune cluster ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }
}
