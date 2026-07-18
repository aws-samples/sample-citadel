import {
  KeyspacesClient,
  CreateKeyspaceCommand,
  DeleteKeyspaceCommand,
  GetKeyspaceCommand,
} from '@aws-sdk/client-keyspaces';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class KeyspacesAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'KEYSPACES', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['keyspaceName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): KeyspacesClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new KeyspacesClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new KeyspacesClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const keyspaceName = config.keyspaceName ?? '*';
    const keyspaceArn = `arn:aws:cassandra:${region}:${accountId}:/keyspace/${keyspaceName}`;

    return {
      provision: [
        {
          actions: ['cassandra:Create', 'cassandra:Drop', 'cassandra:Select'],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['cassandra:Select', 'cassandra:Modify'],
          resources: [keyspaceArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const keyspaceName =
      (config.keyspaceName as string | undefined) ?? `citadel-keyspaces-${Date.now()}`;

    try {
      const result = await client.send(
        new CreateKeyspaceCommand({ keyspaceName })
      );

      const resourceArn =
        result.resourceArn ??
        `arn:aws:cassandra:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:/keyspace/${keyspaceName}`;

      return { resourceArn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ConflictException') {
        return {
          resourceArn: `arn:aws:cassandra:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:/keyspace/${keyspaceName}`,
        };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Keyspaces keyspace ${keyspaceName}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to create Keyspaces keyspace ${keyspaceName}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const keyspaceName = config.keyspaceName as string | undefined;

    try {
      const response = await client.send(
        new GetKeyspaceCommand({ keyspaceName })
      );
      if (!response.keyspaceName) {
        throw new ResourceNotFoundError(
          `Keyspaces keyspace ${keyspaceName} does not exist`
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ResourceNotFoundError) {
        throw err;
      }
      if (err.name === 'ResourceNotFoundException') {
        throw new ResourceNotFoundError(
          `Keyspaces keyspace ${keyspaceName} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Keyspaces keyspace ${keyspaceName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to Keyspaces keyspace ${keyspaceName}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from Keyspaces doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const keyspaceName = config.keyspaceName as string | undefined;

    try {
      await client.send(
        new DeleteKeyspaceCommand({ keyspaceName })
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
    const keyspaceName = config.keyspaceName as string | undefined;

    try {
      const response = await client.send(
        new GetKeyspaceCommand({ keyspaceName })
      );
      return {
        success: true,
        message: `Successfully connected to Keyspaces keyspace ${keyspaceName}`,
        details: {
          arn: response.resourceArn,
          status: 'ACTIVE',
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to Keyspaces keyspace ${keyspaceName}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const keyspaceName = config.keyspaceName as string | undefined;

    try {
      await client.send(
        new GetKeyspaceCommand({ keyspaceName })
      );

      return {
        size: '0 MB',
        records: 0,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Keyspaces keyspace ${keyspaceName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Keyspaces keyspace ${keyspaceName}: ${err.message}`,
        true,
        err
      );
    }
  }
}
