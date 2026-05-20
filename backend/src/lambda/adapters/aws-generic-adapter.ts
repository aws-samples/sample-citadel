import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';

export class AwsGenericAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec;

  constructor(private serviceName: string) {
    this.spec = { type: serviceName.toUpperCase(), provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: [], optional: [], ssmParameters: [] } };
  }

  requiredPolicies(
    _config: Record<string, any>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    return { provision: [], connect: [] };
  }

  async provision(config: Record<string, any>): Promise<ProvisionResult> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] provision called`, config);
    return {
      resourceArn: `arn:aws:${this.serviceName}:us-east-1:000000000000:${this.serviceName}-${Date.now()}`,
    };
  }

  async connect(config: Record<string, any>): Promise<void> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] connect called`, config);
  }

  async disconnect(config: Record<string, any>): Promise<void> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] disconnect called`, config);
  }

  async testConnection(config: Record<string, any>): Promise<ConnectionTestResult> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] testConnection called`, config);
    return {
      success: true,
      message: `${this.serviceName} adapter: connection test placeholder`,
    };
  }

  async getMetrics(config: Record<string, any>): Promise<MetricsResult> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] getMetrics called`, config);
    return {
      size: '0 bytes',
      records: 0,
    };
  }
}
