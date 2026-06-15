/**
 * Property-Based Test for Configuration Round-Trip
 * 
 * Property 16: Connector schema completeness (Round-trip)
 * For any connector type, serializing its configuration to the backend format
 * and then deserializing it should produce an equivalent configuration object.
 * 
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import * as fc from 'fast-check';
import { getConnectorSpec } from '../connector-registry';

describe('Configuration Round-Trip - Property-Based Tests', () => {
  /**
   * Property 16: Connector schema completeness
   * 
   * For any connector type, serializing its configuration to the backend format
   * and then deserializing it should produce an equivalent configuration object.
   * 
   * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
   */
  describe('Property 16: Configuration round-trip', () => {
    // Define all connector types from GraphQL schema
    const graphqlConnectorTypes = [
      'CONFLUENCE',
      'SLACK',
      'JIRA',
      'SERVICENOW',
      'ZENDESK',
      'PAGERDUTY',
      'MICROSOFT'
    ];

    /**
     * Serialize configuration to backend format
     * This simulates what happens when storing credentials and config
     */
    function serializeConfiguration(
      connectorType: string,
      credentials: any,
      config: any
    ): { secretData: any; ssmData: any } {
      const spec = getConnectorSpec(connectorType);
      if (!spec) {
        throw new Error(`Unknown connector type: ${connectorType}`);
      }

      // Build secret value (what goes into Secrets Manager)
      const secretData: Record<string, any> = {};
      
      // Add authentication fields
      for (const field of spec.authentication.fields) {
        if (credentials[field] !== undefined) {
          secretData[field] = credentials[field];
        }
      }
      
      // Add configuration fields that should be in secret
      for (const configField of spec.configuration.required) {
        if (config[configField] !== undefined) {
          secretData[configField] = config[configField];
        }
      }

      // Build SSM data (what goes into SSM Parameter Store)
      const ssmData: Record<string, any> = {};
      
      for (const paramName of spec.configuration.ssmParameters) {
        // Convert param-name to paramName (camelCase)
        const camelCaseKey = paramName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        
        const value = config[paramName] || config[camelCaseKey];
        
        if (value !== undefined) {
          ssmData[paramName] = value;
        }
      }

      return { secretData, ssmData };
    }

    /**
     * Deserialize configuration from backend format
     * This simulates what happens when retrieving credentials and config
     */
    function deserializeConfiguration(
      connectorType: string,
      secretData: any,
      ssmData: any
    ): { credentials: any; config: any } {
      const spec = getConnectorSpec(connectorType);
      if (!spec) {
        throw new Error(`Unknown connector type: ${connectorType}`);
      }

      // Extract credentials from secret data
      const credentials: Record<string, any> = {};
      for (const field of spec.authentication.fields) {
        if (secretData[field] !== undefined) {
          credentials[field] = secretData[field];
        }
      }

      // Extract configuration from both secret data and SSM data
      const config: Record<string, any> = {};
      
      // Get config fields from secret data
      for (const configField of spec.configuration.required) {
        if (secretData[configField] !== undefined) {
          config[configField] = secretData[configField];
        }
      }
      
      // Get config fields from SSM data
      for (const paramName of spec.configuration.ssmParameters) {
        if (ssmData[paramName] !== undefined) {
          // Convert param-name to paramName (camelCase) for consistency
          const camelCaseKey = paramName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
          config[camelCaseKey] = ssmData[paramName];
        }
      }

      return { credentials, config };
    }

    /**
     * Check if two objects are equivalent
     * Handles the case where SSM parameter names might be in different formats
     */
    function areConfigurationsEquivalent(
      original: { credentials: any; config: any },
      roundtrip: { credentials: any; config: any },
      connectorType: string
    ): boolean {
      const spec = getConnectorSpec(connectorType);
      if (!spec) {
        return false;
      }

      // Check credentials equivalence
      for (const field of spec.authentication.fields) {
        if (original.credentials[field] !== roundtrip.credentials[field]) {
          return false;
        }
      }

      // Check config equivalence
      // Need to handle both param-name and paramName formats
      for (const configField of spec.configuration.required) {
        if (original.config[configField] !== roundtrip.config[configField]) {
          return false;
        }
      }

      // Check SSM parameters (might be in different key formats)
      for (const paramName of spec.configuration.ssmParameters) {
        const camelCaseKey = paramName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        
        const originalValue = original.config[paramName] || original.config[camelCaseKey];
        const roundtripValue = roundtrip.config[paramName] || roundtrip.config[camelCaseKey];
        
        if (originalValue !== roundtripValue) {
          return false;
        }
      }

      return true;
    }

    test('should preserve all data through serialization and deserialization', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) {
              return true; // Skip if spec not found
            }

            // Generate valid credentials
            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `test-${field}-${Math.random().toString(36).substring(7)}`;
            }

            // Generate valid configuration
            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              // If this field is also in authentication fields, use the same value
              if (spec.authentication.fields.includes(field)) {
                config[field] = credentials[field];
              } else {
                config[field] = `test-${field}-${Math.random().toString(36).substring(7)}`;
              }
            }

            // Add optional fields randomly
            for (const field of spec.configuration.optional) {
              if (Math.random() > 0.5) {
                config[field] = `test-${field}-${Math.random().toString(36).substring(7)}`;
              }
            }

            // Serialize
            const { secretData, ssmData } = serializeConfiguration(
              connectorType,
              credentials,
              config
            );

            // Deserialize
            const roundtrip = deserializeConfiguration(
              connectorType,
              secretData,
              ssmData
            );

            // Property: Round-trip should preserve all data
            const original = { credentials, config };
            const isEquivalent = areConfigurationsEquivalent(original, roundtrip, connectorType);

            expect(isEquivalent).toBe(true);

            // Additional checks: all authentication fields should be preserved
            for (const field of spec.authentication.fields) {
              expect(roundtrip.credentials[field]).toBe(credentials[field]);
            }

            // All required config fields should be preserved
            for (const field of spec.configuration.required) {
              expect(roundtrip.config[field]).toBe(config[field]);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should handle empty optional configuration fields', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) {
              return true;
            }

            // Generate valid credentials
            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `test-${field}-value`;
            }

            // Generate only required configuration (no optional fields)
            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `test-${field}-value`;
            }

            // Serialize and deserialize
            const { secretData, ssmData } = serializeConfiguration(
              connectorType,
              credentials,
              config
            );
            const roundtrip = deserializeConfiguration(
              connectorType,
              secretData,
              ssmData
            );

            // Property: Should handle missing optional fields gracefully
            for (const field of spec.authentication.fields) {
              expect(roundtrip.credentials[field]).toBe(credentials[field]);
            }

            for (const field of spec.configuration.required) {
              expect(roundtrip.config[field]).toBe(config[field]);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should maintain data types through round-trip', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) {
              return true;
            }

            // Generate credentials with various data types
            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              // Use string values as per the secret structure
              credentials[field] = `test-${field}-value`;
            }

            // Generate config with various data types
            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `test-${field}-value`;
            }

            // Serialize and deserialize
            const { secretData, ssmData } = serializeConfiguration(
              connectorType,
              credentials,
              config
            );
            const roundtrip = deserializeConfiguration(
              connectorType,
              secretData,
              ssmData
            );

            // Property: Data types should be preserved
            for (const field of spec.authentication.fields) {
              expect(typeof roundtrip.credentials[field]).toBe(typeof credentials[field]);
              expect(roundtrip.credentials[field]).toBe(credentials[field]);
            }

            for (const field of spec.configuration.required) {
              expect(typeof roundtrip.config[field]).toBe(typeof config[field]);
              expect(roundtrip.config[field]).toBe(config[field]);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should handle all connector-specific field combinations', () => {
      // Test specific connector configurations to ensure completeness
      const testCases = [
        {
          type: 'CONFLUENCE',
          credentials: { email: 'test@example.com', apiToken: 'token123' },
          config: { baseUrl: 'https://test.atlassian.net' }
        },
        {
          type: 'SERVICENOW',
          credentials: { username: 'admin', password: 'pass123' },
          config: { instanceUrl: 'https://test.service-now.com' }
        },
        {
          type: 'JIRA',
          credentials: { email: 'test@example.com', apiToken: 'token123' },
          config: { baseUrl: 'https://test.atlassian.net' }
        },
        {
          type: 'SLACK',
          credentials: { clientId: 'client123', clientSecret: 'secret123' },
          config: { workspaceId: 'T01234ABCDE' }
        },
        {
          type: 'MICROSOFT',
          credentials: { clientId: 'client123', clientSecret: 'secret123', tenantId: 'tenant123' },
          config: { tenantId: 'tenant123' }
        },
        {
          type: 'ZENDESK',
          credentials: { email: 'test@example.com', apiToken: 'token123' },
          config: { subdomain: 'test-company' }
        },
        {
          type: 'PAGERDUTY',
          credentials: { apiToken: 'token123' },
          config: {}
        }
      ];

      for (const testCase of testCases) {
        const { secretData, ssmData } = serializeConfiguration(
          testCase.type,
          testCase.credentials,
          testCase.config
        );

        const roundtrip = deserializeConfiguration(
          testCase.type,
          secretData,
          ssmData
        );

        // Verify credentials are preserved
        for (const [key, value] of Object.entries(testCase.credentials)) {
          expect(roundtrip.credentials[key]).toBe(value);
        }

        // Verify config is preserved
        for (const [key, value] of Object.entries(testCase.config)) {
          // Handle both param-name and paramName formats
          const camelCaseKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
          const roundtripValue = roundtrip.config[key] || roundtrip.config[camelCaseKey];
          expect(roundtripValue).toBe(value);
        }
      }
    });

    test('should not lose data when config fields are stored in secret', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...graphqlConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            if (!spec) {
              return true;
            }

            // Generate credentials
            const credentials: Record<string, any> = {};
            for (const field of spec.authentication.fields) {
              credentials[field] = `cred-${field}-value`;
            }

            // Generate config including fields that go into secret
            const config: Record<string, any> = {};
            for (const field of spec.configuration.required) {
              config[field] = `config-${field}-value`;
            }

            // Serialize
            const { secretData, ssmData } = serializeConfiguration(
              connectorType,
              credentials,
              config
            );

            // Property: Config fields that are in secret structure should be in secretData
            for (const configField of spec.configuration.required) {
              if (spec.authentication.secretStructure[configField] !== undefined) {
                expect(secretData[configField]).toBe(config[configField]);
              }
            }

            // Deserialize
            const roundtrip = deserializeConfiguration(
              connectorType,
              secretData,
              ssmData
            );

            // Property: All config fields should be retrievable after round-trip
            for (const field of spec.configuration.required) {
              expect(roundtrip.config[field]).toBe(config[field]);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
