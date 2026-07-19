/**
 * Unified Connector Adapter Interface
 *
 * Provides a single adapter contract for both datastore and integration connectors.
 * DataStore adapters implement provision/getMetrics; integration adapters may omit them.
 */

export enum AuthenticationMethod {
  API_KEY = 'API_KEY',
  OAUTH2 = 'OAUTH2',
  BASIC_AUTH = 'BASIC_AUTH',
  BEARER_TOKEN = 'BEARER_TOKEN',
  IAM_ROLE = 'IAM_ROLE',
  CONFIGURABLE = 'CONFIGURABLE',
}

export type ConnectorCategory = 'datastore' | 'integration';

export interface PolicyStatement {
  actions: string[];
  resources: string[];
}

export interface RequiredPolicies {
  provision: PolicyStatement[];
  connect: PolicyStatement[];
}

export interface ProvisionResult {
  resourceArn: string;
  size?: string;
  records?: number;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface MetricsResult {
  size: string;
  records: number;
}

export interface AuthenticationConfig {
  method: AuthenticationMethod;
  fields: string[];
  secretStructure: Record<string, string>;
}

export interface ConfigurationSchema {
  required: string[];
  optional: string[];
  ssmParameters: string[];
}

export interface ConnectorSpec {
  type: string;
  provider: string;
  category: ConnectorCategory;
  authentication: AuthenticationConfig;
  configuration: ConfigurationSchema;
  testEndpoint?: string;
  gatewayTargetType?: 'lambda' | 'smithyModel' | 'mcpServer';
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Unified adapter interface for all connector types.
 *
 * Required methods: requiredPolicies, testConnection, connect, disconnect
 * Optional methods: provision, getMetrics (datastore-only), validate
 */
export interface ConnectorAdapter {
  readonly category: ConnectorCategory;
  readonly spec: ConnectorSpec;

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies;

  testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult>;

  connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void>;

  disconnect(config: Record<string, unknown>): Promise<void>;

  /** DataStore-only: provision a new resource */
  provision?(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult>;

  /** DataStore-only: destroy a provisioned resource */
  deprovision?(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void>;

  /** DataStore-only: get resource metrics */
  getMetrics?(
    config: Record<string, unknown>,
    resourceArn?: string
  ): Promise<MetricsResult>;

  /** Validate credentials and configuration against the spec */
  validate?(
    credentials: Record<string, unknown>,
    config: Record<string, unknown>
  ): ValidationResult;
}
