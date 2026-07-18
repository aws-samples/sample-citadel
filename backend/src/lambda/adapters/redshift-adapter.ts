import {
  RedshiftClient,
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClustersCommand,
} from '@aws-sdk/client-redshift';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class RedshiftAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'REDSHIFT', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['clusterIdentifier'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): RedshiftClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new RedshiftClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new RedshiftClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const identifier = config.clusterIdentifier ?? '*';
    const clusterArn = `arn:aws:redshift:${region}:${accountId}:cluster:${identifier}`;

    return {
      provision: [
        {
          actions: ['redshift:CreateCluster', 'redshift:DeleteCluster', 'redshift:DescribeClusters'],
          resources: ['*'],
        },
        {
          actions: [
            'ec2:DescribeVpcs',
            'ec2:DescribeSubnets',
            'ec2:DescribeSecurityGroups',
            'ec2:DescribeInternetGateways',
            'ec2:DescribeAccountAttributes',
            'ec2:DescribeAddresses',
            'ec2:DescribeAvailabilityZones',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['redshift:DescribeClusters'],
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
      (config.clusterIdentifier as string | undefined) ?? `citadel-redshift-${Date.now()}`;

    const masterUsername = (credentials?.masterUsername ?? config.masterUsername) as string | undefined;
    const masterPassword = (credentials?.masterPassword ?? config.masterPassword) as string | undefined;

    if (!masterUsername || !masterPassword) {
      throw new ProvisioningError(
        'masterUsername and masterPassword are required to provision a Redshift cluster'
      );
    }

    // Validate Redshift password requirements
    if (!/[A-Z]/.test(masterPassword)) {
      throw new ProvisioningError('masterPassword must contain at least one uppercase letter.');
    }
    if (!/[a-z]/.test(masterPassword)) {
      throw new ProvisioningError('masterPassword must contain at least one lowercase letter.');
    }
    if (!/[0-9]/.test(masterPassword)) {
      throw new ProvisioningError('masterPassword must contain at least one digit.');
    }

    const nodeType = (config.nodeType as string | undefined) ?? 'ra3.xlplus';
    // ra3.xlplus, ra3.4xlarge, ra3.16xlarge require multi-node (min 2 nodes)
    const MULTI_NODE_TYPES = ['ra3.xlplus', 'ra3.4xlarge', 'ra3.16xlarge'];
    const isMultiNode = MULTI_NODE_TYPES.includes(nodeType);
    const numberOfNodes = isMultiNode
      ? Math.max((config.numberOfNodes as number | undefined) ?? 2, 2)
      : ((config.numberOfNodes as number | undefined) ?? 1);
    const clusterType = numberOfNodes > 1 ? 'multi-node' : 'single-node';

    try {
      const result = await client.send(
        new CreateClusterCommand({
          ClusterIdentifier: identifier,
          NodeType: nodeType,
          ClusterType: clusterType,
          MasterUsername: masterUsername,
          MasterUserPassword: masterPassword,
          NumberOfNodes: numberOfNodes,
        })
      );

      const arn =
        result.Cluster?.ClusterNamespaceArn ??
        `arn:aws:redshift:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`;

      return { resourceArn: arn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ClusterAlreadyExistsFault') {
        return {
          resourceArn: `arn:aws:redshift:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`,
        };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Redshift cluster ${identifier}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create Redshift cluster ${identifier}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.clusterIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeClustersCommand({
          ClusterIdentifier: identifier,
        })
      );
      const status = response.Clusters?.[0]?.ClusterStatus;
      if (status !== 'available') {
        throw new ConnectionError(
          `Redshift cluster ${identifier} is not available (status: ${status})`,
          true
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (err.name === 'ClusterNotFoundFault') {
        throw new ResourceNotFoundError(
          `Redshift cluster ${identifier} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Redshift cluster ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to Redshift cluster ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from Redshift doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.clusterIdentifier as string | undefined;

    try {
      await client.send(
        new DeleteClusterCommand({
          ClusterIdentifier: identifier,
          SkipFinalClusterSnapshot: true,
        })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ClusterNotFoundFault') {
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
    const identifier = config.clusterIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeClustersCommand({
          ClusterIdentifier: identifier,
        })
      );
      const cluster = response.Clusters?.[0];
      return {
        success: true,
        message: `Successfully connected to Redshift cluster ${identifier}`,
        details: {
          status: cluster?.ClusterStatus,
          endpoint: cluster?.Endpoint?.Address,
          port: cluster?.Endpoint?.Port,
          numberOfNodes: cluster?.NumberOfNodes,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to Redshift cluster ${identifier}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const identifier = config.clusterIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeClustersCommand({
          ClusterIdentifier: identifier,
        })
      );
      const cluster = response.Clusters?.[0];
      const numberOfNodes = cluster?.NumberOfNodes ?? 0;
      // dc2.large nodes have ~160 GB usable storage each
      const estimatedStorageGB = numberOfNodes * 160;

      return {
        size: `${estimatedStorageGB} GB`,
        records: numberOfNodes,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Redshift cluster ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Redshift cluster ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }
}
