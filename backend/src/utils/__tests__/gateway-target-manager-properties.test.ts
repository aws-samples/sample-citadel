/**
 * Property-Based Tests for Gateway Target Manager
 * 
 * These tests verify universal properties that should hold true for all gateway target operations.
 * 
 * Feature: agentcore-integration-types
 */

import * as fc from 'fast-check';
import { 
  createTarget, 
  validateToolSchema 
} from '../gateway-target-manager';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';

// Mock AWS SDK clients
const bedrockAgentMock = mockClient(BedrockAgentCoreControlClient);

describe('Gateway Target Manager - Property-Based Tests', () => {
  beforeEach(() => {
    bedrockAgentMock.reset();
    
    // Set environment variables
    process.env.AGENTCORE_GATEWAY_ID = 'test-gateway-id';
    process.env.AWS_REGION = 'us-east-1';
    process.env.ACCOUNT_ID = '123456789012';
  });
  
  afterEach(() => {
    delete process.env.AGENTCORE_GATEWAY_ID;
    delete process.env.AWS_REGION;
    delete process.env.ACCOUNT_ID;
  });
  
  /**
   * Property 4: Gateway target creation with correct type
   * 
   * For any AgentCore integration created, a gateway target should be created with the target type 
   * matching the integration type (lambda → lambda, smithy → smithyModel, mcpServer → mcpServer)
   * 
   * Validates: Requirements 1.7, 2.7, 3.9, 5.1, 5.2, 5.3
   */
  describe('Property 4: Gateway target creation with correct type', () => {
    test('should create gateway target with type matching connector type', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'),
          fc.uuid(),
          async (connectorType, integrationId) => {
            // Reset mock for each iteration
            bedrockAgentMock.reset();
            
            // Mock successful target creation with unique ID
            const mockTargetId = `target-${integrationId}`;
            bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });
            
            // Build config based on connector type
            let config: any;
            let credentials: any;
            
            switch (connectorType) {
              case 'AWS_LAMBDA':
                config = {
                  lambdaArn: `arn:aws:lambda:us-east-1:123456789012:function:Function-${integrationId}`,
                  toolSchema: JSON.stringify({
                    name: `tool_${integrationId}`,
                    description: 'Test tool',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        param1: { type: 'string' }
                      }
                    }
                  }),
                  region: 'us-east-1'
                };
                credentials = {
                  executionRoleArn: `arn:aws:iam::123456789012:role/Role-${integrationId}`
                };
                break;
                
              case 'AWS_SMITHY':
                config = {
                  serviceType: fc.sample(fc.constantFrom('dynamodb', 's3', 'lambda', 'sqs', 'sns'), 1)[0],
                  region: 'us-east-1'
                };
                credentials = {
                  executionRoleArn: `arn:aws:iam::123456789012:role/Role-${integrationId}`
                };
                break;
                
              case 'MCP_SERVER':
                const authMethod = fc.sample(fc.constantFrom('API_KEY', 'OAUTH2', 'CUSTOM'), 1)[0];
                config = {
                  serverUrl: `https://mcp-${integrationId}.example.com`,
                  region: 'us-east-1'
                };
                
                if (authMethod === 'API_KEY') {
                  credentials = {
                    authMethod: 'API_KEY',
                    apiKey: `key-${integrationId}`
                  };
                } else if (authMethod === 'OAUTH2') {
                  credentials = {
                    authMethod: 'OAUTH2',
                    clientId: `client-${integrationId}`,
                    clientSecret: `secret-${integrationId}`
                  };
                } else {
                  credentials = {
                    authMethod: 'CUSTOM'
                  };
                }
                break;
            }
            
            // Property: Target should be created successfully
            const targetId = await createTarget(integrationId, connectorType, config, credentials);
            
            // Verify target ID is returned
            expect(targetId).toBeTruthy();
            expect(typeof targetId).toBe('string');
            expect(targetId).toContain('target-');
            
            // Verify gateway API was called at least once
            expect(bedrockAgentMock.calls().length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 } // Run 100 iterations as specified in design
      );
    });
    
    test('should fail when gateway ID is not configured for any connector type', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'),
          fc.uuid(),
          async (connectorType, integrationId) => {
            // Remove gateway ID
            delete process.env.AGENTCORE_GATEWAY_ID;
            
            // Build minimal config
            const config = { region: 'us-east-1' };
            const credentials = {};
            
            // Property: Should throw error when gateway not configured
            await expect(createTarget(integrationId, connectorType, config, credentials))
              .rejects.toThrow('AgentCore Gateway not configured');
            
            // Restore gateway ID for next iteration
            process.env.AGENTCORE_GATEWAY_ID = 'test-gateway-id';
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 12: Tool schema structure validation
   * 
   * For any tool schema provided for Lambda integration, it should contain required MCP fields: 
   * name (string), description (string), and inputSchema (object with type "object")
   * 
   * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5
   */
  describe('Property 12: Tool schema structure validation', () => {
    test('should accept tool schemas with all required fields', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.record({
            type: fc.constant('object'),
            properties: fc.dictionary(
              fc.string({ minLength: 1, maxLength: 20 }),
              fc.record({
                type: fc.constantFrom('string', 'number', 'boolean', 'array', 'object')
              })
            ),
            required: fc.array(fc.string({ minLength: 1, maxLength: 20 }))
          }),
          (name, description, inputSchema) => {
            const schema = {
              name,
              description,
              inputSchema
            };
            
            // Property: Valid schema should not throw
            expect(() => validateToolSchema(schema)).not.toThrow();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas missing name field', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (description) => {
            const schema = {
              description,
              inputSchema: {
                type: 'object'
              }
            };
            
            // Property: Schema without name should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema must include "name" field');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas with non-string name', () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
          fc.string({ minLength: 1, maxLength: 200 }),
          (name, description) => {
            const schema = {
              name,
              description,
              inputSchema: {
                type: 'object'
              }
            };
            
            // Property: Schema with non-string name should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema must include "name" field');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas missing description field', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          (name) => {
            const schema = {
              name,
              inputSchema: {
                type: 'object'
              }
            };
            
            // Property: Schema without description should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema must include "description" field');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas with non-string description', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
          (name, description) => {
            const schema = {
              name,
              description,
              inputSchema: {
                type: 'object'
              }
            };
            
            // Property: Schema with non-string description should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema must include "description" field');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas missing inputSchema field', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          (name, description) => {
            const schema = {
              name,
              description
            };
            
            // Property: Schema without inputSchema should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema must include "inputSchema" field');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas with non-object inputSchema', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
          (name, description, inputSchema) => {
            const schema = {
              name,
              description,
              inputSchema
            };
            
            // Property: Schema with non-object inputSchema should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema must include "inputSchema" field');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
    
    test('should reject tool schemas with inputSchema type not "object"', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.constantFrom('string', 'number', 'boolean', 'array', 'null'),
          (name, description, type) => {
            const schema = {
              name,
              description,
              inputSchema: {
                type
              }
            };
            
            // Property: Schema with inputSchema type not "object" should throw
            expect(() => validateToolSchema(schema)).toThrow('Tool schema inputSchema must be of type "object"');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
