import {
  OpenSearchServerlessClient,
  CreateCollectionCommand,
  CreateSecurityPolicyCommand,
  DeleteCollectionCommand,
  BatchGetCollectionCommand,
} from '@aws-sdk/client-opensearchserverless';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

export class OpenSearchAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'OPENSEARCH', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['collectionName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): OpenSearchServerlessClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new OpenSearchServerlessClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new OpenSearchServerlessClient({});
  }

  requiredPolicies(
    _config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const collectionArn = `arn:aws:aoss:${region}:${accountId}:collection/*`;

    return {
      provision: [
        {
          actions: [
            'aoss:CreateCollection',
            'aoss:DeleteCollection',
            'aoss:BatchGetCollection',
          ],
          resources: [collectionArn],
        },
        {
          actions: [
            'aoss:CreateSecurityPolicy',
            'aoss:GetSecurityPolicy',
            'aoss:CreateAccessPolicy',
            'aoss:GetAccessPolicy',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: ['aoss:BatchGetCollection', 'aoss:APIAccessAll'],
          resources: [collectionArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const name = config.collectionName ?? `citadel-os-${Date.now()}`;
    const type = config.collectionType === 'VECTORSEARCH' ? 'VECTORSEARCH' : 'SEARCH';
    const policyName = `aifos-${name.substring(0, 30)}`;

    // Create encryption policy (required before collection creation)
    try {
      await client.send(new CreateSecurityPolicyCommand({
        name: policyName,
        type: 'encryption',
        description: `Encryption policy for collection ${name}`,
        policy: JSON.stringify({
          Rules: [{ ResourceType: 'collection', Resource: [`collection/${name}`] }],
          AWSOwnedKey: true,
        }),
      }));
    } catch (error: any) {
      if (error.name !== 'ConflictException') {
        throw new ProvisioningError(`Failed to create encryption policy for ${name}: ${error.message}`, error);
      }
    }

    // Create network policy (public access)
    try {
      await client.send(new CreateSecurityPolicyCommand({
        name: policyName,
        type: 'network',
        description: `Network policy for collection ${name}`,
        policy: JSON.stringify([{
          Description: `Public access for ${name}`,
          Rules: [
            { ResourceType: 'dashboard', Resource: [`collection/${name}`] },
            { ResourceType: 'collection', Resource: [`collection/${name}`] },
          ],
          AllowFromPublic: true,
        }]),
      }));
    } catch (error: any) {
      if (error.name !== 'ConflictException') {
        throw new ProvisioningError(`Failed to create network policy for ${name}: ${error.message}`, error);
      }
    }

    try {
      const result = await client.send(
        new CreateCollectionCommand({ name, type })
      );

      const arn =
        result.createCollectionDetail?.arn ??
        `arn:aws:aoss:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:collection/${name}`;

      return { resourceArn: arn };
    } catch (error: any) {
      if (error.name === 'ConflictException') {
        return {
          resourceArn: `arn:aws:aoss:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:collection/${name}`,
        };
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating OpenSearch collection ${name}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to create OpenSearch collection ${name}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const names = config.collectionName ? [config.collectionName] : undefined;
    const ids = config.collectionId ? [config.collectionId] : undefined;

    try {
      const response = await client.send(
        new BatchGetCollectionCommand({ names, ids })
      );
      const collection = response.collectionDetails?.[0];
      if (!collection) {
        throw new ResourceNotFoundError(
          `OpenSearch collection not found: ${config.collectionName ?? config.collectionId}`
        );
      }
      if (collection.status !== 'ACTIVE') {
        throw new ConnectionError(
          `OpenSearch collection ${collection.name} is not active (status: ${collection.status})`,
          true
        );
      }
    } catch (error: any) {
      if (error instanceof ConnectionError || error instanceof ResourceNotFoundError) {
        throw error;
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing OpenSearch collection`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to OpenSearch collection: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from OpenSearch doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const collectionId = config.collectionId;

    try {
      await client.send(
        new DeleteCollectionCommand({ id: collectionId })
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
    const names = config.collectionName ? [config.collectionName] : undefined;
    const ids = config.collectionId ? [config.collectionId] : undefined;

    try {
      const response = await client.send(
        new BatchGetCollectionCommand({ names, ids })
      );
      const collection = response.collectionDetails?.[0];
      if (!collection) {
        return {
          success: false,
          message: `OpenSearch collection not found: ${config.collectionName ?? config.collectionId}`,
        };
      }
      return {
        success: true,
        message: `Successfully connected to OpenSearch collection ${collection.name}`,
        details: {
          status: collection.status,
          arn: collection.arn,
          endpoint: collection.collectionEndpoint,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to OpenSearch collection: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    _config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    // OpenSearch Serverless doesn't expose size via API
    return {
      size: 'N/A',
      records: 0,
    };
  }
}
