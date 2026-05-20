/**
 * Unit Tests for Connection Tester
 * 
 * These tests verify specific examples and edge cases for connection testing.
 */

import {
  testConnection,
  testApiKeyConnection,
  testBasicAuthConnection,
  testOAuth2Connection,
  testBearerTokenConnection,
  TestResult
} from '../connection-tester';
import { getConnectorSpec } from '../connector-registry';

// Mock fetch globally
global.fetch = jest.fn();

describe('Connection Tester - Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('testConnection', () => {
    test('should route to testApiKeyConnection for Confluence', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net'
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] })
      });

      const result = await testConnection('CONFLUENCE', credentials);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Connection successful');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.atlassian.net/wiki/api/v2/spaces?limit=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Basic'),
            'Accept': 'application/json'
          })
        })
      );
    });

    test('should route to testBasicAuthConnection for ServiceNow', async () => {
      const credentials = {
        username: 'admin',
        password: 'password123',
        instanceUrl: 'https://test.service-now.com'
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] })
      });

      const result = await testConnection('SERVICENOW', credentials);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Connection successful');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.service-now.com/api/now/table/sys_user?sysparm_limit=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Basic'),
            'Accept': 'application/json'
          })
        })
      );
    });

    test('should route to testOAuth2Connection for Slack', async () => {
      const credentials = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        workspaceId: 'T01234ABCDE'
      };

      const result = await testConnection('SLACK', credentials);

      expect(result.success).toBe(true);
      expect(result.message).toContain('OAuth credentials validated');
      expect(global.fetch).not.toHaveBeenCalled(); // OAuth2 doesn't make actual calls yet
    });

    test('should route to testBearerTokenConnection for PagerDuty', async () => {
      const credentials = {
        apiToken: 'test-bearer-token'
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: {} })
      });

      const result = await testConnection('PAGERDUTY', credentials);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Connection successful');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.pagerduty.com/users/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Token token=test-bearer-token',
            'Accept': 'application/vnd.pagerduty+json;version=2'
          })
        })
      );
    });

    test('should return error for unknown connector type', async () => {
      const result = await testConnection('UNKNOWN_TYPE', {});

      expect(result.success).toBe(false);
      expect(result.message).toContain('Testing not implemented');
    });

    test('should return error for connector without test endpoint', async () => {
      // SALESFORCE doesn't have a test endpoint defined
      const result = await testConnection('SALESFORCE', {
        clientId: 'test',
        clientSecret: 'test'
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('No test endpoint defined');
    });

    test('should handle connection errors gracefully', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net'
      };

      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const result = await testConnection('CONFLUENCE', credentials);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection error');
      expect(result.details.error).toBeDefined();
    });
  });

  describe('testApiKeyConnection', () => {
    test('should successfully test Confluence connection', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net'
      };
      const spec = getConnectorSpec('CONFLUENCE')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] })
      });

      const result = await testApiKeyConnection('CONFLUENCE', credentials, spec);

      expect(result.success).toBe(true);
      expect(result.details.status).toBe(200);
      expect(result.details.connectorType).toBe('CONFLUENCE');
    });

    test('should successfully test Jira connection', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net'
      };
      const spec = getConnectorSpec('JIRA')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accountId: 'test' })
      });

      const result = await testApiKeyConnection('JIRA', credentials, spec);

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.atlassian.net/rest/api/3/myself',
        expect.any(Object)
      );
    });

    test('should successfully test Zendesk connection with subdomain', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        subdomain: 'mycompany'
      };
      const spec = getConnectorSpec('ZENDESK')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: {} })
      });

      const result = await testApiKeyConnection('ZENDESK', credentials, spec);

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://mycompany.zendesk.com/api/v2/users/me.json',
        expect.any(Object)
      );
    });

    test('should handle authentication failure', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'invalid-token',
        baseUrl: 'https://test.atlassian.net'
      };
      const spec = getConnectorSpec('CONFLUENCE')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid credentials'
      });

      const result = await testApiKeyConnection('CONFLUENCE', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
      expect(result.details.status).toBe(401);
    });

    test('should handle network errors', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net'
      };
      const spec = getConnectorSpec('CONFLUENCE')!;

      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network timeout'));

      const result = await testApiKeyConnection('CONFLUENCE', credentials, spec);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection error');
      expect(result.details.error).toContain('Network timeout');
    });

    test('should return error for missing base URL', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token'
      };
      const spec = getConnectorSpec('CONFLUENCE')!;

      const result = await testApiKeyConnection('CONFLUENCE', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing base URL or subdomain');
    });

    test('should trim whitespace from base URL', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net '  // Note trailing space
      };
      const spec = getConnectorSpec('CONFLUENCE')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] })
      });

      const result = await testApiKeyConnection('CONFLUENCE', credentials, spec);

      expect(result.success).toBe(true);
      // Verify the URL was trimmed correctly (no space before /wiki)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.atlassian.net/wiki/api/v2/spaces?limit=1',
        expect.any(Object)
      );
    });

    test('should remove trailing slashes from base URL', async () => {
      const credentials = {
        email: 'test@example.com',
        apiToken: 'test-token',
        baseUrl: 'https://test.atlassian.net/'  // Note trailing slash
      };
      const spec = getConnectorSpec('CONFLUENCE')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] })
      });

      const result = await testApiKeyConnection('CONFLUENCE', credentials, spec);

      expect(result.success).toBe(true);
      // Verify the trailing slash was removed
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.atlassian.net/wiki/api/v2/spaces?limit=1',
        expect.any(Object)
      );
    });
  });

  describe('testBasicAuthConnection', () => {
    test('should successfully test ServiceNow connection', async () => {
      const credentials = {
        username: 'admin',
        password: 'password123',
        instanceUrl: 'https://test.service-now.com'
      };
      const spec = getConnectorSpec('SERVICENOW')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] })
      });

      const result = await testBasicAuthConnection('SERVICENOW', credentials, spec);

      expect(result.success).toBe(true);
      expect(result.details.status).toBe(200);
      expect(result.details.connectorType).toBe('SERVICENOW');
    });

    test('should handle authentication failure', async () => {
      const credentials = {
        username: 'admin',
        password: 'wrong-password',
        instanceUrl: 'https://test.service-now.com'
      };
      const spec = getConnectorSpec('SERVICENOW')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid username or password'
      });

      const result = await testBasicAuthConnection('SERVICENOW', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
      expect(result.details.status).toBe(401);
    });

    test('should return error for missing instance URL', async () => {
      const credentials = {
        username: 'admin',
        password: 'password123'
      };
      const spec = getConnectorSpec('SERVICENOW')!;

      const result = await testBasicAuthConnection('SERVICENOW', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing instance URL');
    });

    test('should trim whitespace from instance URL', async () => {
      const credentials = {
        username: 'admin',
        password: 'password123',
        instanceUrl: 'https://test.service-now.com '  // Note trailing space
      };
      const spec = getConnectorSpec('SERVICENOW')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] })
      });

      const result = await testBasicAuthConnection('SERVICENOW', credentials, spec);

      expect(result.success).toBe(true);
      // Verify the URL was trimmed correctly
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.service-now.com/api/now/table/sys_user?sysparm_limit=1',
        expect.any(Object)
      );
    });
  });

  describe('testOAuth2Connection', () => {
    test('should validate Slack OAuth credentials', async () => {
      const credentials = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        workspaceId: 'T01234ABCDE'
      };
      const spec = getConnectorSpec('SLACK')!;

      const result = await testOAuth2Connection('SLACK', credentials, spec);

      expect(result.success).toBe(true);
      expect(result.message).toContain('OAuth credentials validated');
      expect(result.details.clientId).toBe('present');
      expect(result.details.clientSecret).toBe('present');
    });

    test('should validate Microsoft OAuth credentials', async () => {
      const credentials = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tenantId: 'test-tenant-id'
      };
      const spec = getConnectorSpec('MICROSOFT')!;

      const result = await testOAuth2Connection('MICROSOFT', credentials, spec);

      expect(result.success).toBe(true);
      expect(result.message).toContain('OAuth credentials validated');
    });

    test('should fail for missing clientId', async () => {
      const credentials = {
        clientSecret: 'test-client-secret',
        workspaceId: 'T01234ABCDE'
      };
      const spec = getConnectorSpec('SLACK')!;

      const result = await testOAuth2Connection('SLACK', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required OAuth2 fields');
      expect(result.details.missingFields).toContain('clientId');
    });

    test('should fail for missing clientSecret', async () => {
      const credentials = {
        clientId: 'test-client-id',
        workspaceId: 'T01234ABCDE'
      };
      const spec = getConnectorSpec('SLACK')!;

      const result = await testOAuth2Connection('SLACK', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required OAuth2 fields');
      expect(result.details.missingFields).toContain('clientSecret');
    });

    test('should fail for missing Slack workspaceId', async () => {
      const credentials = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret'
      };
      const spec = getConnectorSpec('SLACK')!;

      const result = await testOAuth2Connection('SLACK', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required OAuth2 fields');
      expect(result.details.missingFields).toContain('workspaceId');
    });

    test('should fail for missing Microsoft tenantId', async () => {
      const credentials = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret'
      };
      const spec = getConnectorSpec('MICROSOFT')!;

      const result = await testOAuth2Connection('MICROSOFT', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required OAuth2 fields');
      expect(result.details.missingFields).toContain('tenantId');
    });
  });

  describe('testBearerTokenConnection', () => {
    test('should successfully test PagerDuty connection', async () => {
      const credentials = {
        apiToken: 'test-bearer-token'
      };
      const spec = getConnectorSpec('PAGERDUTY')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: 'test-user' } })
      });

      const result = await testBearerTokenConnection('PAGERDUTY', credentials, spec);

      expect(result.success).toBe(true);
      expect(result.details.status).toBe(200);
      expect(result.details.connectorType).toBe('PAGERDUTY');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.pagerduty.com/users/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Token token=test-bearer-token',
            'Accept': 'application/vnd.pagerduty+json;version=2'
          })
        })
      );
    });

    test('should handle authentication failure', async () => {
      const credentials = {
        apiToken: 'invalid-token'
      };
      const spec = getConnectorSpec('PAGERDUTY')!;

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid API token'
      });

      const result = await testBearerTokenConnection('PAGERDUTY', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
      expect(result.details.status).toBe(401);
    });

    test('should return error for missing API token', async () => {
      const credentials = {};
      const spec = getConnectorSpec('PAGERDUTY')!;

      const result = await testBearerTokenConnection('PAGERDUTY', credentials, spec);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing API token');
    });
  });

  describe('AgentCore Connection Testing', () => {
    describe('testLambdaConnection', () => {
      test('should handle missing Lambda ARN', async () => {
        const config = {
          region: 'us-east-1'
        };
        
        const credentials = {
          executionRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
        };

        const { testLambdaConnection } = await import('../connection-tester');
        const result = await testLambdaConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing Lambda ARN');
      });

      test('should handle missing region', async () => {
        const config = {
          lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:TestFunction'
        };
        
        const credentials = {
          executionRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
        };

        const { testLambdaConnection } = await import('../connection-tester');
        const result = await testLambdaConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing AWS region');
      });

      test('should handle missing execution role ARN', async () => {
        const config = {
          lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:TestFunction',
          region: 'us-east-1'
        };
        
        const credentials = {};

        const { testLambdaConnection } = await import('../connection-tester');
        const result = await testLambdaConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing execution role ARN');
      });
    });

    describe('testSmithyConnection', () => {
      test('should handle missing service type', async () => {
        const config = {
          region: 'us-east-1'
        };
        
        const credentials = {
          executionRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
        };

        const { testSmithyConnection } = await import('../connection-tester');
        const result = await testSmithyConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing service type');
      });

      test('should handle missing region', async () => {
        const config = {
          serviceType: 'dynamodb'
        };
        
        const credentials = {
          executionRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
        };

        const { testSmithyConnection } = await import('../connection-tester');
        const result = await testSmithyConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing AWS region');
      });

      test('should handle missing execution role ARN', async () => {
        const config = {
          serviceType: 'dynamodb',
          region: 'us-east-1'
        };
        
        const credentials = {};

        const { testSmithyConnection } = await import('../connection-tester');
        const result = await testSmithyConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing execution role ARN');
      });
    });

    describe('testMCPServerConnection', () => {
      test('should successfully test MCP server with API key', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'API_KEY',
          apiKey: 'test-api-key'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: {
              tools: [
                { name: 'tool1', description: 'Tool 1' },
                { name: 'tool2', description: 'Tool 2' }
              ]
            }
          })
        });

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(true);
        expect(result.message).toBe('MCP server connection successful');
        expect(result.details.toolCount).toBe(2);
        expect(result.details.authMethod).toBe('API_KEY');
        expect(global.fetch).toHaveBeenCalledWith(
          'https://mcp.example.com/mcp',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Authorization': 'Bearer test-api-key',
              'Content-Type': 'application/json'
            })
          })
        );
      });

      test('should successfully test MCP server with OAuth2', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com/'
        };
        
        const credentials = {
          authMethod: 'OAUTH2',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [] }
          })
        });

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(true);
        expect(result.message).toBe('MCP server connection successful');
        expect(result.details.authMethod).toBe('OAUTH2');
      });

      test('should handle missing server URL', async () => {
        const config = {};
        
        const credentials = {
          authMethod: 'API_KEY',
          apiKey: 'test-api-key'
        };

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing MCP server URL');
      });

      test('should handle missing auth method', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {};

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing authentication method');
      });

      test('should handle missing API key for API_KEY auth', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'API_KEY'
        };

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing API key');
      });

      test('should handle missing OAuth2 credentials', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'OAUTH2',
          clientId: 'test-client-id'
          // Missing clientSecret
        };

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Missing OAuth2 credentials');
      });

      test('should handle authentication failure', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'API_KEY',
          apiKey: 'invalid-key'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized'
        });

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toBe('MCP server authentication failed');
        expect(result.details.status).toBe(401);
      });

      test('should handle server unreachable', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'API_KEY',
          apiKey: 'test-api-key'
        };

        (global.fetch as jest.Mock).mockRejectedValueOnce({
          message: 'fetch failed',
          code: 'ECONNREFUSED'
        });

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Unable to connect to MCP server');
      });

      test('should handle server errors', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'API_KEY',
          apiKey: 'test-api-key'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error'
        });

        const { testMCPServerConnection } = await import('../connection-tester');
        const result = await testMCPServerConnection(config, credentials);

        expect(result.success).toBe(false);
        expect(result.message).toContain('MCP server returned status 500');
      });
    });

    describe('testConnection routing for AgentCore types', () => {
      test('should route AWS_LAMBDA to testLambdaConnection', async () => {
        const config = {
          lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:TestFunction',
          region: 'us-east-1'
        };
        
        const credentials = {
          executionRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
        };

        // This will fail because we can't fully mock the AWS SDK in this test
        // But we can verify it routes correctly by checking the error message
        const result = await testConnection('AWS_LAMBDA', credentials, config);

        // The function should attempt to call Lambda, not return "Testing not implemented"
        expect(result.message).not.toContain('Testing not implemented');
      });

      test('should route AWS_SMITHY to testSmithyConnection', async () => {
        const config = {
          serviceType: 'dynamodb',
          region: 'us-east-1'
        };
        
        const credentials = {
          executionRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
        };

        const result = await testConnection('AWS_SMITHY', credentials, config);

        // The function should attempt to call Smithy, not return "Testing not implemented"
        expect(result.message).not.toContain('Testing not implemented');
      });

      test('should route MCP_SERVER to testMCPServerConnection', async () => {
        const config = {
          serverUrl: 'https://mcp.example.com'
        };
        
        const credentials = {
          authMethod: 'API_KEY',
          apiKey: 'test-api-key'
        };

        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [] }
          })
        });

        const result = await testConnection('MCP_SERVER', credentials, config);

        expect(result.success).toBe(true);
        expect(result.message).toBe('MCP server connection successful');
      });
    });
  });
});
