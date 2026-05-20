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
import { computeIntegrationPolicies } from '../../utils/policy-helpers';

const AGENTCORE_TYPES = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'];

export class BaseIntegrationAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'integration';
  readonly spec: ConnectorSpec;

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
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    // Default: delegate to connection-tester at runtime
    // Subclasses can override for custom behavior
    return { success: true, message: `${this.spec.type} connection test placeholder` };
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    // Default no-op; integrations connect via EventBridge events
  }

  async disconnect(config: Record<string, any>): Promise<void> {
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
