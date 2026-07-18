import {
  ElastiCacheClient,
  CreateCacheClusterCommand,
  DeleteCacheClusterCommand,
  DescribeCacheClustersCommand,
} from '@aws-sdk/client-elasticache';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class ElastiCacheAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'ELASTICACHE_REDIS', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['replicationGroupId'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): ElastiCacheClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new ElastiCacheClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new ElastiCacheClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const identifier = config.cacheClusterId ?? '*';
    const clusterArn = `arn:aws:elasticache:${region}:${accountId}:cluster:${identifier}`;

    return {
      provision: [
        {
          actions: [
            'elasticache:CreateCacheCluster',
            'elasticache:DeleteCacheCluster',
            'elasticache:DescribeCacheClusters',
          ],
          resources: ['*'],
        },
        {
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['elasticache:DescribeCacheClusters'],
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
      (config.cacheClusterId as string | undefined) ?? `citadel-redis-${Date.now()}`;

    // Retry up to 3 times for transient IAM propagation errors
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await client.send(
          new CreateCacheClusterCommand({
            CacheClusterId: identifier,
            Engine: 'redis',
            CacheNodeType: 'cache.t3.micro',
            NumCacheNodes: (config.numCacheNodes as number | undefined) ?? 1,
          })
        );

        const arn =
          result.CacheCluster?.ARN ??
          `arn:aws:elasticache:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`;

        return { resourceArn: arn };
      } catch (error) {
        const err = error as SdkError;
        if (err.name === 'CacheClusterAlreadyExistsFault') {
          return {
            resourceArn: `arn:aws:elasticache:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:cluster:${identifier}`,
          };
        }
        // Retry on transient IAM/credentials propagation errors
        if (
          (err.name === 'InvalidCredentialsException' || err.name === 'ServiceLinkedRoleNotFoundFault') &&
          attempt < maxRetries
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
          continue;
        }
        if (
          err.name === 'AccessDenied' ||
          err.name === 'AccessDeniedException'
        ) {
          throw new PermissionError(
            `Permission denied creating ElastiCache cluster ${identifier}`,
            err
          );
        }
        throw new ProvisioningError(
          `Failed to create ElastiCache cluster ${identifier}: ${err.message}`,
          err
        );
      }
    }
    throw new ProvisioningError(`Failed to create ElastiCache cluster ${identifier} after ${maxRetries} retries`);
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.cacheClusterId as string | undefined;

    try {
      const response = await client.send(
        new DescribeCacheClustersCommand({
          CacheClusterId: identifier,
        })
      );
      const status = response.CacheClusters?.[0]?.CacheClusterStatus;
      if (status !== 'available') {
        throw new ConnectionError(
          `ElastiCache cluster ${identifier} is not available (status: ${status})`,
          true
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (err.name === 'CacheClusterNotFoundFault') {
        throw new ResourceNotFoundError(
          `ElastiCache cluster ${identifier} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing ElastiCache cluster ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to ElastiCache cluster ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from ElastiCache doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const identifier = config.cacheClusterId as string | undefined;

    try {
      await client.send(
        new DeleteCacheClusterCommand({ CacheClusterId: identifier })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'CacheClusterNotFoundFault') {
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
    const identifier = config.cacheClusterId as string | undefined;

    try {
      const response = await client.send(
        new DescribeCacheClustersCommand({
          CacheClusterId: identifier,
        })
      );
      const cluster = response.CacheClusters?.[0];
      return {
        success: true,
        message: `Successfully connected to ElastiCache cluster ${identifier}`,
        details: {
          status: cluster?.CacheClusterStatus,
          endpoint: cluster?.ConfigurationEndpoint?.Address,
          port: cluster?.ConfigurationEndpoint?.Port,
          engineVersion: cluster?.EngineVersion,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to ElastiCache cluster ${identifier}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const identifier = config.cacheClusterId as string | undefined;

    try {
      const response = await client.send(
        new DescribeCacheClustersCommand({
          CacheClusterId: identifier,
        })
      );
      const cluster = response.CacheClusters?.[0];
      const numCacheNodes = cluster?.NumCacheNodes ?? 0;

      return {
        size: `${numCacheNodes} node(s)`,
        records: numCacheNodes,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing ElastiCache cluster ${identifier}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for ElastiCache cluster ${identifier}: ${err.message}`,
        true,
        err
      );
    }
  }
}
