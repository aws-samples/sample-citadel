/**
 * Backend Connector Registry
 * 
 * Defines validation rules, authentication configs, and credential structures
 * for all supported connector types.
 */

export enum AuthenticationMethod {
  API_KEY = 'API_KEY',
  OAUTH2 = 'OAUTH2',
  BASIC_AUTH = 'BASIC_AUTH',
  BEARER_TOKEN = 'BEARER_TOKEN',
  IAM_ROLE = 'IAM_ROLE',
  CONFIGURABLE = 'CONFIGURABLE'
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
  authentication: AuthenticationConfig;
  configuration: ConfigurationSchema;
  testEndpoint?: string;
  gatewayTargetType?: 'lambda' | 'smithyModel' | 'mcpServer';
}

// ---------------------------------------------------------------------------
// MCP_SERVER OAuth2 spec (P1.A)
// ---------------------------------------------------------------------------
// AgentCore SDK OAuth2 grant types — these are the literal values accepted by
// AgentCore Identity (uppercase, underscore-separated). They are NOT the
// lowercase / hyphenated forms used by some IdPs at the wire level.
export type McpServerGrantType =
  | 'CLIENT_CREDENTIALS'
  | 'AUTHORIZATION_CODE'
  | 'TOKEN_EXCHANGE';

// RFC 6749 §2.3.1 client authentication methods supported by the spec.
export type McpServerClientAuthenticationMethod =
  | 'CLIENT_SECRET_BASIC'
  | 'CLIENT_SECRET_POST';

export const MCP_SERVER_GRANT_TYPES: readonly McpServerGrantType[] = [
  'CLIENT_CREDENTIALS',
  'AUTHORIZATION_CODE',
  'TOKEN_EXCHANGE'
];

export const MCP_SERVER_CLIENT_AUTH_METHODS: readonly McpServerClientAuthenticationMethod[] = [
  'CLIENT_SECRET_BASIC',
  'CLIENT_SECRET_POST'
];

export const DEFAULT_MCP_SERVER_CLIENT_AUTH_METHOD: McpServerClientAuthenticationMethod =
  'CLIENT_SECRET_BASIC';

/**
 * MCP_SERVER credentials shape when `authMethod === 'OAUTH2'`.
 *
 * Note: `redirectUri` is intentionally absent — AgentCore Identity provides
 * `callbackUrl` in the create-provider response and Phase 2 wiring stores it
 * on the integration record, not in user input.
 */
export interface McpServerOauth2Config {
  authMethod: 'OAUTH2';
  grantType: McpServerGrantType;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes: string[];
  clientAuthenticationMethod?: McpServerClientAuthenticationMethod;
}

/** MCP_SERVER credentials shape when `authMethod === 'API_KEY'`. */
export interface McpServerApiKeyConfig {
  authMethod: 'API_KEY';
  apiKey: string;
}

/** Discriminated union of all MCP_SERVER credential shapes. */
export type McpServerCredentials = McpServerOauth2Config | McpServerApiKeyConfig;

export const BACKEND_CONNECTOR_REGISTRY: Record<string, ConnectorSpec> = {
  CONFLUENCE: {
    type: 'CONFLUENCE',
    provider: 'Atlassian',
    authentication: {
      method: AuthenticationMethod.API_KEY,
      fields: ['email', 'apiToken'],
      secretStructure: {
        email: 'string',
        apiToken: 'string',
        baseUrl: 'string'
      }
    },
    configuration: {
      required: ['baseUrl'],
      optional: ['spaceKeys', 'enabledFeatures'],
      ssmParameters: ['base-url', 'space-keys']
    },
    testEndpoint: '/wiki/api/v2/spaces?limit=1'
  },
  SERVICENOW: {
    type: 'SERVICENOW',
    provider: 'ServiceNow',
    authentication: {
      method: AuthenticationMethod.BASIC_AUTH,
      fields: ['username', 'password'],
      secretStructure: {
        username: 'string',
        password: 'string',
        instanceUrl: 'string'
      }
    },
    configuration: {
      required: ['instanceUrl'],
      optional: [],
      ssmParameters: ['instance-url']
    },
    testEndpoint: '/api/now/table/sys_user?sysparm_limit=1'
  },
  JIRA: {
    type: 'JIRA',
    provider: 'Atlassian',
    authentication: {
      method: AuthenticationMethod.API_KEY,
      fields: ['email', 'apiToken'],
      secretStructure: {
        email: 'string',
        apiToken: 'string',
        baseUrl: 'string'
      }
    },
    configuration: {
      required: ['baseUrl'],
      optional: ['projectKeys'],
      ssmParameters: ['base-url', 'project-keys']
    },
    testEndpoint: '/rest/api/3/myself'
  },
  SLACK: {
    type: 'SLACK',
    provider: 'Slack Technologies',
    authentication: {
      method: AuthenticationMethod.OAUTH2,
      fields: ['clientId', 'clientSecret'],
      secretStructure: {
        clientId: 'string',
        clientSecret: 'string',
        workspaceId: 'string'
      }
    },
    configuration: {
      required: ['workspaceId'],
      optional: [],
      ssmParameters: ['workspace-id']
    },
    testEndpoint: '/api/auth.test'
  },
  MICROSOFT: {
    type: 'MICROSOFT',
    provider: 'Microsoft',
    authentication: {
      method: AuthenticationMethod.OAUTH2,
      fields: ['clientId', 'clientSecret', 'tenantId'],
      secretStructure: {
        clientId: 'string',
        clientSecret: 'string',
        tenantId: 'string'
      }
    },
    configuration: {
      required: ['tenantId'],
      optional: [],
      ssmParameters: ['tenant-id']
    },
    testEndpoint: '/v1.0/me'
  },
  ZENDESK: {
    type: 'ZENDESK',
    provider: 'Zendesk',
    authentication: {
      method: AuthenticationMethod.API_KEY,
      fields: ['email', 'apiToken'],
      secretStructure: {
        email: 'string',
        apiToken: 'string',
        subdomain: 'string'
      }
    },
    configuration: {
      required: ['subdomain'],
      optional: [],
      ssmParameters: ['subdomain']
    },
    testEndpoint: '/api/v2/users/me.json'
  },
  PAGERDUTY: {
    type: 'PAGERDUTY',
    provider: 'PagerDuty',
    authentication: {
      method: AuthenticationMethod.BEARER_TOKEN,
      fields: ['apiToken'],
      secretStructure: {
        apiToken: 'string'
      }
    },
    configuration: {
      required: [],
      optional: [],
      ssmParameters: []
    },
    testEndpoint: '/users/me'
  },
  // AgentCore integration types
  AWS_LAMBDA: {
    type: 'AWS_LAMBDA',
    provider: 'Amazon Web Services',
    authentication: {
      method: AuthenticationMethod.IAM_ROLE,
      fields: ['executionRoleArn'],
      secretStructure: {
        executionRoleArn: 'string'
      }
    },
    configuration: {
      required: ['lambdaArn', 'toolSchema', 'region'],
      optional: [],
      ssmParameters: ['lambda-arn', 'tool-schema', 'region']
    },
    gatewayTargetType: 'lambda'
  },
  AWS_SMITHY: {
    type: 'AWS_SMITHY',
    provider: 'Amazon Web Services',
    authentication: {
      method: AuthenticationMethod.IAM_ROLE,
      fields: ['executionRoleArn'],
      secretStructure: {
        executionRoleArn: 'string'
      }
    },
    configuration: {
      required: ['serviceType', 'region'],
      optional: [],
      ssmParameters: ['service-type', 'region']
    },
    gatewayTargetType: 'smithyModel'
  },
  MCP_SERVER: {
    type: 'MCP_SERVER',
    provider: 'External',
    authentication: {
      method: AuthenticationMethod.CONFIGURABLE,
      fields: [
        'authMethod',
        'apiKey',
        'clientId',
        'clientSecret',
        'grantType',
        'discoveryUrl',
        'authorizationUrl',
        'tokenUrl',
        'scopes',
        'clientAuthenticationMethod'
      ],
      secretStructure: {
        authMethod: 'string',
        apiKey: 'string',
        clientId: 'string',
        clientSecret: 'string',
        grantType: 'string',
        discoveryUrl: 'string',
        authorizationUrl: 'string',
        tokenUrl: 'string',
        scopes: 'string[]',
        clientAuthenticationMethod: 'string'
      }
    },
    configuration: {
      required: ['serverUrl'],
      optional: [],
      ssmParameters: ['server-url']
    },
    gatewayTargetType: 'mcpServer'
  }
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Get connector specification by type
 */
export function getConnectorSpec(type: string): ConnectorSpec | undefined {
  return BACKEND_CONNECTOR_REGISTRY[type];
}

/**
 * Validate credentials against connector specification
 */
export function validateCredentials(type: string, credentials: any): ValidationResult {
  const spec = getConnectorSpec(type);
  
  if (!spec) {
    return {
      valid: false,
      errors: [`Unknown connector type: ${type}`]
    };
  }
  
  const errors: string[] = [];
  
  // For CONFIGURABLE auth method (MCP_SERVER), only authMethod is required
  // Other fields are conditionally required based on authMethod value
  if (spec.authentication.method === AuthenticationMethod.CONFIGURABLE) {
    if (!credentials.authMethod) {
      errors.push('Missing required field: authMethod');
    } else {
      // Validate conditional fields based on authMethod
      if (credentials.authMethod === 'API_KEY' && !credentials.apiKey) {
        errors.push('Missing required field: apiKey for API_KEY authentication');
      } else if (credentials.authMethod === 'OAUTH2') {
        const oauth2Result = validateMcpServerOauth2Config(credentials);
        if (!oauth2Result.valid) {
          errors.push(...oauth2Result.errors);
        }
      }
      // CUSTOM auth method doesn't require additional fields
    }
  } else {
    // For other auth methods, all fields are required
    for (const field of spec.authentication.fields) {
      if (!credentials[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate configuration against connector specification
 */
export function validateConfiguration(type: string, config: any): ValidationResult {
  const spec = getConnectorSpec(type);
  
  if (!spec) {
    return {
      valid: false,
      errors: [`Unknown connector type: ${type}`]
    };
  }
  
  const errors: string[] = [];
  
  // Check all required configuration fields are present
  for (const field of spec.configuration.required) {
    if (!config[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Get all connector types
 */
export function getAllConnectorTypes(): string[] {
  return Object.keys(BACKEND_CONNECTOR_REGISTRY);
}

/**
 * Check if a connector type is supported
 */
export function isConnectorTypeSupported(type: string): boolean {
  return type in BACKEND_CONNECTOR_REGISTRY;
}

// ---------------------------------------------------------------------------
// MCP_SERVER OAuth2 validation helper (P1.A)
// ---------------------------------------------------------------------------

/**
 * Result of validating MCP_SERVER OAuth2 credentials.
 *
 * On success, `normalized` is populated with defaults applied
 * (e.g. `clientAuthenticationMethod` falls back to `CLIENT_SECRET_BASIC`).
 */
export interface McpServerOauth2ValidationResult extends ValidationResult {
  normalized?: McpServerOauth2Config;
}

const MCP_SERVER_GRANT_TYPES_SET: ReadonlySet<string> = new Set(MCP_SERVER_GRANT_TYPES);
const MCP_SERVER_CLIENT_AUTH_METHODS_SET: ReadonlySet<string> = new Set(
  MCP_SERVER_CLIENT_AUTH_METHODS
);

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate an MCP_SERVER OAuth2 credentials object against the AgentCore
 * OAuth2 field set (P1.A).
 *
 * Required predicates:
 *   - clientId, clientSecret are non-empty strings
 *   - grantType is one of MCP_SERVER_GRANT_TYPES
 *   - scopes is a non-empty `string[]`
 *   - (discoveryUrl != null) || (tokenUrl != null && (grantType !== 'AUTHORIZATION_CODE' || authorizationUrl != null))
 *   - any present URL field is a valid `https://` URL
 *   - clientAuthenticationMethod, when present, is one of MCP_SERVER_CLIENT_AUTH_METHODS
 *     (defaults to CLIENT_SECRET_BASIC on the normalized output when omitted)
 */
export function validateMcpServerOauth2Config(
  creds: any
): McpServerOauth2ValidationResult {
  if (!creds || typeof creds !== 'object') {
    return { valid: false, errors: ['Credentials must be an object'] };
  }

  const errors: string[] = [];

  if (creds.authMethod !== 'OAUTH2') {
    errors.push("Field 'authMethod' must be 'OAUTH2' for MCP_SERVER OAuth2 config");
  }

  if (typeof creds.clientId !== 'string' || creds.clientId.length === 0) {
    errors.push('Missing required field: clientId for OAUTH2 authentication');
  }
  if (typeof creds.clientSecret !== 'string' || creds.clientSecret.length === 0) {
    errors.push('Missing required field: clientSecret for OAUTH2 authentication');
  }

  // grantType
  const grantTypeRaw = creds.grantType;
  let grantType: McpServerGrantType | undefined;
  if (grantTypeRaw === undefined || grantTypeRaw === null || grantTypeRaw === '') {
    errors.push('Missing required field: grantType for OAUTH2 authentication');
  } else if (typeof grantTypeRaw !== 'string' || !MCP_SERVER_GRANT_TYPES_SET.has(grantTypeRaw)) {
    errors.push(
      `Invalid grantType '${String(grantTypeRaw)}' for OAUTH2 authentication; expected one of: ${MCP_SERVER_GRANT_TYPES.join(', ')}`
    );
  } else {
    grantType = grantTypeRaw as McpServerGrantType;
  }

  // scopes
  if (!Array.isArray(creds.scopes)) {
    errors.push(
      'Missing required field: scopes for OAUTH2 authentication (must be a non-empty string array)'
    );
  } else if (creds.scopes.length < 1) {
    errors.push('Field scopes must be a non-empty array for OAUTH2 authentication');
  } else if (!creds.scopes.every((s: unknown) => typeof s === 'string' && s.length > 0)) {
    errors.push('Field scopes must contain only non-empty strings');
  }

  // URL fields (presence + https://)
  const hasDiscovery = creds.discoveryUrl != null && creds.discoveryUrl !== '';
  const hasToken = creds.tokenUrl != null && creds.tokenUrl !== '';
  const hasAuthorization = creds.authorizationUrl != null && creds.authorizationUrl !== '';

  if (hasDiscovery && !isHttpsUrl(creds.discoveryUrl)) {
    errors.push('Field discoveryUrl must be a valid https:// URL');
  }
  if (hasToken && !isHttpsUrl(creds.tokenUrl)) {
    errors.push('Field tokenUrl must be a valid https:// URL');
  }
  if (hasAuthorization && !isHttpsUrl(creds.authorizationUrl)) {
    errors.push('Field authorizationUrl must be a valid https:// URL');
  }

  // Endpoint discovery requirement:
  //   (discoveryUrl != null) ||
  //   (tokenUrl != null && (grantType !== 'AUTHORIZATION_CODE' || authorizationUrl != null))
  if (!hasDiscovery) {
    if (!hasToken) {
      errors.push(
        'Either discoveryUrl or tokenUrl is required for OAUTH2 authentication'
      );
    } else if (grantType === 'AUTHORIZATION_CODE' && !hasAuthorization) {
      errors.push(
        "Field authorizationUrl is required when grantType='AUTHORIZATION_CODE' and discoveryUrl is not provided"
      );
    }
  }

  // clientAuthenticationMethod (optional, default applied on success)
  let clientAuthenticationMethod: McpServerClientAuthenticationMethod =
    DEFAULT_MCP_SERVER_CLIENT_AUTH_METHOD;
  if (creds.clientAuthenticationMethod !== undefined && creds.clientAuthenticationMethod !== null) {
    if (
      typeof creds.clientAuthenticationMethod !== 'string' ||
      !MCP_SERVER_CLIENT_AUTH_METHODS_SET.has(creds.clientAuthenticationMethod)
    ) {
      errors.push(
        `Invalid clientAuthenticationMethod '${String(creds.clientAuthenticationMethod)}'; expected one of: ${MCP_SERVER_CLIENT_AUTH_METHODS.join(', ')}`
      );
    } else {
      clientAuthenticationMethod =
        creds.clientAuthenticationMethod as McpServerClientAuthenticationMethod;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // All checks passed — build the normalized config with defaults applied.
  const normalized: McpServerOauth2Config = {
    authMethod: 'OAUTH2',
    grantType: grantType as McpServerGrantType,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    scopes: [...creds.scopes],
    clientAuthenticationMethod
  };
  if (hasDiscovery) {
    normalized.discoveryUrl = creds.discoveryUrl;
  }
  if (hasToken) {
    normalized.tokenUrl = creds.tokenUrl;
  }
  if (hasAuthorization) {
    normalized.authorizationUrl = creds.authorizationUrl;
  }

  return { valid: true, errors: [], normalized };
}
