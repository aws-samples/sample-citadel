import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ValidationError } from './errors';

function getSnowflakeSDK() {
  try {
    return require('snowflake-sdk');
  } catch {
    throw new ConnectionError('snowflake-sdk is not installed. Install it to use the Snowflake adapter.');
  }
}

export class SnowflakeAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'SNOWFLAKE', provider: 'Snowflake', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['accountIdentifier'], optional: [], ssmParameters: [] } };
  private readonly kind = 'snowflake';

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
        `Failed to connect to Snowflake: ${result.message}`
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
    const missing: string[] = [];
    if (!config.accountIdentifier) missing.push('accountIdentifier');
    if (!config.warehouse) missing.push('warehouse');
    if (!config.database) missing.push('database');

    if (missing.length > 0) {
      throw new ValidationError(
        `Missing required Snowflake config fields: ${missing.join(', ')}`
      );
    }

    const username = credentials?.username ?? config.username;
    const password = credentials?.password ?? config.password;

    if (!username || !password) {
      throw new ValidationError(
        'Missing required Snowflake credentials: username and password'
      );
    }

    try {
      const snowflake = getSnowflakeSDK();
      const connection = snowflake.createConnection({
        account: config.accountIdentifier,
        username,
        password,
        warehouse: config.warehouse,
        database: config.database,
        schema: config.schema,
      });

      await new Promise<void>((resolve, reject) => {
        connection.connect((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      connection.destroy((err: any) => {
        if (err) console.error('Error destroying Snowflake connection:', err);
      });

      return {
        success: true,
        message: `Successfully connected to Snowflake account ${config.accountIdentifier}`,
        details: {
          accountIdentifier: config.accountIdentifier,
          warehouse: config.warehouse,
          database: config.database,
        },
      };
    } catch (error: any) {
      if (
        error.code === '390100' ||
        error.message?.includes('Incorrect username or password')
      ) {
        throw new PermissionError(
          `Authentication failed for Snowflake account ${config.accountIdentifier}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Snowflake account ${config.accountIdentifier}: ${error.message}`,
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
