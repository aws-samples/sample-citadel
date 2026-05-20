/**
 * Unit Tests for Gateway Target Manager
 * 
 * Tests specific examples and edge cases for AgentCore Gateway target management.
 */

import { 
  createTarget, 
  deleteTarget, 
  getTarget, 
  validateToolSchema 
} from '../gateway-target-manager';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';

// Mock AWS SDK clients
const bedrockAgentMock = mockClient(BedrockAgentCoreControlClient);

describe('Gateway Target Manager - Unit Tests', () => {
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
  
  describe('validateToolSchema', () => {
    test('should accept valid tool schema with all required fields', () => {
      const validSchema = {
        name: 'my_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            param1: { type: 'string' }
          },
          required: ['param1']
        }
      };
      
      expect(() => validateToolSchema(validSchema)).not.toThrow();
    });
    
    test('should reject schema missing name field', () => {
      const invalidSchema = {
        description: 'A test tool',
        inputSchema: {
          type: 'object'
        }
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema must include "name" field');
    });
    
    test('should reject schema with non-string name', () => {
      const invalidSchema = {
        name: 123,
        description: 'A test tool',
        inputSchema: {
          type: 'object'
        }
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema must include "name" field');
    });
    
    test('should reject schema missing description field', () => {
      const invalidSchema = {
        name: 'my_tool',
        inputSchema: {
          type: 'object'
        }
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema must include "description" field');
    });
    
    test('should reject schema with non-string description', () => {
      const invalidSchema = {
        name: 'my_tool',
        description: 123,
        inputSchema: {
          type: 'object'
        }
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema must include "description" field');
    });
    
    test('should reject schema missing inputSchema field', () => {
      const invalidSchema = {
        name: 'my_tool',
        description: 'A test tool'
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema must include "inputSchema" field');
    });
    
    test('should reject schema with non-object inputSchema', () => {
      const invalidSchema = {
        name: 'my_tool',
        description: 'A test tool',
        inputSchema: 'not an object'
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema must include "inputSchema" field');
    });
    
    test('should reject schema with inputSchema type not "object"', () => {
      const invalidSchema = {
        name: 'my_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'string'
        }
      };
      
      expect(() => validateToolSchema(invalidSchema)).toThrow('Tool schema inputSchema must be of type "object"');
    });
  });
  
  describe('createTarget', () => {
    test('should create Lambda target with valid configuration', async () => {
      const mockTargetId = 'target-123';
      bedrockAgentMock.resolves({ targetId: mockTargetId });
      
      const config = {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
        toolSchema: JSON.stringify({
          name: 'my_tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {
              param1: { type: 'string' }
            }
          }
        }),
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
      };
      
      const targetId = await createTarget('integration-123', 'AWS_LAMBDA', config, credentials);
      
      expect(targetId).toBe(mockTargetId);
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should create Smithy target with valid configuration', async () => {
      const mockTargetId = 'target-456';
      bedrockAgentMock.resolves({ targetId: mockTargetId });
      
      const config = {
        serviceType: 'dynamodb',
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/ServiceExecutionRole'
      };
      
      const targetId = await createTarget('integration-456', 'AWS_SMITHY', config, credentials);
      
      expect(targetId).toBe(mockTargetId);
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should create MCP Server target with API Key authentication', async () => {
      const mockTargetId = 'target-789';
      bedrockAgentMock.resolves({ targetId: mockTargetId });
      
      const config = {
        serverUrl: 'https://mcp.example.com',
        region: 'us-east-1'
      };
      
      const credentials = {
        authMethod: 'API_KEY',
        apiKey: 'test-api-key-123'
      };
      
      const targetId = await createTarget('integration-789', 'MCP_SERVER', config, credentials);
      
      expect(targetId).toBe(mockTargetId);
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should create MCP Server target with OAuth2 authentication', async () => {
      const mockTargetId = 'target-101';
      bedrockAgentMock.resolves({ targetId: mockTargetId });
      
      const config = {
        serverUrl: 'https://mcp.example.com',
        region: 'us-east-1'
      };
      
      const credentials = {
        authMethod: 'OAUTH2',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret'
      };
      
      const targetId = await createTarget('integration-101', 'MCP_SERVER', config, credentials);
      
      expect(targetId).toBe(mockTargetId);
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should create MCP Server target with CUSTOM authentication', async () => {
      const mockTargetId = 'target-102';
      bedrockAgentMock.resolves({ targetId: mockTargetId });
      
      const config = {
        serverUrl: 'https://mcp.example.com',
        region: 'us-east-1'
      };
      
      const credentials = {
        authMethod: 'CUSTOM'
      };
      
      const targetId = await createTarget('integration-102', 'MCP_SERVER', config, credentials);
      
      expect(targetId).toBe(mockTargetId);
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should throw error when gateway ID is not configured', async () => {
      delete process.env.AGENTCORE_GATEWAY_ID;
      
      const config = {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
        toolSchema: JSON.stringify({
          name: 'my_tool',
          description: 'A test tool',
          inputSchema: { type: 'object' }
        }),
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
      };
      
      await expect(createTarget('integration-123', 'AWS_LAMBDA', config, credentials))
        .rejects.toThrow('AgentCore Gateway not configured');
    });
    
    test('should throw error for unknown connector type', async () => {
      const config = { region: 'us-east-1' };
      const credentials = {};
      
      await expect(createTarget('integration-123', 'UNKNOWN_TYPE', config, credentials))
        .rejects.toThrow('Unknown connector type: UNKNOWN_TYPE');
    });
    
    test('should throw error for invalid tool schema JSON', async () => {
      const config = {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
        toolSchema: 'invalid json',
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
      };
      
      await expect(createTarget('integration-123', 'AWS_LAMBDA', config, credentials))
        .rejects.toThrow();
    });
    
    test('should throw error for tool schema missing required fields', async () => {
      const config = {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
        toolSchema: JSON.stringify({
          name: 'my_tool'
          // Missing description and inputSchema
        }),
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
      };
      
      await expect(createTarget('integration-123', 'AWS_LAMBDA', config, credentials))
        .rejects.toThrow('Tool schema must include "description" field');
    });
  });
  
  describe('deleteTarget', () => {
    test('should delete gateway target successfully', async () => {
      bedrockAgentMock.resolves({});
      
      await deleteTarget('target-123');
      
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should throw error when gateway ID is not configured', async () => {
      delete process.env.AGENTCORE_GATEWAY_ID;
      
      await expect(deleteTarget('target-123'))
        .rejects.toThrow('AgentCore Gateway not configured');
    });
    
    test('should propagate AWS SDK errors', async () => {
      bedrockAgentMock.rejects(new Error('AWS SDK error'));
      
      await expect(deleteTarget('target-123'))
        .rejects.toThrow('AWS SDK error');
    });
  });
  
  describe('getTarget', () => {
    test('should retrieve gateway target successfully', async () => {
      const mockTarget = {
        targetId: 'target-123',
        name: 'integration-integration-123',
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction'
            }
          }
        }
      };
      
      bedrockAgentMock.resolves(mockTarget);
      
      const result = await getTarget('target-123');
      
      expect(result).toEqual(mockTarget);
      expect(bedrockAgentMock.calls()).toHaveLength(1);
    });
    
    test('should throw error when gateway ID is not configured', async () => {
      delete process.env.AGENTCORE_GATEWAY_ID;
      
      await expect(getTarget('target-123'))
        .rejects.toThrow('AgentCore Gateway not configured');
    });
    
    test('should propagate AWS SDK errors', async () => {
      bedrockAgentMock.rejects(new Error('Target not found'));
      
      await expect(getTarget('target-123'))
        .rejects.toThrow('Target not found');
    });
  });
  
  describe('Error Handling', () => {
    test('should handle gateway API failures gracefully', async () => {
      bedrockAgentMock.rejects(new Error('Gateway service unavailable'));
      
      const config = {
        lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunction',
        toolSchema: JSON.stringify({
          name: 'my_tool',
          description: 'A test tool',
          inputSchema: { type: 'object' }
        }),
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/LambdaExecutionRole'
      };
      
      await expect(createTarget('integration-123', 'AWS_LAMBDA', config, credentials))
        .rejects.toThrow('Gateway service unavailable');
    });
    
    test('should handle rate limiting errors', async () => {
      const rateLimitError = new Error('ThrottlingException');
      rateLimitError.name = 'ThrottlingException';
      bedrockAgentMock.rejects(rateLimitError);
      
      const config = {
        serviceType: 'dynamodb',
        region: 'us-east-1'
      };
      
      const credentials = {
        executionRoleArn: 'arn:aws:iam::123456789012:role/ServiceExecutionRole'
      };
      
      await expect(createTarget('integration-456', 'AWS_SMITHY', config, credentials))
        .rejects.toThrow('ThrottlingException');
    });
  });
});
