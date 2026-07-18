import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ValidationError } from './errors';
import { SdkError } from './sdk-types';

/** Constructor type of DBSQLClient, resolved from the module's type surface. */
type DBSQLClientCtor = (typeof import('@databricks/sql'))['DBSQLClient'];

async function getDatabricksSQL(): Promise<DBSQLClientCtor> {
  try {
    const mod = await import('@databricks/sql');
    return (mod.DBSQLClient ??
      (mod as unknown as { default?: { DBSQLClient?: DBSQLClientCtor } }).default?.DBSQLClient) as DBSQLClientCtor;
  } catch {
    throw new ConnectionError('@databricks/sql is not installed. Install it to use the Databricks adapter.');
  }
}

export class DatabricksAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'DATABRICKS', provider: 'Databricks', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['serverHostname'], optional: [], ssmParameters: [] } };
  private readonly kind = 'databricks';

  requiredPolicies(
    _config: Record<string, unknown>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    return { provision: [], connect: [] };
  }

  async provision(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    throw new ProvisioningError(
      `Provisioning is not supported for external ${this.kind} data stores`
    );
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const result = await this.testConnection(config, credentials);
    if (!result.success) {
      throw new ConnectionError(
        `Failed to connect to Databricks: ${result.message}`
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op for external stores
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    if (!config.host) {
      throw new ValidationError('Missing required Databricks config field: host');
    }
    if (!config.httpPath) {
      throw new ValidationError('Missing required Databricks config field: httpPath');
    }

    const token = (credentials?.token ?? config.token) as string | undefined;
    if (!token) {
      throw new ValidationError(
        'Missing required Databricks credential: token'
      );
    }

    let client: InstanceType<DBSQLClientCtor> | undefined;
    try {
      const DBSQLClient = await getDatabricksSQL();
      client = new DBSQLClient();
      await client.connect({
        host: config.host as string,
        path: config.httpPath as string,
        token,
      });

      await client.close();

      return {
        success: true,
        message: `Successfully connected to Databricks workspace at ${config.host}`,
        details: {
          host: config.host,
          httpPath: config.httpPath,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      if (client) {
        try { await client.close(); } catch { /* ignore cleanup errors */ }
      }

      if (
        err.message?.includes('401') ||
        err.message?.includes('Unauthorized') ||
        err.message?.includes('authentication')
      ) {
        throw new PermissionError(
          `Authentication failed for Databricks workspace at ${config.host}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to Databricks workspace at ${config.host}: ${err.message}`,
        true,
        err
      );
    }
  }

  async getMetrics(
    _config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    return { size: '0 MB', records: 0 };
  }
}
