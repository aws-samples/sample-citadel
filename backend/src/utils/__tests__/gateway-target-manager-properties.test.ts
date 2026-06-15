/**
 * Property-Based Tests for Gateway Target Manager
 * 
 * These tests verify universal properties that should hold true for all gateway target operations.
 * 
 * Feature: agentcore-integration-types
 */

import * as fc from 'fast-check';
import {
  buildLambdaTargetPayload,
  buildSmithyTargetPayload,
  buildMCPServerTargetPayload,
  validateToolSchema,
} from '../gateway-target-manager';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';

// P2.B: gateway-target-manager now delegates credential provisioning to the real
// credential-provider-manager. Mock that module so property tests don't need to
// stub the AgentCore Identity SDK responses for credential commands.
jest.mock('../credential-provider-manager', () => ({
  createOrUpsertApiKeyProvider: jest.fn(async ({ integrationId }: any) => ({
    credentialProviderArn: `arn:aws:bedrock-agentcore:us-east-1:111:api-key/integration-${integrationId}`,
    internalSecretArn: 'arn:s',
    rawResponse: {},
  })),
  createOrUpsertOauth2Provider: jest.fn(async ({ integrationId }: any) => ({
    credentialProviderArn: `arn:aws:bedrock-agentcore:us-east-1:111:oauth2/integration-${integrationId}`,
    callbackUrl: 'https://agentcore.aws/oauth/callback/x',
    internalSecretArn: 'arn:s',
    rawResponse: {},
  })),
  deleteApiKeyProvider: jest.fn(async () => undefined),
  deleteOauth2Provider: jest.fn(async () => undefined),
}));
jest.mock('../oauth-metadata', () => {
  const actual = jest.requireActual('../oauth-metadata');
  return {
    ...actual,
    discoverOAuthEndpoints: jest.fn(async () => null),
  };
});

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
   * Property 4: Gateway-target payload builders emit configuration matching the connector type
   *
   * P3.A: synchronous `createTarget` orchestration was removed — target
   * creation now happens asynchronously in `gateway-registration-handler`
   * via EventBridge. The property under test is therefore now expressed
   * over the *payload builders*: for any AgentCore connector type, the
   * builder must emit a `targetConfiguration.mcp.<lambda|smithyModel|mcpServer>`
   * shape that matches the connector type, with credential-provider
   * configurations consistent with that connector's auth model.
   *
   * Validates: Requirements 1.7, 2.7, 3.9, 5.1, 5.2, 5.3
   */
  describe('Property 4: Builder targetConfiguration matches connector type', () => {
    test('Lambda builder emits mcp.lambda + GATEWAY_IAM_ROLE for any integrationId', () => {
      fc.assert(
        fc.property(fc.uuid(), (integrationId) => {
          const cmdInput = buildLambdaTargetPayload({
            integrationId,
            config: {
              lambdaArn: `arn:aws:lambda:us-east-1:123456789012:function:Function-${integrationId}`,
              toolSchema: JSON.stringify({
                name: `tool_${integrationId}`,
                description: 'Property test tool',
                inputSchema: { type: 'object', properties: { p: { type: 'string' } } },
              }),
              region: 'us-east-1',
            },
          });
          expect((cmdInput.targetConfiguration as any).mcp.lambda).toBeDefined();
          expect((cmdInput.targetConfiguration as any).mcp.smithyModel).toBeUndefined();
          expect((cmdInput.targetConfiguration as any).mcp.mcpServer).toBeUndefined();
          expect(cmdInput.credentialProviderConfigurations).toEqual([
            { credentialProviderType: 'GATEWAY_IAM_ROLE' },
          ]);
          expect(cmdInput.name).toBe(`integration-${integrationId}`);
          return true;
        }),
        { numRuns: 100 },
      );
    });

    test('Smithy builder emits mcp.smithyModel + GATEWAY_IAM_ROLE for any integrationId', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.constantFrom('dynamodb', 's3', 'lambda', 'sqs', 'sns'),
          (integrationId, serviceType) => {
            const cmdInput = buildSmithyTargetPayload({
              integrationId,
              config: { serviceType, region: 'us-east-1' },
            });
            expect((cmdInput.targetConfiguration as any).mcp.smithyModel.serviceType).toBe(
              serviceType,
            );
            expect((cmdInput.targetConfiguration as any).mcp.lambda).toBeUndefined();
            expect((cmdInput.targetConfiguration as any).mcp.mcpServer).toBeUndefined();
            expect(cmdInput.credentialProviderConfigurations).toEqual([
              { credentialProviderType: 'GATEWAY_IAM_ROLE' },
            ]);
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    test('MCP_SERVER builder emits mcp.mcpServer with auth-method-appropriate credential provider', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.constantFrom('API_KEY', 'OAUTH2', 'CUSTOM'),
          (integrationId, authMethod) => {
            const baseInput: any = {
              integrationId,
              config: { serverUrl: `https://mcp-${integrationId}.example.com` },
            };
            if (authMethod === 'API_KEY') {
              baseInput.credentialProviderType = 'API_KEY';
              baseInput.credentialProviderArn = `arn:aws:bedrock-agentcore:us-east-1:111:api-key-credential-provider/integration-${integrationId}`;
            } else if (authMethod === 'OAUTH2') {
              baseInput.credentialProviderType = 'OAUTH2';
              baseInput.credentialProviderArn = `arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-${integrationId}`;
              baseInput.oauthSettings = { scopes: ['read'], grantType: 'CLIENT_CREDENTIALS' };
            }
            // CUSTOM: no credential provider fields — builder emits an empty array.

            const cmdInput = buildMCPServerTargetPayload(baseInput);
            expect((cmdInput.targetConfiguration as any).mcp.mcpServer.serverUrl).toBe(
              `https://mcp-${integrationId}.example.com`,
            );
            expect((cmdInput.targetConfiguration as any).mcp.lambda).toBeUndefined();
            expect((cmdInput.targetConfiguration as any).mcp.smithyModel).toBeUndefined();

            if (authMethod === 'API_KEY') {
              expect(cmdInput.credentialProviderConfigurations).toHaveLength(1);
              expect(cmdInput.credentialProviderConfigurations![0].credentialProviderType).toBe(
                'API_KEY',
              );
            } else if (authMethod === 'OAUTH2') {
              expect(cmdInput.credentialProviderConfigurations).toHaveLength(1);
              expect(cmdInput.credentialProviderConfigurations![0].credentialProviderType).toBe(
                'OAUTH',
              );
            } else {
              expect(cmdInput.credentialProviderConfigurations).toEqual([]);
            }
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    test('all builders throw when AGENTCORE_GATEWAY_ID is not configured', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'),
          fc.uuid(),
          (connectorType, integrationId) => {
            delete process.env.AGENTCORE_GATEWAY_ID;
            try {
              if (connectorType === 'AWS_LAMBDA') {
                expect(() =>
                  buildLambdaTargetPayload({
                    integrationId,
                    config: {
                      lambdaArn: 'arn:aws:lambda:us-east-1:111:function:F',
                      toolSchema: JSON.stringify({
                        name: 't',
                        description: 'd',
                        inputSchema: { type: 'object' },
                      }),
                    },
                  }),
                ).toThrow('AgentCore Gateway not configured');
              } else if (connectorType === 'AWS_SMITHY') {
                expect(() =>
                  buildSmithyTargetPayload({
                    integrationId,
                    config: { serviceType: 'dynamodb' },
                  }),
                ).toThrow('AgentCore Gateway not configured');
              } else {
                // MCP_SERVER CUSTOM path requires no provider provisioning.
                expect(() =>
                  buildMCPServerTargetPayload({
                    integrationId,
                    config: { serverUrl: 'https://mcp.example.com' },
                  }),
                ).toThrow('AgentCore Gateway not configured');
              }
            } finally {
              process.env.AGENTCORE_GATEWAY_ID = 'test-gateway-id';
            }
            return true;
          },
        ),
        { numRuns: 100 },
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
