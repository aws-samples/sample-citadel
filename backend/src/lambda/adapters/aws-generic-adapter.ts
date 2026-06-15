import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import { NotImplementedError } from '../../adapters/errors';

/**
 * Fallback wrapper for AWS services that do not yet have a dedicated adapter.
 *
 * Migration path: this class refuses to operate (every method except
 * `requiredPolicies` throws NotImplementedError) so unsupported AWS service
 * fallbacks fail loudly instead of pretending to succeed. To support a new
 * AWS service, write a dedicated adapter (see s3-adapter.ts /
 * dynamodb-adapter.ts for the pattern) and register it in
 * `backend/src/lambda/adapters/registry.ts` — do NOT add another
 * `AwsGenericAdapter('foo')` entry. The `console.log` calls remain so logs
 * still record what was attempted before the throw, which aids debugging
 * registry mis-wiring.
 *
 * Currently has no registered consumers; retained as a guard against accidental fallback registration.
 */
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
    throw new NotImplementedError(`AwsGenericAdapter:${this.serviceName}`, 'provision');
  }

  async connect(config: Record<string, any>): Promise<void> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] connect called`, config);
    throw new NotImplementedError(`AwsGenericAdapter:${this.serviceName}`, 'connect');
  }

  async disconnect(config: Record<string, any>): Promise<void> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] disconnect called`, config);
    throw new NotImplementedError(`AwsGenericAdapter:${this.serviceName}`, 'disconnect');
  }

  async testConnection(config: Record<string, any>): Promise<ConnectionTestResult> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] testConnection called`, config);
    throw new NotImplementedError(`AwsGenericAdapter:${this.serviceName}`, 'testConnection');
  }

  async getMetrics(config: Record<string, any>): Promise<MetricsResult> {
    console.log(`[AwsGenericAdapter:${this.serviceName}] getMetrics called`, config);
    throw new NotImplementedError(`AwsGenericAdapter:${this.serviceName}`, 'getMetrics');
  }
}
