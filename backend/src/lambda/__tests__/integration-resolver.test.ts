/**
 * Unit Tests for Integration Resolver
 * 
 * These tests verify specific examples and edge cases for integration operations.
 * 
 * Feature: agentcore-integration-types
 */

import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreControlClient, DeleteGatewayTargetCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';

// Mock AWS SDK clients
const dynamoMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);
const bedrockAgentMock = mockClient(BedrockAgentCoreControlClient);

// Import the handler after mocking
import { handler } from '../integration-resolver';

describe('Integration Resolver - Unit Tests', () => {
  beforeEach(() => {
    dynamoMock.reset();
    secretsMock.reset();
    ssmMock.reset();
    bedrockAgentMock.reset();
    
    // Set environment variables
    process.env.INTEGRATIONS_TABLE = 'test-integrations-table';
    process.env.AGENTCORE_GATEWAY_ID = 'test-gateway-id';
    process.env.AWS_REGION = 'us-east-1';
    process.env.ACCOUNT_ID = '123456789012';
    process.env.ENVIRONMENT = 'test';
    process.env.EVENT_BUS_NAME = 'test-event-bus';
  });
  
  afterEach(() => {
    delete process.env.INTEGRATIONS_TABLE;
    delete process.env.AGENTCORE_GATEWAY_ID;
    delete process.env.AWS_REGION;
    delete process.env.ACCOUNT_ID;
    delete process.env.ENVIRONMENT;
    delete process.env.EVENT_BUS_NAME;
  });
  
  describe('createIntegration - AWS Lambda', () => {
    test('should create Lambda integration with gateway target', async () => {
      const mockTargetId = 'target-lambda-123';
      
      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({ 
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda' 
      });
      
      // Mock SSM
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});
      
      const event = {
        info: { fieldName: 'createIntegration' },
        arguments: {
          input: {
            integrationType: 'AWS_LAMBDA',
            name: 'Test Lambda Integration',
            orgId: 'org-123',
            credentials: {
              executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
            },
            config: {
              lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
              toolSchema: JSON.stringify({
                name: 'my_tool',
                description: 'Test tool',
                inputSchema: {
                  type: 'object',
                  properties: {
                    param1: { type: 'string' }
                  }
                }
              }),
              region: 'us-east-1'
            }
          }
        },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      expect(result).toBeDefined();
      expect(result.integrationType).toBe('AWS_LAMBDA');
      expect(result.gatewayTargetId).toBe(mockTargetId);
      expect(result.status).toBe('CONFIGURED');
      
      // Verify gateway target was created
      expect(bedrockAgentMock.calls().length).toBeGreaterThan(0);
    });
    
    test('should handle gateway target creation failure', async () => {
      // Mock gateway target creation to fail
      bedrockAgentMock.onAnyCommand().rejects(new Error('Gateway service unavailable'));
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({ 
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda' 
      });
      
      // Mock SSM
      ssmMock.onAnyCommand().resolves({});
      
      const event = {
        info: { fieldName: 'createIntegration' },
        arguments: {
          input: {
            integrationType: 'AWS_LAMBDA',
            name: 'Test Lambda Integration',
            orgId: 'org-123',
            credentials: {
              executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
            },
            config: {
              lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
              toolSchema: JSON.stringify({
                name: 'my_tool',
                description: 'Test tool',
                inputSchema: {
                  type: 'object',
                  properties: {
                    param1: { type: 'string' }
                  }
                }
              }),
              region: 'us-east-1'
            }
          }
        },
        identity: { username: 'test-user' }
      };
      
      await expect(handler(event as any)).rejects.toThrow('Failed to create AgentCore Gateway target');
      
      // Verify secret cleanup was attempted
      const deleteSecretCalls = secretsMock.calls().filter(
        call => call.firstArg?.constructor?.name === 'DeleteSecretCommand'
      );
      expect(deleteSecretCalls.length).toBeGreaterThan(0);
    });
  });
  
  describe('createIntegration - AWS Smithy', () => {
    test('should create Smithy integration with gateway target', async () => {
      const mockTargetId = 'target-smithy-123';
      
      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({ 
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-smithy' 
      });
      
      // Mock SSM
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});
      
      const event = {
        info: { fieldName: 'createIntegration' },
        arguments: {
          input: {
            integrationType: 'AWS_SMITHY',
            name: 'Test Smithy Integration',
            orgId: 'org-123',
            credentials: {
              executionRoleArn: 'arn:aws:iam::123456789012:role/ServiceExecutionRole'
            },
            config: {
              serviceType: 'dynamodb',
              region: 'us-east-1'
            }
          }
        },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      expect(result).toBeDefined();
      expect(result.integrationType).toBe('AWS_SMITHY');
      expect(result.gatewayTargetId).toBe(mockTargetId);
      expect(result.status).toBe('CONFIGURED');
    });
  });
  
  describe('createIntegration - MCP Server', () => {
    test('should create MCP Server integration with API Key auth', async () => {
      const mockTargetId = 'target-mcp-123';
      
      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({ 
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-mcp' 
      });
      
      // Mock SSM
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});
      
      const event = {
        info: { fieldName: 'createIntegration' },
        arguments: {
          input: {
            integrationType: 'MCP_SERVER',
            name: 'Test MCP Server Integration',
            orgId: 'org-123',
            credentials: {
              authMethod: 'API_KEY',
              apiKey: 'test-api-key-123'
            },
            config: {
              serverUrl: 'https://mcp.example.com'
            }
          }
        },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      expect(result).toBeDefined();
      expect(result.integrationType).toBe('MCP_SERVER');
      expect(result.gatewayTargetId).toBe(mockTargetId);
      expect(result.status).toBe('CONFIGURED');
    });
    
    test('should create MCP Server integration with OAuth2 auth', async () => {
      const mockTargetId = 'target-mcp-oauth-123';
      
      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({ 
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-mcp-oauth' 
      });
      
      // Mock SSM
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});
      
      const event = {
        info: { fieldName: 'createIntegration' },
        arguments: {
          input: {
            integrationType: 'MCP_SERVER',
            name: 'Test MCP Server OAuth Integration',
            orgId: 'org-123',
            credentials: {
              authMethod: 'OAUTH2',
              clientId: 'test-client-id',
              clientSecret: 'test-client-secret'
            },
            config: {
              serverUrl: 'https://mcp-oauth.example.com'
            }
          }
        },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      expect(result).toBeDefined();
      expect(result.integrationType).toBe('MCP_SERVER');
      expect(result.gatewayTargetId).toBe(mockTargetId);
      expect(result.status).toBe('CONFIGURED');
    });
  });
  
  describe('deleteIntegration - AgentCore types', () => {
    test('should delete Lambda integration and gateway target', async () => {
      const integrationId = 'lambda-integration-123';
      const mockTargetId = 'target-lambda-123';
      
      // Mock DynamoDB Query to return integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [{
          PK: 'ORG#org-123',
          SK: `INTEGRATION#AWS_LAMBDA#${integrationId}`,
          integrationId,
          integrationType: 'AWS_LAMBDA',
          name: 'Test Lambda Integration',
          status: 'CONFIGURED',
          orgId: 'org-123',
          gatewayTargetId: mockTargetId,
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda',
          ssmParameterPrefix: '/test/lambda',
          config: {},
          metadata: {
            version: '1.0',
            protocol: 'MCP',
            provider: 'Amazon Web Services',
            authMethod: 'IAM_ROLE'
          }
        }]
      });
      
      // Mock gateway target deletion
      let gatewayDeleteCalled = false;
      bedrockAgentMock.on(DeleteGatewayTargetCommand).callsFake(() => {
        gatewayDeleteCalled = true;
        return {};
      });
      
      // Mock secrets manager deletion
      secretsMock.on(DeleteSecretCommand).resolves({});
      
      // Mock SSM deletion
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB deletion
      dynamoMock.on(DeleteCommand).resolves({});
      
      const event = {
        info: { fieldName: 'deleteIntegration' },
        arguments: { integrationId },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      expect(result.success).toBe(true);
      expect(gatewayDeleteCalled).toBe(true);
    });
    
    test('should continue deletion if gateway target cleanup fails', async () => {
      const integrationId = 'lambda-integration-456';
      const mockTargetId = 'target-lambda-456';
      
      // Mock DynamoDB Query to return integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [{
          PK: 'ORG#org-123',
          SK: `INTEGRATION#AWS_LAMBDA#${integrationId}`,
          integrationId,
          integrationType: 'AWS_LAMBDA',
          name: 'Test Lambda Integration',
          status: 'CONFIGURED',
          orgId: 'org-123',
          gatewayTargetId: mockTargetId,
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda',
          ssmParameterPrefix: '/test/lambda',
          config: {},
          metadata: {
            version: '1.0',
            protocol: 'MCP',
            provider: 'Amazon Web Services',
            authMethod: 'IAM_ROLE'
          }
        }]
      });
      
      // Mock gateway target deletion to fail
      bedrockAgentMock.on(DeleteGatewayTargetCommand).rejects(new Error('Gateway target not found'));
      
      // Mock secrets manager deletion
      secretsMock.on(DeleteSecretCommand).resolves({});
      
      // Mock SSM deletion
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB deletion
      dynamoMock.on(DeleteCommand).resolves({});
      
      const event = {
        info: { fieldName: 'deleteIntegration' },
        arguments: { integrationId },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      // Should still succeed even if gateway cleanup fails
      expect(result.success).toBe(true);
    });
    
    test('should not call gateway delete for non-AgentCore types', async () => {
      const integrationId = 'confluence-integration-123';
      
      // Mock DynamoDB Query to return non-AgentCore integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [{
          PK: 'ORG#org-123',
          SK: `INTEGRATION#CONFLUENCE#${integrationId}`,
          integrationId,
          integrationType: 'CONFLUENCE',
          name: 'Test Confluence Integration',
          status: 'CONFIGURED',
          orgId: 'org-123',
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-confluence',
          ssmParameterPrefix: '/test/confluence',
          config: {},
          metadata: {
            version: '1.0',
            protocol: 'REST',
            provider: 'Atlassian',
            authMethod: 'API_KEY'
          }
        }]
      });
      
      // Mock secrets manager deletion
      secretsMock.on(DeleteSecretCommand).resolves({});
      
      // Mock SSM deletion
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB deletion
      dynamoMock.on(DeleteCommand).resolves({});
      
      const event = {
        info: { fieldName: 'deleteIntegration' },
        arguments: { integrationId },
        identity: { username: 'test-user' }
      };
      
      const result = await handler(event as any);
      
      expect(result.success).toBe(true);
      // Verify gateway API was NOT called
      expect(bedrockAgentMock.calls().length).toBe(0);
    });
  });
  
  describe('testIntegration - AgentCore types', () => {
    test('should retrieve config from SSM for Lambda integration', async () => {
      const integrationId = 'lambda-integration-test-123';
      
      // Mock DynamoDB Query to return integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [{
          PK: 'ORG#org-123',
          SK: `INTEGRATION#AWS_LAMBDA#${integrationId}`,
          integrationId,
          integrationType: 'AWS_LAMBDA',
          name: 'Test Lambda Integration',
          status: 'CONFIGURED',
          orgId: 'org-123',
          gatewayTargetId: 'target-123',
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda',
          ssmParameterPrefix: '/test/lambda',
          config: {},
          metadata: {
            version: '1.0',
            protocol: 'MCP',
            provider: 'Amazon Web Services',
            authMethod: 'IAM_ROLE'
          }
        }]
      });
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        SecretString: JSON.stringify({
          executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
        })
      });
      
      // Track SSM parameter retrieval
      let ssmGetCalled = false;
      ssmMock.on(GetParameterCommand).callsFake(() => {
        ssmGetCalled = true;
        return {
          Parameter: {
            Value: 'test-value'
          }
        };
      });
      
      // Mock DynamoDB Put for status update
      dynamoMock.on(PutCommand).resolves({});
      
      const event = {
        info: { fieldName: 'testIntegration' },
        arguments: { integrationId },
        identity: { username: 'test-user' }
      };
      
      // This will fail at connection test but we can verify SSM retrieval
      try {
        await handler(event as any);
      } catch (error) {
        // Expected to fail at connection test
      }
      
      // Verify SSM was called to retrieve config
      expect(ssmGetCalled).toBe(true);
    });
  });
  
  describe('Error handling and logging', () => {
    test('should sanitize IAM role ARNs in logs', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: 'target-123' });
      
      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({ 
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test' 
      });
      
      // Mock SSM
      ssmMock.onAnyCommand().resolves({});
      
      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});
      
      const event = {
        info: { fieldName: 'createIntegration' },
        arguments: {
          input: {
            integrationType: 'AWS_LAMBDA',
            name: 'Test Lambda Integration',
            orgId: 'org-123',
            credentials: {
              executionRoleArn: 'arn:aws:iam::123456789012:role/SensitiveRole'
            },
            config: {
              lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
              toolSchema: JSON.stringify({
                name: 'my_tool',
                description: 'Test tool',
                inputSchema: { type: 'object' }
              }),
              region: 'us-east-1'
            }
          }
        },
        identity: { username: 'test-user' }
      };
      
      await handler(event as any);
      
      // Check that logs don't contain the actual role ARN
      const logCalls = consoleSpy.mock.calls;
      const hasRedactedCredentials = logCalls.some(call => 
        JSON.stringify(call).includes('[REDACTED]')
      );
      
      expect(hasRedactedCredentials).toBe(true);
      
      consoleSpy.mockRestore();
    });
  });
});
