/**
 * Property-Based Tests for AgentCore Connector Registry
 * 
 * Feature: agentcore-integration-types
 * Property 14: Storage pattern consistency
 * 
 * Validates: Requirements 11.2, 11.3, 11.4
 */

import * as fc from 'fast-check';
import {
  getConnectorSpec,
  AuthenticationMethod
} from '../connector-registry';

describe('AgentCore Connector Registry - Property-Based Tests', () => {
  /**
   * Property 14: Storage pattern consistency
   * 
   * For any AgentCore integration, metadata should be stored in DynamoDB,
   * credentials in Secrets Manager, and configuration in SSM Parameter Store,
   * following the same pattern as SaaS integrations.
   * 
   * **Validates: Requirements 11.2, 11.3, 11.4**
   */
  describe('Property 14: Storage pattern consistency', () => {
    const agentCoreConnectorTypes = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'];
    const saasConnectorTypes = [
      'CONFLUENCE',
      'SLACK',
      'JIRA',
      'SERVICENOW',
      'ZENDESK',
      'PAGERDUTY',
      'MICROSOFT'
    ];

    test('should have connector specs for all AgentCore types', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            // Property: Every AgentCore connector type must have a spec
            const spec = getConnectorSpec(connectorType);
            
            expect(spec).toBeDefined();
            expect(spec).not.toBeNull();
            expect(spec!.type).toBe(connectorType);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should follow same metadata structure as SaaS integrations', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: AgentCore specs should have same required fields as SaaS specs
            // All specs must have: type, provider, authentication, configuration
            expect(spec!.type).toBeDefined();
            expect(spec!.provider).toBeDefined();
            expect(spec!.authentication).toBeDefined();
            expect(spec!.configuration).toBeDefined();
            
            // Verify authentication structure matches SaaS pattern
            expect(spec!.authentication.method).toBeDefined();
            expect(spec!.authentication.fields).toBeDefined();
            expect(Array.isArray(spec!.authentication.fields)).toBe(true);
            expect(spec!.authentication.secretStructure).toBeDefined();
            expect(typeof spec!.authentication.secretStructure).toBe('object');
            
            // Verify configuration structure matches SaaS pattern
            expect(spec!.configuration.required).toBeDefined();
            expect(Array.isArray(spec!.configuration.required)).toBe(true);
            expect(spec!.configuration.optional).toBeDefined();
            expect(Array.isArray(spec!.configuration.optional)).toBe(true);
            expect(spec!.configuration.ssmParameters).toBeDefined();
            expect(Array.isArray(spec!.configuration.ssmParameters)).toBe(true);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should store credentials in Secrets Manager (secretStructure defined)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: All AgentCore integrations must define secret structure
            // This ensures credentials are stored in Secrets Manager
            expect(spec!.authentication.secretStructure).toBeDefined();
            expect(Object.keys(spec!.authentication.secretStructure).length).toBeGreaterThan(0);
            
            // Verify all authentication fields are in secret structure
            for (const field of spec!.authentication.fields) {
              expect(spec!.authentication.secretStructure).toHaveProperty(field);
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should store configuration in SSM Parameter Store (ssmParameters defined)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: All AgentCore integrations must define SSM parameters
            // This ensures configuration is stored in SSM Parameter Store
            expect(spec!.configuration.ssmParameters).toBeDefined();
            expect(Array.isArray(spec!.configuration.ssmParameters)).toBe(true);
            
            // If there are required config fields, there should be SSM parameters
            if (spec!.configuration.required.length > 0) {
              expect(spec!.configuration.ssmParameters.length).toBeGreaterThan(0);
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have same storage pattern structure as SaaS integrations', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.constantFrom(...agentCoreConnectorTypes),
            fc.constantFrom(...saasConnectorTypes)
          ),
          ([agentCoreType, saasType]) => {
            const agentCoreSpec = getConnectorSpec(agentCoreType);
            const saasSpec = getConnectorSpec(saasType);
            
            // Property: AgentCore and SaaS specs should have identical structure
            // Both should have authentication.secretStructure (Secrets Manager)
            expect(agentCoreSpec!.authentication.secretStructure).toBeDefined();
            expect(saasSpec!.authentication.secretStructure).toBeDefined();
            
            // Both should have configuration.ssmParameters (SSM Parameter Store)
            expect(agentCoreSpec!.configuration.ssmParameters).toBeDefined();
            expect(saasSpec!.configuration.ssmParameters).toBeDefined();
            
            // Both should have same top-level fields (DynamoDB metadata)
            const agentCoreKeys = Object.keys(agentCoreSpec!).sort();
            const saasKeys = Object.keys(saasSpec!).sort();
            
            // AgentCore may have gatewayTargetType, so filter it out for comparison
            const agentCoreBaseKeys = agentCoreKeys.filter(k => k !== 'gatewayTargetType' && k !== 'testEndpoint');
            const saasBaseKeys = saasKeys.filter(k => k !== 'testEndpoint');
            
            // Core fields should match
            expect(agentCoreBaseKeys).toEqual(expect.arrayContaining(['type', 'provider', 'authentication', 'configuration']));
            expect(saasBaseKeys).toEqual(expect.arrayContaining(['type', 'provider', 'authentication', 'configuration']));
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should use IAM_ROLE authentication for AWS integrations', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY'),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: AWS integrations (Lambda, Smithy) must use IAM_ROLE authentication
            expect(spec!.authentication.method).toBe(AuthenticationMethod.IAM_ROLE);
            
            // Should have executionRoleArn field
            expect(spec!.authentication.fields).toContain('executionRoleArn');
            expect(spec!.authentication.secretStructure).toHaveProperty('executionRoleArn');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should use CONFIGURABLE authentication for MCP Server', () => {
      const spec = getConnectorSpec('MCP_SERVER');
      
      // Property: MCP Server must use CONFIGURABLE authentication
      expect(spec!.authentication.method).toBe(AuthenticationMethod.CONFIGURABLE);
      
      // Should have flexible authentication fields
      expect(spec!.authentication.fields).toContain('authMethod');
      expect(spec!.authentication.secretStructure).toHaveProperty('authMethod');
    });

    test('should have gateway target type for all AgentCore integrations', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: All AgentCore integrations must have gatewayTargetType
            expect(spec!.gatewayTargetType).toBeDefined();
            expect(['lambda', 'smithyModel', 'mcpServer']).toContain(spec!.gatewayTargetType);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should map connector type to correct gateway target type', () => {
      const expectedMappings = {
        AWS_LAMBDA: 'lambda',
        AWS_SMITHY: 'smithyModel',
        MCP_SERVER: 'mcpServer'
      };
      
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: Gateway target type must match expected mapping
            expect(spec!.gatewayTargetType).toBe(expectedMappings[connectorType as keyof typeof expectedMappings]);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have required configuration fields for each AgentCore type', () => {
      const expectedRequiredFields = {
        AWS_LAMBDA: ['lambdaArn', 'toolSchema', 'region'],
        AWS_SMITHY: ['serviceType', 'region'],
        MCP_SERVER: ['serverUrl']
      };
      
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            const expected = expectedRequiredFields[connectorType as keyof typeof expectedRequiredFields];
            
            // Property: Required fields must match specification
            expect(spec!.configuration.required).toEqual(expect.arrayContaining(expected));
            expect(spec!.configuration.required.length).toBe(expected.length);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have SSM parameters matching required configuration fields', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...agentCoreConnectorTypes),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: Number of SSM parameters should match number of required config fields
            expect(spec!.configuration.ssmParameters.length).toBe(spec!.configuration.required.length);
            
            // Each required field should have a corresponding SSM parameter
            // (converted to kebab-case)
            for (const field of spec!.configuration.required) {
              const kebabCase = field.replace(/([A-Z])/g, '-$1').toLowerCase();
              const hasMatch = spec!.configuration.ssmParameters.some(param => 
                param === kebabCase || param === field.toLowerCase()
              );
              expect(hasMatch).toBe(true);
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('should have consistent provider naming', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY'),
          (connectorType) => {
            const spec = getConnectorSpec(connectorType);
            
            // Property: AWS integrations should have consistent provider name
            expect(spec!.provider).toBe('Amazon Web Services');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
      
      // MCP Server should have External provider
      const mcpSpec = getConnectorSpec('MCP_SERVER');
      expect(mcpSpec!.provider).toBe('External');
    });
  });
});
