/**
 * Property-Based Tests for Connector Registry
 * 
 * These tests verify universal properties that should hold true for all connectors.
 */

import * as fc from 'fast-check';
import {
  BACKEND_CONNECTOR_REGISTRY,
  getConnectorSpec,
  validateCredentials,
  validateConfiguration,
  getAllConnectorTypes,
  isConnectorTypeSupported,
  AuthenticationMethod,
  validateMcpServerOauth2Config,
  MCP_SERVER_GRANT_TYPES,
  MCP_SERVER_CLIENT_AUTH_METHODS,
  DEFAULT_MCP_SERVER_CLIENT_AUTH_METHOD,
  McpServerOauth2Config
} from '../connector-registry';

describe('Connector Registry - Property-Based Tests', () => {
  /**
   * Property 10: Connector type support
   * 
   * For any connector type defined in the GraphQL IntegrationType enum,
   * the backend should have a corresponding connector specification in the registry.
   * 
   * Validates: Requirements 4.5
   */
  describe('Property 10: Connector type support', () => {
    // Define all connector types from GraphQL schema
    const graphqlConnectorTypes = [
      'CONFLUENCE',
      'SLACK',
      'JIRA',
      'SERVICENOW',
      'ZENDESK',
      'PAGERDUTY',
      'MICROSOFT',
      'AWS_LAMBDA',
      'AWS_SMITHY',
      'MCP_SERVER'
    ];

    test('should have connector spec for every GraphQL IntegrationType', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            // Property: Every connector type in GraphQL schema must have a spec
            const spec = getConnectorSpec(connectorType);
            
            // Verify spec exists
            expect(spec).toBeDefined();
            expect(spec).not.toBeNull();
            
            // Verify spec has required fields
            expect(spec!.type).toBe(connectorType);
            expect(spec!.provider).toBeDefined();
            expect(spec!.authentication).toBeDefined();
            expect(spec!.authentication.method).toBeDefined();
            expect(spec!.authentication.fields).toBeDefined();
            expect(spec!.authentication.fields.length).toBeGreaterThan(0);
            expect(spec!.authentication.secretStructure).toBeDefined();
            expect(spec!.configuration).toBeDefined();
            expect(spec!.configuration.required).toBeDefined();
            expect(spec!.configuration.optional).toBeDefined();
            expect(spec!.configuration.ssmParameters).toBeDefined();
            
            return true;
          }
        ),
        { numRuns: 100 } // Run 100 iterations as specified in design
      );
    });

    test('should support all GraphQL connector types', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            // Property: isConnectorTypeSupported should return true for all GraphQL types
            const isSupported = isConnectorTypeSupported(connectorType);
            expect(isSupported).toBe(true);
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have valid authentication method for all connectors', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: Authentication method must be one of the defined enum values
            const validAuthMethods = Object.values(AuthenticationMethod);
            expect(validAuthMethods).toContain(spec!.authentication.method);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have authentication fields matching secret structure', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: All authentication fields should be present in secret structure
            for (const field of spec!.authentication.fields) {
              expect(spec!.authentication.secretStructure).toHaveProperty(field);
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have consistent provider names', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: Provider name should be a non-empty string
            expect(spec!.provider).toBeTruthy();
            expect(typeof spec!.provider).toBe('string');
            expect(spec!.provider.length).toBeGreaterThan(0);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should validate credentials correctly for all connector types', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Build valid credentials
            const validCredentials: Record<string, any> = {};
            for (const field of spec!.authentication.fields) {
              validCredentials[field] = `test-${field}-value`;
            }
            
            // Property: Valid credentials should pass validation
            const result = validateCredentials(connectorType, validCredentials);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should reject credentials with missing required fields', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Skip if no required fields
            if (spec!.authentication.fields.length === 0) {
              return true;
            }
            
            // For CONFIGURABLE auth (MCP_SERVER), test with empty credentials
            // since only authMethod is truly required
            if (spec!.authentication.method === 'CONFIGURABLE') {
              const result = validateCredentials(connectorType, {});
              expect(result.valid).toBe(false);
              expect(result.errors.length).toBeGreaterThan(0);
              return true;
            }
            
            // Build credentials missing one required field
            const incompleteCredentials: Record<string, any> = {};
            for (let i = 0; i < spec!.authentication.fields.length - 1; i++) {
              const field = spec!.authentication.fields[i];
              incompleteCredentials[field] = `test-${field}-value`;
            }
            
            // Property: Incomplete credentials should fail validation
            const result = validateCredentials(connectorType, incompleteCredentials);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should validate configuration correctly for all connector types', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Build valid configuration
            const validConfig: Record<string, any> = {};
            for (const field of spec!.configuration.required) {
              validConfig[field] = `test-${field}-value`;
            }
            
            // Property: Valid configuration should pass validation
            const result = validateConfiguration(connectorType, validConfig);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should reject configuration with missing required fields', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Skip if no required config fields
            if (spec!.configuration.required.length === 0) {
              return true;
            }
            
            // Build configuration missing one required field
            const incompleteConfig: Record<string, any> = {};
            for (let i = 0; i < spec!.configuration.required.length - 1; i++) {
              const field = spec!.configuration.required[i];
              incompleteConfig[field] = `test-${field}-value`;
            }
            
            // Property: Incomplete configuration should fail validation
            const result = validateConfiguration(connectorType, incompleteConfig);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should return all connector types from getAllConnectorTypes', () => {
      const allTypes = getAllConnectorTypes();
      
      // Property: getAllConnectorTypes should return all GraphQL types
      for (const graphqlType of graphqlConnectorTypes) {
        expect(allTypes).toContain(graphqlType);
      }
      
      // Property: All returned types should be supported
      for (const type of allTypes) {
        expect(isConnectorTypeSupported(type)).toBe(true);
      }
    });

    test('should reject unknown connector types', () => {
      fc.assert(
        fc.property(
          fc.string().filter(s => 
            s.length > 0 && 
            !graphqlConnectorTypes.includes(s) &&
            // Filter out Object prototype properties
            !Object.prototype.hasOwnProperty.call(Object.prototype, s) &&
            !['__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(s)
          ),
          (unknownType) => {
            // Property: Unknown types should not be supported
            const spec = getConnectorSpec(unknownType);
            expect(spec).toBeUndefined();
            
            const isSupported = isConnectorTypeSupported(unknownType);
            expect(isSupported).toBe(false);
            
            // Property: Validation should fail for unknown types
            const credResult = validateCredentials(unknownType, {});
            expect(credResult.valid).toBe(false);
            expect(credResult.errors.length).toBeGreaterThan(0);
            expect(credResult.errors[0]).toContain('Unknown connector type');
            
            const configResult = validateConfiguration(unknownType, {});
            expect(configResult.valid).toBe(false);
            expect(configResult.errors.length).toBeGreaterThan(0);
            expect(configResult.errors[0]).toContain('Unknown connector type');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


/**
 * Example-based tests for the MCP_SERVER OAuth2 spec extension (P1.A).
 *
 * Verifies the full AgentCore OAuth2 field set on the MCP_SERVER connector:
 *   - clientId / clientSecret (required)
 *   - grantType ('CLIENT_CREDENTIALS' | 'AUTHORIZATION_CODE' | 'TOKEN_EXCHANGE')
 *   - discoveryUrl OR (tokenUrl AND, when grantType=AUTHORIZATION_CODE, authorizationUrl)
 *   - scopes (non-empty string[])
 *   - clientAuthenticationMethod ('CLIENT_SECRET_BASIC' default | 'CLIENT_SECRET_POST')
 *
 * `redirectUri` is intentionally NOT a user-input field — AgentCore Identity
 * provides `callbackUrl` in the create-provider response (Phase 2 wiring).
 */
describe('Connector Registry - MCP_SERVER OAuth2 (P1.A)', () => {
  const baseValidOauth2 = {
    authMethod: 'OAUTH2' as const,
    grantType: 'CLIENT_CREDENTIALS' as const,
    clientId: 'client-123',
    clientSecret: 'shhh-secret',
    scopes: ['read:tools']
  };

  describe('happy paths via validateCredentials', () => {
    test('OAUTH2 with discoveryUrl + minimum scopes is VALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        discoveryUrl: 'https://example.com/.well-known/oauth-authorization-server'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('OAUTH2 with tokenUrl only + grantType=CLIENT_CREDENTIALS is VALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        grantType: 'CLIENT_CREDENTIALS',
        tokenUrl: 'https://idp.example.com/oauth/token'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('OAUTH2 with tokenUrl + authorizationUrl + grantType=AUTHORIZATION_CODE is VALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        grantType: 'AUTHORIZATION_CODE',
        tokenUrl: 'https://idp.example.com/oauth/token',
        authorizationUrl: 'https://idp.example.com/oauth/authorize'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("OAUTH2 with clientAuthenticationMethod='CLIENT_SECRET_POST' is VALID", () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        tokenUrl: 'https://idp.example.com/oauth/token',
        clientAuthenticationMethod: 'CLIENT_SECRET_POST'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('default normalization via validateMcpServerOauth2Config', () => {
    test('omitted clientAuthenticationMethod defaults to CLIENT_SECRET_BASIC', () => {
      const result = validateMcpServerOauth2Config({
        ...baseValidOauth2,
        tokenUrl: 'https://idp.example.com/oauth/token'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.normalized).toBeDefined();
      expect(result.normalized!.clientAuthenticationMethod).toBe('CLIENT_SECRET_BASIC');
      expect(DEFAULT_MCP_SERVER_CLIENT_AUTH_METHOD).toBe('CLIENT_SECRET_BASIC');
    });

    test('explicit clientAuthenticationMethod is preserved on normalized output', () => {
      const result = validateMcpServerOauth2Config({
        ...baseValidOauth2,
        tokenUrl: 'https://idp.example.com/oauth/token',
        clientAuthenticationMethod: 'CLIENT_SECRET_POST'
      });
      expect(result.valid).toBe(true);
      expect(result.normalized!.clientAuthenticationMethod).toBe('CLIENT_SECRET_POST');
    });
  });

  describe('invalid cases via validateCredentials', () => {
    test('OAUTH2 with tokenUrl only + grantType=AUTHORIZATION_CODE is INVALID (authorizationUrl required)', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        grantType: 'AUTHORIZATION_CODE',
        tokenUrl: 'https://idp.example.com/oauth/token'
        // authorizationUrl intentionally missing
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /authorizationUrl/i.test(e))).toBe(true);
    });

    test('OAUTH2 with empty scopes is INVALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        scopes: [],
        tokenUrl: 'https://idp.example.com/oauth/token'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /scopes/i.test(e))).toBe(true);
    });

    test('OAUTH2 with neither discoveryUrl nor tokenUrl is INVALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2
        // no discoveryUrl, no tokenUrl
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /discoveryUrl|tokenUrl/i.test(e))).toBe(true);
    });

    test('OAUTH2 with bad URL format on discoveryUrl is INVALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        discoveryUrl: 'not-a-valid-url'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /discoveryUrl/i.test(e))).toBe(true);
    });

    test("OAUTH2 with invalid grantType='Custom' is INVALID", () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        grantType: 'Custom',
        tokenUrl: 'https://idp.example.com/oauth/token'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /grantType/i.test(e))).toBe(true);
    });

    test('OAUTH2 with non-https tokenUrl is INVALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        tokenUrl: 'http://idp.example.com/oauth/token'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /tokenUrl/i.test(e))).toBe(true);
    });

    test('OAUTH2 with invalid clientAuthenticationMethod is INVALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        ...baseValidOauth2,
        tokenUrl: 'https://idp.example.com/oauth/token',
        clientAuthenticationMethod: 'PRIVATE_KEY_JWT'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /clientAuthenticationMethod/i.test(e))).toBe(true);
    });
  });

  describe('API_KEY unchanged behaviour', () => {
    test('MCP_SERVER API_KEY happy path remains VALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        authMethod: 'API_KEY',
        apiKey: 'opaque-api-key-value'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('MCP_SERVER API_KEY without apiKey is INVALID', () => {
      const result = validateCredentials('MCP_SERVER', {
        authMethod: 'API_KEY'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /apiKey/i.test(e))).toBe(true);
    });
  });

  describe('exported enum constants', () => {
    test('MCP_SERVER_GRANT_TYPES contains exactly the three AgentCore SDK literals', () => {
      expect([...MCP_SERVER_GRANT_TYPES].sort()).toEqual(
        ['AUTHORIZATION_CODE', 'CLIENT_CREDENTIALS', 'TOKEN_EXCHANGE'].sort()
      );
    });

    test('MCP_SERVER_CLIENT_AUTH_METHODS contains exactly the two supported methods', () => {
      expect([...MCP_SERVER_CLIENT_AUTH_METHODS].sort()).toEqual(
        ['CLIENT_SECRET_BASIC', 'CLIENT_SECRET_POST'].sort()
      );
    });

    test('MCP_SERVER spec exposes all OAuth2 fields in secretStructure', () => {
      const spec = getConnectorSpec('MCP_SERVER');
      expect(spec).toBeDefined();
      const struct = spec!.authentication.secretStructure;
      expect(struct).toHaveProperty('authMethod');
      expect(struct).toHaveProperty('apiKey');
      expect(struct).toHaveProperty('clientId');
      expect(struct).toHaveProperty('clientSecret');
      expect(struct).toHaveProperty('grantType');
      expect(struct).toHaveProperty('discoveryUrl');
      expect(struct).toHaveProperty('authorizationUrl');
      expect(struct).toHaveProperty('tokenUrl');
      expect(struct).toHaveProperty('scopes');
      expect(struct).toHaveProperty('clientAuthenticationMethod');
    });

    test('McpServerOauth2Config type is structurally compatible with the documented shape', () => {
      // Compile-time guard: this should type-check once the interface is exported.
      const cfg: McpServerOauth2Config = {
        authMethod: 'OAUTH2',
        grantType: 'CLIENT_CREDENTIALS',
        clientId: 'a',
        clientSecret: 'b',
        scopes: ['x']
      };
      expect(cfg.authMethod).toBe('OAUTH2');
    });
  });
});
