/**
 * Connection Tester
 * 
 * Tests connections for different connector types based on their authentication methods.
 */

import { getConnectorSpec, ConnectorSpec, AuthenticationMethod } from './connector-registry';
import { NotImplementedError } from '../adapters/errors';

export interface TestResult {
  success: boolean;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Credential/config bags parsed from Secrets Manager / SSM / DynamoDB JSON.
 * Values are treated as opaque strings by every test function.
 */
export type ConnectionBag = Record<string, string | undefined>;

/**
 * Test connection for a connector type
 * Routes to appropriate test function based on authentication method
 */
export async function testConnection(
  connectorType: string,
  credentials: ConnectionBag | undefined,
  config?: ConnectionBag
): Promise<TestResult> {
  const spec = getConnectorSpec(connectorType);
  
  if (!spec) {
    return {
      success: false,
      message: `Testing not implemented for ${connectorType}`,
      details: {}
    };
  }
  
  // AgentCore types don't use testEndpoint - they have custom test logic
  const isAgentCoreType = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'].includes(connectorType);
  
  if (!isAgentCoreType && !spec.testEndpoint) {
    return {
      success: false,
      message: `No test endpoint defined for ${connectorType}`,
      details: {}
    };
  }
  
  try {
    // Route AgentCore types to their specific test functions
    if (connectorType === 'AWS_LAMBDA') {
      return await testLambdaConnection(config, credentials);
    } else if (connectorType === 'AWS_SMITHY') {
      return await testSmithyConnection(config, credentials);
    } else if (connectorType === 'MCP_SERVER') {
      return await testMCPServerConnection(config, credentials);
    }
    
    // Route SaaS connectors by authentication method
    switch (spec.authentication.method) {
      case AuthenticationMethod.API_KEY:
        return await testApiKeyConnection(connectorType, credentials as ConnectionBag, spec);
      case AuthenticationMethod.BASIC_AUTH:
        return await testBasicAuthConnection(connectorType, credentials as ConnectionBag, spec);
      case AuthenticationMethod.OAUTH2:
        return await testOAuth2Connection(connectorType, credentials as ConnectionBag, spec);
      case AuthenticationMethod.BEARER_TOKEN:
        return await testBearerTokenConnection(connectorType, credentials as ConnectionBag, spec);
      default:
        return {
          success: false,
          message: `Unsupported authentication method: ${spec.authentication.method}`,
          details: {}
        };
    }
  } catch (error: unknown) {
    console.error(`Connection test error for ${connectorType}:`, error);
    return {
      success: false,
      message: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
      details: { error: String(error) }
    };
  }
}

/**
 * Test API Key authentication (Confluence, Jira, Zendesk)
 * Uses Basic Auth with email and API token
 */
export async function testApiKeyConnection(
  connectorType: string,
  credentials: ConnectionBag,
  spec: ConnectorSpec
): Promise<TestResult> {
  console.log(`Testing ${connectorType} connection...`);
  
  const authHeader = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');
  
  // Determine base URL based on connector type
  let baseUrl: string;
  if (credentials.baseUrl) {
    // Trim whitespace and remove trailing slashes
    baseUrl = credentials.baseUrl.trim().replace(/\/+$/, '');
  } else if (credentials.subdomain) {
    // For Zendesk
    baseUrl = `https://${credentials.subdomain.trim()}.zendesk.com`;
  } else {
    return {
      success: false,
      message: 'Missing base URL or subdomain',
      details: {}
    };
  }
  
  const testUrl = `${baseUrl}${spec.testEndpoint}`;
  console.log(`Testing connection to: ${testUrl}`);
  
  try {
    const response = await fetch(testUrl, {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Accept': 'application/json'
      }
    });
    
    console.log(`Response status: ${response.status} ${response.statusText}`);
    
    if (response.ok) {
      return {
        success: true,
        message: 'Connection successful',
        details: { 
          status: response.status,
          connectorType,
          testUrl: testUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') // Mask credentials in URL
        }
      };
    } else {
      const errorText = await response.text();
      console.error(`Connection test failed: ${response.status} ${response.statusText}`, errorText);
      
      // Provide helpful error messages for common issues
      let message = `Connection failed: ${response.statusText}`;
      if (response.status === 404 && connectorType === 'CONFLUENCE') {
        message = 'Connection failed: API endpoint not found. Please verify:\n' +
                  '1. Your Confluence URL is correct (e.g., https://yourcompany.atlassian.net)\n' +
                  '2. You are using Confluence Cloud (not Server/Data Center)\n' +
                  '3. The Confluence instance is accessible';
      } else if (response.status === 401) {
        message = 'Connection failed: Invalid credentials. Please check your email and API token.';
      } else if (response.status === 403) {
        message = 'Connection failed: Access denied. Please verify your account has the necessary permissions.';
      }
      
      return {
        success: false,
        message,
        details: { 
          status: response.status,
          error: errorText,
          testUrl: testUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')
        }
      };
    }
  } catch (error: unknown) {
    console.error(`Fetch error:`, error);
    return {
      success: false,
      message: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
      details: { 
        error: String(error),
        testUrl: testUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')
      }
    };
  }
}

/**
 * Test Basic Auth authentication (ServiceNow)
 * Uses Basic Auth with username and password
 */
export async function testBasicAuthConnection(
  connectorType: string,
  credentials: ConnectionBag,
  spec: ConnectorSpec
): Promise<TestResult> {
  const authHeader = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  
  if (!credentials.instanceUrl) {
    return {
      success: false,
      message: 'Missing instance URL',
      details: {}
    };
  }
  
  // Trim whitespace and remove trailing slashes
  const instanceUrl = credentials.instanceUrl.trim().replace(/\/+$/, '');
  
  const response = await fetch(`${instanceUrl}${spec.testEndpoint}`, {
    headers: {
      'Authorization': `Basic ${authHeader}`,
      'Accept': 'application/json'
    }
  });
  
  if (response.ok) {
    return {
      success: true,
      message: 'Connection successful',
      details: { 
        status: response.status,
        connectorType
      }
    };
  } else {
    const errorText = await response.text();
    return {
      success: false,
      message: `Connection failed: ${response.statusText}`,
      details: { 
        status: response.status,
        error: errorText
      }
    };
  }
}

/**
 * Test OAuth2 authentication (Slack, Microsoft)
 * Validates that OAuth credentials are present
 * Full OAuth flow testing is deferred to future implementation
 */
export async function testOAuth2Connection(
  connectorType: string,
  credentials: ConnectionBag,
  _spec: ConnectorSpec
): Promise<TestResult> {
  // Validate required OAuth2 fields are present
  const missingFields: string[] = [];
  
  if (!credentials.clientId) {
    missingFields.push('clientId');
  }
  if (!credentials.clientSecret) {
    missingFields.push('clientSecret');
  }
  
  // Check connector-specific required fields
  if (connectorType === 'SLACK' && !credentials.workspaceId) {
    missingFields.push('workspaceId');
  }
  if (connectorType === 'MICROSOFT' && !credentials.tenantId) {
    missingFields.push('tenantId');
  }
  
  if (missingFields.length > 0) {
    return {
      success: false,
      message: `Missing required OAuth2 fields: ${missingFields.join(', ')}`,
      details: { missingFields }
    };
  }
  
  // OAuth2 testing requires token exchange first
  // For initial implementation, we validate that credentials are present
  // Full OAuth flow testing can be added in future iterations
  // TODO: Implement real OAuth2 client_credentials/auth_code flow per
  //   today's MCP_SERVER pattern (commit 34dd528c). Blocked on connector
  //   registry: SLACK and MICROSOFT specs are missing tokenUrl, scopes,
  //   and grantType fields required to drive a real token exchange.
  throw new NotImplementedError(
    `${connectorType} OAuth2`,
    'testOAuth2Connection',
  );
}

/**
 * Test Bearer Token authentication (PagerDuty)
 * Uses Authorization header with bearer token
 */
export async function testBearerTokenConnection(
  connectorType: string,
  credentials: ConnectionBag,
  spec: ConnectorSpec
): Promise<TestResult> {
  if (!credentials.apiToken) {
    return {
      success: false,
      message: 'Missing API token',
      details: {}
    };
  }
  
  const response = await fetch(`https://api.pagerduty.com${spec.testEndpoint}`, {
    headers: {
      'Authorization': `Token token=${credentials.apiToken}`,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    }
  });
  
  if (response.ok) {
    return {
      success: true,
      message: 'Connection successful',
      details: { 
        status: response.status,
        connectorType
      }
    };
  } else {
    const errorText = await response.text();
    return {
      success: false,
      message: `Connection failed: ${response.statusText}`,
      details: { 
        status: response.status,
        error: errorText
      }
    };
  }
}

/**
 * Test Lambda integration connection
 * Assumes execution role and invokes Lambda function with test payload
 */
export async function testLambdaConnection(
  config: ConnectionBag | undefined,
  credentials: ConnectionBag | undefined
): Promise<TestResult> {
  try {
    // Validate required configuration
    if (!config?.lambdaArn) {
      return {
        success: false,
        message: 'Missing Lambda ARN in configuration',
        details: {}
      };
    }
    
    if (!config?.region) {
      return {
        success: false,
        message: 'Missing AWS region in configuration',
        details: {}
      };
    }
    
    if (!credentials?.executionRoleArn) {
      return {
        success: false,
        message: 'Missing execution role ARN in credentials',
        details: {}
      };
    }
    
    // Import AWS SDK dynamically to avoid loading it for non-AWS connectors
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
    
    // Assume the execution role
    const stsClient = new STSClient({ region: config.region });
    const assumeRoleResponse = await stsClient.send(new AssumeRoleCommand({
      RoleArn: credentials.executionRoleArn,
      RoleSessionName: `integration-test-${Date.now()}`,
      DurationSeconds: 900 // 15 minutes
    }));
    
    if (!assumeRoleResponse.Credentials) {
      return {
        success: false,
        message: 'Failed to assume execution role',
        details: { roleArn: credentials.executionRoleArn }
      };
    }
    
    // Create Lambda client with assumed role credentials
    const lambdaClient = new LambdaClient({
      region: config.region,
      credentials: {
        accessKeyId: assumeRoleResponse.Credentials.AccessKeyId!,
        secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey!,
        sessionToken: assumeRoleResponse.Credentials.SessionToken!
      }
    });
    
    // Invoke Lambda with test payload
    const invokeResponse = await lambdaClient.send(new InvokeCommand({
      FunctionName: config.lambdaArn,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify({ test: true, timestamp: Date.now() })
    }));
    
    if (invokeResponse.StatusCode === 200) {
      return {
        success: true,
        message: 'Lambda function invoked successfully',
        details: {
          statusCode: invokeResponse.StatusCode,
          executedVersion: invokeResponse.ExecutedVersion,
          functionArn: config.lambdaArn
        }
      };
    } else {
      return {
        success: false,
        message: `Lambda invocation failed with status ${invokeResponse.StatusCode}`,
        details: {
          statusCode: invokeResponse.StatusCode,
          functionError: invokeResponse.FunctionError
        }
      };
    }
  } catch (error: unknown) {
    console.error('Lambda connection test error:', error);

    const err = error as Error & { code?: string };

    // Handle specific AWS errors
    if (err.name === 'AccessDeniedException' || err.name === 'AccessDenied') {
      return {
        success: false,
        message: 'Execution role lacks necessary permissions to invoke Lambda function',
        details: { 
          error: err.message,
          roleArn: credentials?.executionRoleArn
        }
      };
    }
    
    if (err.name === 'ResourceNotFoundException') {
      return {
        success: false,
        message: `Lambda function not found: ${config?.lambdaArn}`,
        details: { error: err.message }
      };
    }
    
    return {
      success: false,
      message: `Lambda test failed: ${err.message}`,
      details: { error: err.message }
    };
  }
}

/**
 * Test Smithy integration connection
 * Assumes execution role and performs test operation on AWS service
 */
export async function testSmithyConnection(
  config: ConnectionBag | undefined,
  credentials: ConnectionBag | undefined
): Promise<TestResult> {
  try {
    // Validate required configuration
    if (!config?.serviceType) {
      return {
        success: false,
        message: 'Missing service type in configuration',
        details: {}
      };
    }
    
    if (!config?.region) {
      return {
        success: false,
        message: 'Missing AWS region in configuration',
        details: {}
      };
    }
    
    if (!credentials?.executionRoleArn) {
      return {
        success: false,
        message: 'Missing execution role ARN in credentials',
        details: {}
      };
    }
    
    // Import AWS SDK dynamically
    const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
    
    // Assume the execution role
    const stsClient = new STSClient({ region: config.region });
    const assumeRoleResponse = await stsClient.send(new AssumeRoleCommand({
      RoleArn: credentials.executionRoleArn,
      RoleSessionName: `integration-test-${Date.now()}`,
      DurationSeconds: 900
    }));
    
    if (!assumeRoleResponse.Credentials) {
      return {
        success: false,
        message: 'Failed to assume execution role',
        details: { roleArn: credentials.executionRoleArn }
      };
    }
    
    const assumedCredentials = {
      accessKeyId: assumeRoleResponse.Credentials.AccessKeyId!,
      secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey!,
      sessionToken: assumeRoleResponse.Credentials.SessionToken!
    };
    
    // Test based on service type
    switch (config.serviceType.toLowerCase()) {
      case 'dynamodb': {
        const { DynamoDBClient, ListTablesCommand } = await import('@aws-sdk/client-dynamodb');
        const dynamoClient = new DynamoDBClient({
          region: config.region,
          credentials: assumedCredentials
        });
        
        const response = await dynamoClient.send(new ListTablesCommand({ Limit: 1 }));
        
        return {
          success: true,
          message: 'DynamoDB access verified',
          details: {
            serviceType: 'dynamodb',
            region: config.region,
            tableCount: response.TableNames?.length || 0
          }
        };
      }
      
      case 's3': {
        const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
        const s3Client = new S3Client({
          region: config.region,
          credentials: assumedCredentials
        });
        
        const response = await s3Client.send(new ListBucketsCommand({}));
        
        return {
          success: true,
          message: 'S3 access verified',
          details: {
            serviceType: 's3',
            region: config.region,
            bucketCount: response.Buckets?.length || 0
          }
        };
      }
      
      case 'lambda': {
        const { LambdaClient, ListFunctionsCommand } = await import('@aws-sdk/client-lambda');
        const lambdaClient = new LambdaClient({
          region: config.region,
          credentials: assumedCredentials
        });
        
        const response = await lambdaClient.send(new ListFunctionsCommand({ MaxItems: 1 }));
        
        return {
          success: true,
          message: 'Lambda access verified',
          details: {
            serviceType: 'lambda',
            region: config.region,
            functionCount: response.Functions?.length || 0
          }
        };
      }
      
      case 'sqs': {
        const { SQSClient, ListQueuesCommand } = await import('@aws-sdk/client-sqs');
        const sqsClient = new SQSClient({
          region: config.region,
          credentials: assumedCredentials
        });
        
        const response = await sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
        
        return {
          success: true,
          message: 'SQS access verified',
          details: {
            serviceType: 'sqs',
            region: config.region,
            queueCount: response.QueueUrls?.length || 0
          }
        };
      }
      
      case 'sns': {
        const { SNSClient, ListTopicsCommand } = await import('@aws-sdk/client-sns');
        const snsClient = new SNSClient({
          region: config.region,
          credentials: assumedCredentials
        });
        
        const response = await snsClient.send(new ListTopicsCommand({}));
        
        return {
          success: true,
          message: 'SNS access verified',
          details: {
            serviceType: 'sns',
            region: config.region,
            topicCount: response.Topics?.length || 0
          }
        };
      }
      
      default:
        return {
          success: true,
          message: `${config.serviceType} service type validated (full testing not implemented)`,
          details: {
            serviceType: config.serviceType,
            region: config.region
          }
        };
    }
  } catch (error: unknown) {
    console.error('Smithy connection test error:', error);

    const err = error as Error & { code?: string };

    // Handle specific AWS errors
    if (err.name === 'AccessDeniedException' || err.name === 'AccessDenied') {
      return {
        success: false,
        message: `Execution role lacks permissions for ${config?.serviceType}`,
        details: { 
          error: err.message,
          roleArn: credentials?.executionRoleArn,
          serviceType: config?.serviceType
        }
      };
    }
    
    return {
      success: false,
      message: `${config?.serviceType} test failed: ${err.message}`,
      details: { 
        error: err.message,
        serviceType: config?.serviceType
      }
    };
  }
}

/**
 * Test MCP Server integration connection
 * Builds authorization header and calls MCP server tools/list endpoint
 */
export async function testMCPServerConnection(
  config: ConnectionBag | undefined,
  credentials: ConnectionBag | undefined
): Promise<TestResult> {
  try {
    // Validate required configuration
    if (!config?.serverUrl) {
      return {
        success: false,
        message: 'Missing MCP server URL in configuration',
        details: {}
      };
    }
    
    if (!credentials?.authMethod) {
      return {
        success: false,
        message: 'Missing authentication method in credentials',
        details: {}
      };
    }
    
    // Build authorization header based on auth method
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (credentials.authMethod === 'API_KEY') {
      if (!credentials.apiKey) {
        return {
          success: false,
          message: 'Missing API key for API_KEY authentication',
          details: {}
        };
      }
      headers['Authorization'] = `Bearer ${credentials.apiKey}`;
    } else if (credentials.authMethod === 'OAUTH2') {
      if (!credentials.clientId || !credentials.clientSecret) {
        return {
          success: false,
          message: 'Missing OAuth2 credentials (clientId and clientSecret required)',
          details: {}
        };
      }
      // For OAuth2, we would need to exchange credentials for token
      // For testing, we'll just validate the server is reachable
      // Full OAuth2 flow can be implemented in future iterations
    }
    
    // Call MCP server tools/list endpoint
    const mcpUrl = config.serverUrl.endsWith('/') 
      ? `${config.serverUrl}mcp` 
      : `${config.serverUrl}/mcp`;
    
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: 'MCP server connection successful',
        details: {
          status: response.status,
          serverUrl: config.serverUrl,
          toolCount: data.result?.tools?.length || 0,
          authMethod: credentials.authMethod
        }
      };
    } else if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: 'MCP server authentication failed',
        details: {
          status: response.status,
          statusText: response.statusText,
          serverUrl: config.serverUrl
        }
      };
    } else {
      return {
        success: false,
        message: `MCP server returned status ${response.status}`,
        details: {
          status: response.status,
          statusText: response.statusText,
          serverUrl: config.serverUrl
        }
      };
    }
  } catch (error: unknown) {
    console.error('MCP server connection test error:', error);

    const err = error as Error & { code?: string };

    // Handle network errors
    if (err.message.includes('fetch') || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return {
        success: false,
        message: `Unable to connect to MCP server at ${config?.serverUrl}`,
        details: { 
          error: err.message,
          serverUrl: config?.serverUrl
        }
      };
    }
    
    return {
      success: false,
      message: `MCP server test failed: ${err.message}`,
      details: { 
        error: err.message,
        serverUrl: config?.serverUrl
      }
    };
  }
}
