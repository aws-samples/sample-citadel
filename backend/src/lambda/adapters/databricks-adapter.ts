import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ValidationError } from './errors';

function getDatabricksSQL() {
  try {
    const mod = require('@databricks/sql');
    return mod.DBSQLClient ?? mod.default?.DBSQLClient;
  } catch {
    throw new ConnectionError('@databricks/sql is not installed. Install it to use the Databricks adapter.');
  }
}

export class DatabricksAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'DATABRICKS', provider: 'Databricks', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['serverHostname'], optional: [], ssmParameters: [] } };
  private readonly kind = 'databricks';

  requiredPolicies(
    _config: Record<string, any>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    return { provision: [], connect: [] };
  }

  async provision(
    _config: Record<string, any>,
    _credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    throw new ProvisioningError(
      `Provisioning is not supported for external ${this.kind} data stores`
    );
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const result = await this.testConnection(config, credentials);
    if (!result.success) {
      throw new ConnectionError(
        `Failed to connect to Databricks: ${result.message}`
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op for external stores
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    if (!config.host) {
      throw new ValidationError('Missing required Databricks config field: host');
    }
    if (!config.httpPath) {
      throw new ValidationError('Missing required Databricks config field: httpPath');
    }

    const token = credentials?.token ?? config.token;
    if (!token) {
      throw new ValidationError(
        'Missing required Databricks credential: token'
      );
    }

    let client: any;
    try {
      const DBSQLClient = getDatabricksSQL();
      client = new DBSQLClient();
      await client.connect({
        host: config.host,
        path: config.httpPath,
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
    } catch (error: any) {
      if (client) {
        try { await client.close(); } catch { /* ignore cleanup errors */ }
      }

      if (
        error.message?.includes('401') ||
        error.message?.includes('Unauthorized') ||
        error.message?.includes('authentication')
      ) {
        throw new PermissionError(
          `Authentication failed for Databricks workspace at ${config.host}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Databricks workspace at ${config.host}: ${error.message}`,
        true,
        error
      );
    }
  }

  async getMetrics(
    _config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    return { size: '0 MB', records: 0 };
  }
}
