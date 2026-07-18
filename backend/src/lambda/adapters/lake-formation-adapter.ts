import {
  LakeFormationClient,
  RegisterResourceCommand,
  DeregisterResourceCommand,
  GetDataLakeSettingsCommand,
} from '@aws-sdk/client-lakeformation';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class LakeFormationAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'LAKE_FORMATION', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['databaseName'], optional: [], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): LakeFormationClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new LakeFormationClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new LakeFormationClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
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
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const resourceArn = config.resourceArn as string;

    try {
      await client.send(
        new RegisterResourceCommand({
          ResourceArn: resourceArn,
          UseServiceLinkedRole: true,
        })
      );

      return { resourceArn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'AlreadyExistsException') {
        return { resourceArn };
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied registering Lake Formation resource ${resourceArn}`,
          err
        );
      }
      throw new ProvisioningError(
        `Failed to register Lake Formation resource ${resourceArn}: ${err.message}`,
        err
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
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
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ResourceNotFoundError) {
        throw err;
      }
      if (err.name === 'EntityNotFoundException') {
        throw new ResourceNotFoundError(
          'Lake Formation data lake settings not found',
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          'Permission denied accessing Lake Formation settings',
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to Lake Formation: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from Lake Formation doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const resourceArn = config.resourceArn as string;

    try {
      await client.send(
        new DeregisterResourceCommand({ ResourceArn: resourceArn })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'EntityNotFoundException') {
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
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to Lake Formation: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    _config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();

    try {
      await client.send(new GetDataLakeSettingsCommand({}));

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
          'Permission denied accessing Lake Formation metrics',
          err
        );
      }
      throw new ConnectionError(
        `Failed to get Lake Formation metrics: ${err.message}`,
        true,
        err
      );
    }
  }
}
