import {
  LakeFormationClient,
  RegisterResourceCommand,
  DeregisterResourceCommand,
  GetDataLakeSettingsCommand,
} from '@aws-sdk/client-lakeformation';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

export class LakeFormationAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'LAKE_FORMATION', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['databaseName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): LakeFormationClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new LakeFormationClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new LakeFormationClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const resourceArn = `arn:aws:lakeformation:${region}:${accountId}:*`;

    return {
      provision: [
        {
          actions: [
            'lakeformation:RegisterResource',
            'lakeformation:GetDataLakeSettings',
            'lakeformation:GrantPermissions',
          ],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: [
            'lakeformation:GetDataLakeSettings',
            'lakeformation:ListPermissions',
          ],
          resources: [resourceArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const resourceArn = config.resourceArn;

    try {
      await client.send(
        new RegisterResourceCommand({
          ResourceArn: resourceArn,
          UseServiceLinkedRole: true,
        })
      );

      return { resourceArn };
    } catch (error: any) {
      if (error.name === 'AlreadyExistsException') {
        return { resourceArn };
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied registering Lake Formation resource ${resourceArn}`,
          error
        );
      }
      throw new ProvisioningError(
        `Failed to register Lake Formation resource ${resourceArn}: ${error.message}`,
        error
      );
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);

    try {
      const response = await client.send(
        new GetDataLakeSettingsCommand({})
      );
      if (!response.DataLakeSettings) {
        throw new ResourceNotFoundError(
          'Lake Formation data lake settings do not exist'
        );
      }
    } catch (error: any) {
      if (error instanceof ResourceNotFoundError) {
        throw error;
      }
      if (error.name === 'EntityNotFoundException') {
        throw new ResourceNotFoundError(
          'Lake Formation data lake settings not found',
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          'Permission denied accessing Lake Formation settings',
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Lake Formation: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from Lake Formation doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const resourceArn = config.resourceArn;

    try {
      await client.send(
        new DeregisterResourceCommand({ ResourceArn: resourceArn })
      );
    } catch (error: any) {
      if (error.name === 'EntityNotFoundException') {
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

    try {
      const response = await client.send(
        new GetDataLakeSettingsCommand({})
      );
      const settings = response.DataLakeSettings;
      return {
        success: true,
        message: 'Successfully connected to Lake Formation',
        details: {
          dataLakeAdmins: settings?.DataLakeAdmins ?? [],
          trustedResourceOwners: settings?.TrustedResourceOwners ?? [],
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to Lake Formation: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();

    try {
      await client.send(new GetDataLakeSettingsCommand({}));

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
          'Permission denied accessing Lake Formation metrics',
          error
        );
      }
      throw new ConnectionError(
        `Failed to get Lake Formation metrics: ${error.message}`,
        true,
        error
      );
    }
  }
}
