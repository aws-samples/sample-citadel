import {
  KeyspacesClient,
  CreateKeyspaceCommand,
  DeleteKeyspaceCommand,
  GetKeyspaceCommand,
} from '@aws-sdk/client-keyspaces';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

export class KeyspacesAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'KEYSPACES', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['keyspaceName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): KeyspacesClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new KeyspacesClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new KeyspacesClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
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
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const keyspaceName = config.keyspaceName ?? `citadel-keyspaces-${Date.now()}`;

    try {
      const result = await client.send(
        new CreateKeyspaceCommand({ keyspaceName })
      );

      const resourceArn =
        result.resourceArn ??
        `arn:aws:cassandra:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:/keyspace/${keyspaceName}`;

      return { resourceArn };
    } catch (error: any) {
      if (error.name === 'ConflictException') {
        return {
          resourceArn: `arn:aws:cassandra:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:/keyspace/${keyspaceName}`,
        };
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating Keyspaces keyspace ${keyspaceName}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create Keyspaces keyspace ${keyspaceName}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const keyspaceName = config.keyspaceName;

    try {
      const response = await client.send(
        new GetKeyspaceCommand({ keyspaceName })
      );
      if (!response.keyspaceName) {
        throw new ResourceNotFoundError(
          `Keyspaces keyspace ${keyspaceName} does not exist`
        );
      }
    } catch (error: any) {
      if (error instanceof ResourceNotFoundError) {
        throw error;
      }
      if (error.name === 'ResourceNotFoundException') {
        throw new ResourceNotFoundError(
          `Keyspaces keyspace ${keyspaceName} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing Keyspaces keyspace ${keyspaceName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Keyspaces keyspace ${keyspaceName}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from Keyspaces doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const keyspaceName = config.keyspaceName;

    try {
      await client.send(
        new DeleteKeyspaceCommand({ keyspaceName })
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
    const keyspaceName = config.keyspaceName;

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
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to Keyspaces keyspace ${keyspaceName}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const keyspaceName = config.keyspaceName;

    try {
      await client.send(
        new GetKeyspaceCommand({ keyspaceName })
      );

      return {
        size: '0 MB',
        records: 0,
      };
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing Keyspaces keyspace ${keyspaceName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Keyspaces keyspace ${keyspaceName}: ${error.message}`,
        true,
        error
      );
    }
  }
}
