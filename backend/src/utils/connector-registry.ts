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
  // Legacy connector types (not yet fully implemented)
  SHAREPOINT: {
    type: 'SHAREPOINT',
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
    }
  },
  SALESFORCE: {
    type: 'SALESFORCE',
    provider: 'Salesforce',
    authentication: {
      method: AuthenticationMethod.OAUTH2,
      fields: ['clientId', 'clientSecret'],
      secretStructure: {
        clientId: 'string',
        clientSecret: 'string'
      }
    },
    configuration: {
      required: [],
      optional: [],
      ssmParameters: []
    }
  },
  GITHUB: {
    type: 'GITHUB',
    provider: 'GitHub',
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
    }
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
      fields: ['authMethod', 'apiKey', 'clientId', 'clientSecret'],
      secretStructure: {
        authMethod: 'string',
        apiKey: 'string',
        clientId: 'string',
        clientSecret: 'string'
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
        if (!credentials.clientId) {
          errors.push('Missing required field: clientId for OAUTH2 authentication');
        }
        if (!credentials.clientSecret) {
          errors.push('Missing required field: clientSecret for OAUTH2 authentication');
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
