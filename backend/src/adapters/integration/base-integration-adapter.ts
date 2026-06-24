/**
 * Base Integration Adapter
 *
 * Wraps integration connector specs into the unified ConnectorAdapter interface.
 * Each integration type gets a concrete adapter that delegates to the
 * existing connection-tester and credential-manager utilities.
 */

import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  RequiredPolicies,
  ConnectionTestResult,
  ValidationResult,
  AuthenticationMethod,
} from '../base';
import { NotImplementedError } from '../errors';
import { computeIntegrationPolicies } from '../../utils/policy-helpers';

export class BaseIntegrationAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'integration';
  readonly spec: ConnectorSpec;

  /**
   * Migration path: every entry in BACKEND_CONNECTOR_REGISTRY is wrapped by a
   * BaseIntegrationAdapter instance in `backend/src/adapters/registry.ts`. The
   * default `testConnection` here throws NotImplementedError so unimplemented
   * connector types fail loudly at runtime rather than silently passing every
   * integration check. To provide real behavior for a connector, subclass
   * BaseIntegrationAdapter and override `testConnection` (and optionally
   * `connect`/`disconnect`) — see the existing concrete datastore adapters
   * (s3-adapter.ts, dynamodb-adapter.ts, etc.) for the override pattern.
   */
  constructor(spec: Omit<ConnectorSpec, 'category'>) {
    this.spec = { ...spec, category: 'integration' };
  }

  requiredPolicies(
    config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const connect = computeIntegrationPolicies(
      config.integrationId || '',
      this.spec.type,
      config,
      accountId,
      region
    );
    return { provision: [], connect };
  }

  async testConnection(
    _config: Record<string, any>,
    _credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    // Fail loudly for any connector type that has not provided a real
    // implementation. Previously this returned `{ success: true, message: '...
    // placeholder' }`, which masked every integration test failure across
    // BACKEND_CONNECTOR_REGISTRY. Subclasses MUST override this method to
    // provide real behavior.
    throw new NotImplementedError(this.spec.type, 'testConnection');
  }

  async connect(
    _config: Record<string, any>,
    _credentials?: Record<string, any>
  ): Promise<void> {
    // Default no-op; integrations connect via EventBridge events
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // Default no-op
  }

  validate(credentials: any, config: any): ValidationResult {
    const errors: string[] = [];
    const auth = this.spec.authentication;

    if (auth.method === AuthenticationMethod.CONFIGURABLE) {
      if (!credentials?.authMethod) {
        errors.push('Missing required field: authMethod');
      } else {
        if (credentials.authMethod === 'API_KEY' && !credentials.apiKey) {
          errors.push('Missing required field: apiKey for API_KEY authentication');
        } else if (credentials.authMethod === 'OAUTH2') {
          if (!credentials.clientId) errors.push('Missing required field: clientId for OAUTH2 authentication');
          if (!credentials.clientSecret) errors.push('Missing required field: clientSecret for OAUTH2 authentication');
        }
      }
    } else {
      for (const field of auth.fields) {
        if (!credentials?.[field]) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    for (const field of this.spec.configuration.required) {
      if (!config?.[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
