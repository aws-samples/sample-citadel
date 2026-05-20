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
  AuthenticationMethod
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
      'SHAREPOINT',
      'SALESFORCE',
      'GITHUB',
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
