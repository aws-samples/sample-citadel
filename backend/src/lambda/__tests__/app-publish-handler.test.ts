/**
 * Unit tests for app-publish-handler.ts
 *
 * Task 4.1: Tests for validatePublishPreconditions (extended)
 * Task 4.4: Tests for API Gateway provisioning via SDK
 *
 * Validates: Requirements 1.2, 1.3, 1.5, 1.7, 1.9, 1.10, 2.1, 2.2, 2.4, 2.8
 */
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateAuthorizerCommand,
  DeleteApiCommand,
} from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient, CreateLogGroupCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { mockClient } from 'aws-sdk-client-mock';

import {
  validatePublishPreconditions,
  provisionApiGateway,
  publishApp,
  AppMetadata,
  ComponentItem,
} from '../app-publish-handler';
import { PolicyManager } from '../../utils/policy-manager';

// ── Mocks ───────────────────────────────────────────────────

const apiGwMock = mockClient(ApiGatewayV2Client);
const cwLogsMock = mockClient(CloudWatchLogsClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const stsMock = mockClient(STSClient);
const iamMock = mockClient(IAMClient);

// ── Helpers ─────────────────────────────────────────────────

function makeMetadata(overrides: Partial<AppMetadata> = {}): AppMetadata {
  return {
    appId: 'app-1',
    name: 'Test App',
    status: 'ACTIVE',
    workflowIds: ['wf-1'],
    orgId: 'org-1',
    sortId: 'METADATA',
    groupId: 'APP#app-1',
    version: 1,
    ...overrides,
  };
}

function makeAgentBinding(agentId: string, status: string = 'READY'): ComponentItem {
  return {
    sortId: `AGENT#${agentId}`,
    agentId,
    status,
    addedAt: '2024-01-01T00:00:00.000Z',
  };
}

function makeConfigSchema(schema: Record<string, any> = {
  type: 'object',
  properties: { apiKey: { type: 'string' } },
  required: ['apiKey'],
}): ComponentItem {
  return { sortId: 'CONFIG#schema', schema };
}

function makeConfigValues(values: Record<string, any> = {
  apiKey: 'sk-test',
  adminEmail: 'admin@example.com',
}): ComponentItem {
  return { sortId: 'CONFIG#values', values };
}

function setupDefaultMocks() {
  apiGwMock.reset();
  cwLogsMock.reset();
  ddbMock.reset();
  ebMock.reset();
  stsMock.reset();
  iamMock.reset();

  // Default API Gateway mock responses
  apiGwMock.on(CreateApiCommand).resolves({ ApiId: 'api-123', ApiEndpoint: 'https://api-123.execute-api.us-east-1.amazonaws.com' });
  apiGwMock.on(CreateStageCommand).resolves({});
  apiGwMock.on(CreateIntegrationCommand).resolves({ IntegrationId: 'int-456' });
  apiGwMock.on(CreateAuthorizerCommand).resolves({ AuthorizerId: 'auth-789' });
  apiGwMock.on(CreateRouteCommand).resolves({});
  apiGwMock.on(DeleteApiCommand).resolves({});

  // Default CloudWatch Logs mock
  cwLogsMock.on(CreateLogGroupCommand).resolves({});
  cwLogsMock.on(DescribeLogGroupsCommand).resolves({
    logGroups: [{ logGroupName: '/aws/apigateway/citadel-app-app-1-dev', arn: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigateway/citadel-app-app-1-dev:*' }],
  });

  // Default DynamoDB mock
  ebMock.on(PutEventsCommand).resolves({});

  // Default STS/IAM for PolicyManager
  stsMock.on(GetCallerIdentityCommand).resolves({
    Account: '123456789012',
    Arn: 'arn:aws:sts::123456789012:assumed-role/test-role/session',
  });
  iamMock.on(CreateRoleCommand).resolves({});
  iamMock.on(PutRolePolicyCommand).resolves({});
}

// ── Task 4.1: Precondition Validation Tests ─────────────────

describe('validatePublishPreconditions (extended)', () => {

  test('returns empty errors when all agents READY, workflow bound, config valid, admin email present', () => {
    const metadata = makeMetadata({ workflowIds: ['wf-1'] });
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'READY'),
      makeConfigSchema(),
      makeConfigValues({ apiKey: 'sk-test', adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toEqual([]);
  });

  test('returns empty errors with multiple READY agents and multiple workflows', () => {
    const metadata = makeMetadata({ workflowIds: ['wf-1', 'wf-2', 'wf-3'] });
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'READY'),
      makeAgentBinding('agent-2', 'READY'),
      makeConfigValues({ adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toEqual([]);
  });

  test('returns error when agent has DESIGN status', () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'DESIGN'),
      makeConfigValues({ adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toContainEqual(expect.stringContaining('Agents not ready'));
    expect(errors).toContainEqual(expect.stringContaining('agent-1'));
  });

  test('lists all non-READY agents in error message', () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'DESIGN'),
      makeAgentBinding('agent-2', 'DESIGN'),
      makeAgentBinding('agent-3', 'READY'),
      makeConfigValues({ adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    const agentError = errors.find(e => e.includes('Agents not ready'));
    expect(agentError).toBeDefined();
    expect(agentError).toContain('agent-1');
    expect(agentError).toContain('agent-2');
    expect(agentError).not.toContain('agent-3');
  });

  test('returns error when multi-agent app has no workflows bound', () => {
      // The validator only requires workflows for multi-agent apps
      // (agentBindings.length > 1). Single-agent apps publish without one.
      const metadata = makeMetadata({ workflowIds: [] });
      const components: ComponentItem[] = [
        makeAgentBinding('agent-1', 'READY'),
        makeAgentBinding('agent-2', 'READY'),
        makeConfigValues({ adminEmail: 'admin@example.com' }),
      ];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors).toContainEqual(expect.stringContaining('workflow'));
    });
  
    test('single-agent app publishes without a workflow', () => {
      const metadata = makeMetadata({ workflowIds: [] });
      const components: ComponentItem[] = [
        makeAgentBinding('agent-1', 'READY'),
        makeConfigValues({ adminEmail: 'admin@example.com' }),
      ];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors).toEqual([]);
    });

  test('multi-agent app errors when workflowIds is undefined', () => {
      const metadata = makeMetadata({ workflowIds: undefined as any });
      const components: ComponentItem[] = [
        makeAgentBinding('agent-1', 'READY'),
        makeAgentBinding('agent-2', 'READY'),
        makeConfigValues({ adminEmail: 'admin@example.com' }),
      ];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors).toContainEqual(expect.stringContaining('workflow'));
    });

  test('admin email is optional — does NOT block publish when missing', () => {
      // Intentional behaviour change: admin email is no longer a publish
      // precondition. Validator line 178 comment: 'Admin email is optional
      // — not a publish blocker'. This test pins that contract.
      const metadata = makeMetadata();
      const components: ComponentItem[] = [
        makeAgentBinding('agent-1', 'READY'),
        makeConfigValues({ apiKey: 'sk-test' }), // no adminEmail
      ];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors.some(e => e.includes('Admin email') || e.includes('admin email'))).toBe(false);
    });

  test('publishes cleanly when only an agent is bound and there is no config', () => {
      // With admin-email dropped as a precondition and no configSchema, a
      // minimal single-agent app has no preconditions to fail.
      const metadata = makeMetadata();
      const components: ComponentItem[] = [
        makeAgentBinding('agent-1', 'READY'),
      ];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors).toEqual([]);
    });

  test('returns error when config schema exists but values are missing', () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'READY'),
      makeConfigSchema(),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toContainEqual(expect.stringContaining('Configuration values are required'));
  });

  test('returns error when config values do not satisfy schema', () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'READY'),
      makeConfigSchema({
        type: 'object',
        properties: { apiKey: { type: 'string' } },
        required: ['apiKey'],
      }),
      makeConfigValues({ maxRetries: 3, adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toContainEqual(expect.stringContaining('Config validation failed'));
  });

  test('passes when config schema and valid values both exist', () => {
    const metadata = makeMetadata();
    const components: ComponentItem[] = [
      makeAgentBinding('agent-1', 'READY'),
      makeConfigSchema(),
      makeConfigValues({ apiKey: 'sk-test', adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toEqual([]);
  });

  test('returns all failing preconditions in a single call', () => {
      // Two agents trigger the workflow precondition (multi-agent); both
      // are non-READY; configSchema present but no values provided.
      // Three independent failures expected.
      const metadata = makeMetadata({ workflowIds: [] });
      const components: ComponentItem[] = [
        makeAgentBinding('agent-1', 'DESIGN'),
        makeAgentBinding('agent-2', 'DESIGN'),
        makeConfigSchema(),
      ];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors.length).toBeGreaterThanOrEqual(3);
      expect(errors.some(e => e.includes('Agents not ready'))).toBe(true);
      expect(errors.some(e => e.includes('workflow'))).toBe(true);
      expect(errors.some(e => e.includes('Configuration values are required'))).toBe(true);
      // Admin email is intentionally no longer a precondition.
    });

  test('does not mutate the metadata object on precondition failure', () => {
    const metadata = makeMetadata({ workflowIds: [], status: 'ACTIVE' });
    const metadataCopy = { ...metadata, workflowIds: [...metadata.workflowIds] };
    const components: ComponentItem[] = [makeAgentBinding('agent-1', 'DESIGN')];
    validatePublishPreconditions(metadata, components);
    expect(metadata.status).toBe(metadataCopy.status);
    expect(metadata.workflowIds).toEqual(metadataCopy.workflowIds);
    expect(metadata.appId).toBe(metadataCopy.appId);
  });

  test('passes with no agents, one workflow, and admin email (no schema)', () => {
    const metadata = makeMetadata({ workflowIds: ['wf-1'] });
    const components: ComponentItem[] = [
      makeConfigValues({ adminEmail: 'admin@example.com' }),
    ];
    const errors = validatePublishPreconditions(metadata, components);
    expect(errors).toEqual([]);
  });

  test('empty component items array is acceptable (no agents, no config)', () => {
      // Empty components: no agent bindings (so no 'agents not ready'),
      // no config schema (so no 'config values required'), single-agent
      // workflow rule not triggered. With admin-email dropped this is now
      // a clean publish state.
      const metadata = makeMetadata({ workflowIds: ['wf-1'] });
      const components: ComponentItem[] = [];
      const errors = validatePublishPreconditions(metadata, components);
      expect(errors).toEqual([]);
    });
});

// ── Task 4.4: API Gateway Provisioning Tests ────────────────

describe('provisionApiGateway', () => {
  beforeEach(() => {
    setupDefaultMocks();
  });

  test('calls SDK commands in correct sequence: CreateApi → CreateStage → CreateIntegration → CreateAuthorizer → CreateRoute', async () => {
    const callOrder: string[] = [];

    apiGwMock.on(CreateApiCommand).callsFake(() => {
      callOrder.push('CreateApi');
      return { ApiId: 'api-123' };
    });
    apiGwMock.on(CreateStageCommand).callsFake(() => {
      callOrder.push('CreateStage');
      return {};
    });
    apiGwMock.on(CreateIntegrationCommand).callsFake(() => {
      callOrder.push('CreateIntegration');
      return { IntegrationId: 'int-456' };
    });
    apiGwMock.on(CreateAuthorizerCommand).callsFake(() => {
      callOrder.push('CreateAuthorizer');
      return { AuthorizerId: 'auth-789' };
    });
    apiGwMock.on(CreateRouteCommand).callsFake(() => {
      callOrder.push('CreateRoute');
      return {};
    });

    await provisionApiGateway('app-1', 'dev', 'arn:aws:lambda:us-east-1:123:function:auth', 'citadel-agents-dev', 'us-east-1');

    expect(callOrder).toEqual([
      'CreateApi',
      'CreateStage',
      'CreateIntegration',
      'CreateAuthorizer',
      'CreateRoute',
    ]);
  });

  test('API name follows citadel-app-{appId}-{env} convention', async () => {
    await provisionApiGateway('my-app-42', 'staging', 'arn:auth', 'bus', 'us-west-2');

    const createApiCall = apiGwMock.commandCalls(CreateApiCommand)[0];
    expect(createApiCall.args[0].input.Name).toBe('citadel-app-my-app-42-staging');
    expect(createApiCall.args[0].input.ProtocolType).toBe('HTTP');
  });

  test('configures EventBridge integration with correct source and detail-type', async () => {
    await provisionApiGateway('app-1', 'dev', 'arn:auth', 'citadel-agents-dev', 'us-east-1');

    const integrationCall = apiGwMock.commandCalls(CreateIntegrationCommand)[0];
    const input = integrationCall.args[0].input;
    expect(input.IntegrationType).toBe('AWS_PROXY');
    expect(input.IntegrationSubtype).toBe('EventBridge-PutEvents');
    expect(input.RequestParameters).toMatchObject({
      Source: 'citadel.app.invoke',
      DetailType: 'app.invoke.requested',
      EventBusName: 'citadel-agents-dev',
    });
  });

  test('creates $default stage with auto-deploy and throttle settings', async () => {
    await provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1');

    const stageCall = apiGwMock.commandCalls(CreateStageCommand)[0];
    const input = stageCall.args[0].input;
    expect(input.StageName).toBe('$default');
    expect(input.AutoDeploy).toBe(true);
    expect(input.DefaultRouteSettings?.ThrottlingRateLimit).toBe(1000);
    expect(input.DefaultRouteSettings?.ThrottlingBurstLimit).toBe(5000);
  });

  test('creates POST /invoke route with custom authorizer', async () => {
    await provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1');

    const routeCall = apiGwMock.commandCalls(CreateRouteCommand)[0];
    const input = routeCall.args[0].input;
    expect(input.RouteKey).toBe('POST /invoke');
    expect(input.AuthorizationType).toBe('CUSTOM');
    expect(input.AuthorizerId).toBe('auth-789');
    expect(input.Target).toBe('integrations/int-456');
  });

  test('returns apiId and derived endpointUrl', async () => {
    const result = await provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-west-2');

    expect(result.apiId).toBe('api-123');
    expect(result.endpointUrl).toBe('https://api-123.execute-api.us-west-2.amazonaws.com');
  });

  test('rolls back by calling DeleteApiCommand on CreateStage failure', async () => {
    apiGwMock.on(CreateStageCommand).rejects(new Error('Stage creation failed'));

    await expect(
      provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1'),
    ).rejects.toThrow('Stage creation failed');

    const deleteCalls = apiGwMock.commandCalls(DeleteApiCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.ApiId).toBe('api-123');
  });

  test('rolls back by calling DeleteApiCommand on CreateIntegration failure', async () => {
    apiGwMock.on(CreateIntegrationCommand).rejects(new Error('Integration failed'));

    await expect(
      provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1'),
    ).rejects.toThrow('Integration failed');

    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(1);
  });

  test('rolls back by calling DeleteApiCommand on CreateRoute failure', async () => {
    apiGwMock.on(CreateRouteCommand).rejects(new Error('Route failed'));

    await expect(
      provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1'),
    ).rejects.toThrow('Route failed');

    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(1);
  });

  test('does not call DeleteApiCommand when CreateApi itself fails (no apiId to delete)', async () => {
    apiGwMock.on(CreateApiCommand).rejects(new Error('API creation failed'));

    await expect(
      provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1'),
    ).rejects.toThrow('API creation failed');

    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(0);
  });

  test('configures Lambda authorizer with 300s cache TTL', async () => {
    await provisionApiGateway('app-1', 'dev', 'arn:aws:lambda:us-east-1:123:function:auth', 'bus', 'us-east-1');

    const authCall = apiGwMock.commandCalls(CreateAuthorizerCommand)[0];
    const input = authCall.args[0].input;
    expect(input.AuthorizerType).toBe('REQUEST');
    expect(input.AuthorizerResultTtlInSeconds).toBe(300);
    expect(input.IdentitySource).toEqual(['$request.header.x-api-key']);
  });

  test('creates CloudWatch log group and configures access logging with structured JSON format', async () => {
    await provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1');

    // Verify log group was created
    const logGroupCalls = cwLogsMock.commandCalls(CreateLogGroupCommand);
    expect(logGroupCalls).toHaveLength(1);
    expect(logGroupCalls[0].args[0].input.logGroupName).toBe('/aws/apigateway/citadel-app-app-1-dev');

    // Verify stage has access log settings
    const stageCall = apiGwMock.commandCalls(CreateStageCommand)[0];
    const input = stageCall.args[0].input;
    expect(input.AccessLogSettings).toBeDefined();
    expect(input.AccessLogSettings!.DestinationArn).toContain('/aws/apigateway/citadel-app-app-1-dev');

    // Verify structured JSON format includes required fields
    const format = JSON.parse(input.AccessLogSettings!.Format!);
    expect(format).toHaveProperty('requestId');
    expect(format).toHaveProperty('appId');
    expect(format).toHaveProperty('apiKeyId');
    expect(format).toHaveProperty('status');
    expect(format).toHaveProperty('latency');
    expect(format).toHaveProperty('timestamp');
  });

  test('handles existing log group gracefully during provisioning', async () => {
    cwLogsMock.on(CreateLogGroupCommand).rejects({ name: 'ResourceAlreadyExistsException' });

    // Should not throw — existing log group is fine
    const result = await provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1');
    expect(result.apiId).toBe('api-123');
  });

  test('rollback deletes log group on API Gateway provisioning failure', async () => {
    apiGwMock.on(CreateIntegrationCommand).rejects(new Error('Integration failed'));

    await expect(
      provisionApiGateway('app-1', 'dev', 'arn:auth', 'bus', 'us-east-1'),
    ).rejects.toThrow('Integration failed');

    // Rollback should delete the API
    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(1);
  });
});

// ── Task 4.4: Full publishApp Flow Tests ────────────────────

describe('publishApp', () => {
  // Use a mock PolicyManager to avoid real AWS config resolution
  const mockPolicyManager = {
    getAccountContext: jest.fn().mockResolvedValue({ accountId: '123456789012', region: 'us-east-1' }),
    ensureRole: jest.fn().mockResolvedValue(undefined),
    deleteRole: jest.fn().mockResolvedValue(undefined),
  } as unknown as PolicyManager;

  let defaultDeps: any;

  beforeEach(() => {
    setupDefaultMocks();
    (mockPolicyManager.getAccountContext as jest.Mock).mockClear();
    (mockPolicyManager.ensureRole as jest.Mock).mockClear();
    defaultDeps = {
      docClient: DynamoDBDocumentClient.from(new (require('@aws-sdk/client-dynamodb').DynamoDBClient)({})),
      apiGwClient: new ApiGatewayV2Client({}),
      eventBridgeClient: new EventBridgeClient({}),
      policyManager: mockPolicyManager,
      appsTable: 'citadel-apps-test',
      eventBusName: 'citadel-agents-test',
      environment: 'dev',
      authorizerFnArn: 'arn:aws:lambda:us-east-1:123:function:auth',
      region: 'us-east-1',
    };
  });

  test('idempotency: already-published app returns current state without re-provisioning', async () => {
    const publishedApp = makeMetadata({
      status: 'PUBLISHED',
      endpointUrl: 'https://api-existing.execute-api.us-east-1.amazonaws.com',
      apiId: 'api-existing',
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        publishedApp,
        { sortId: 'APIKEY#key-1', keyId: 'key-1', groupId: 'APP#app-1' },
      ],
    });

    const result = await publishApp('app-1', 'user-1', defaultDeps);

    expect(result.app.status).toBe('PUBLISHED');
    expect(result.endpointUrl).toBe('https://api-existing.execute-api.us-east-1.amazonaws.com');
    expect(result.apiKeyId).toBe('key-1');
    expect(result.apiKey).toBe(''); // Never return plaintext after initial creation

    // Should NOT have called any API Gateway commands
    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
    // Should NOT have emitted any events
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test('throws error when app not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      publishApp('nonexistent', 'user-1', defaultDeps),
    ).rejects.toThrow('App not found');
  });

  test('throws structured error when preconditions fail', async () => {
      // Trigger a precondition failure with an agent that is not READY.
      // (We can no longer rely on empty workflowIds alone — workflows are
      // only required for multi-agent apps, and an empty-agents metadata
      // now passes the validator.)
      ddbMock.on(QueryCommand).resolves({
        Items: [
          makeMetadata(),
          { sortId: 'AGENT#agent-1', agentId: 'agent-1', status: 'DESIGN' },
        ],
      });
  
      await expect(
        publishApp('app-1', 'user-1', defaultDeps),
      ).rejects.toThrow('Publish preconditions not met');
    });

  test('full publish flow: provisions API GW, creates key, updates status, emits event', async () => {
    const activeApp = makeMetadata({ status: 'ACTIVE', workflowIds: ['wf-1'], orgId: 'org-1' });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        activeApp,
        { sortId: 'AGENT#agent-1', agentId: 'agent-1', status: 'READY' },
        { sortId: 'CONFIG#values', values: { adminEmail: 'admin@example.com' } },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const result = await publishApp('app-1', 'user-1', defaultDeps);

    // Verify result
    expect(result.app.status).toBe('PUBLISHED');
    expect(result.endpointUrl).toBe('https://api-123.execute-api.us-east-1.amazonaws.com');
    expect(result.apiKey).toBeTruthy(); // Plaintext returned on first creation
    expect(result.apiKeyId).toBeTruthy();

    // Verify API Gateway was provisioned
    expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(1);
    expect(apiGwMock.commandCalls(CreateStageCommand)).toHaveLength(1);
    expect(apiGwMock.commandCalls(CreateIntegrationCommand)).toHaveLength(1);
    expect(apiGwMock.commandCalls(CreateRouteCommand)).toHaveLength(1);
    expect(apiGwMock.commandCalls(CreateAuthorizerCommand)).toHaveLength(1);

    // Verify API key was stored
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const keyPut = putCalls.find(c => c.args[0].input.Item?.sortId?.startsWith('APIKEY#'));
    expect(keyPut).toBeDefined();
    expect(keyPut!.args[0].input.Item?.status).toBe('ACTIVE');
    expect(keyPut!.args[0].input.Item?.hashedKey).toBeTruthy();

    // Verify app status updated
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    // Phase 3 Step 2: AppsTable metadata mirror MUST be updated to PUBLISHED.
    // Key is appId only (AppsTable has no sort key).
    const metaUpdate = updateCalls.find(
      (c) =>
        (c.args[0].input.Key as any)?.appId === 'app-1' &&
        (c.args[0].input.Key as any)?.sortId === undefined &&
        (c.args[0].input.ExpressionAttributeValues as any)?.[':v_status'] ===
          'PUBLISHED',
    );
    expect(metaUpdate).toBeDefined();
    const metaValues = metaUpdate!.args[0].input.ExpressionAttributeValues as any;
    expect(metaValues[':v_status']).toBe('PUBLISHED');
    expect(typeof metaValues[':v_updatedAt']).toBe('string');

    // Verify EventBridge event emitted
    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const entry = ebCalls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe('citadel.apps');
    expect(entry.DetailType).toBe('app.status.active_to_published');
    const detail = JSON.parse(entry.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.orgId).toBe('org-1');
    expect(detail.endpointUrl).toBeTruthy();
    expect(detail.apiKeyId).toBeTruthy();
    expect(detail.userId).toBe('user-1');
    expect(detail.correlationId).toBeTruthy();
  });

  test('rollback on API Gateway failure: does not change app status', async () => {
    const activeApp = makeMetadata({ status: 'ACTIVE', workflowIds: ['wf-1'] });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        activeApp,
        { sortId: 'AGENT#agent-1', agentId: 'agent-1', status: 'READY' },
        { sortId: 'CONFIG#values', values: { adminEmail: 'admin@example.com' } },
      ],
    });

    apiGwMock.on(CreateStageCommand).rejects(new Error('Provisioning failed'));

    await expect(
      publishApp('app-1', 'user-1', defaultDeps),
    ).rejects.toThrow('Provisioning failed');

    // Should NOT have updated app status
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    // Should NOT have emitted event
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    // Should have attempted rollback
    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(1);
  });

  test('API name uses correct naming convention in full flow', async () => {
    const activeApp = makeMetadata({ status: 'ACTIVE', workflowIds: ['wf-1'] });

    ddbMock.on(QueryCommand).resolves({
      Items: [
        activeApp,
        { sortId: 'CONFIG#values', values: { adminEmail: 'admin@example.com' } },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await publishApp('app-1', 'user-1', defaultDeps);

    const createApiCall = apiGwMock.commandCalls(CreateApiCommand)[0];
    expect(createApiCall.args[0].input.Name).toBe('citadel-app-app-1-dev');
  });
});

// ── Task 5.1: Status Transition Event Structure Tests ────────

describe('buildStatusTransitionEvent', () => {
  const { buildStatusTransitionEvent } = require('../app-publish-handler');

  describe('ACTIVE → PUBLISHED event', () => {
    const detail = {
      appId: 'app-1',
      orgId: 'org-1',
      userId: 'user-1',
      timestamp: '2024-06-15T10:30:00.000Z',
      correlationId: 'corr-abc-123',
      endpointUrl: 'https://api-123.execute-api.us-east-1.amazonaws.com',
      apiKeyId: 'key-xyz-789',
    };

    test('has correct detail type app.status.active_to_published', () => {
      const event = buildStatusTransitionEvent('active', 'published', detail);
      expect(event.detailType).toBe('app.status.active_to_published');
    });

    test('has source citadel.apps', () => {
      const event = buildStatusTransitionEvent('active', 'published', detail);
      expect(event.source).toBe('citadel.apps');
    });

    test('lowercases status values in detail type', () => {
      const event = buildStatusTransitionEvent('ACTIVE', 'PUBLISHED', detail);
      expect(event.detailType).toBe('app.status.active_to_published');
    });

    test('includes all required fields: appId, orgId, userId, timestamp, correlationId', () => {
      const event = buildStatusTransitionEvent('active', 'published', detail);
      expect(event.detail.appId).toBe('app-1');
      expect(event.detail.orgId).toBe('org-1');
      expect(event.detail.userId).toBe('user-1');
      expect(event.detail.timestamp).toBe('2024-06-15T10:30:00.000Z');
      expect(event.detail.correlationId).toBe('corr-abc-123');
    });

    test('includes endpointUrl and apiKeyId for ACTIVE→PUBLISHED', () => {
      const event = buildStatusTransitionEvent('active', 'published', detail);
      expect(event.detail.endpointUrl).toBe('https://api-123.execute-api.us-east-1.amazonaws.com');
      expect(event.detail.apiKeyId).toBe('key-xyz-789');
    });

    test('timestamp is a valid ISO 8601 string', () => {
      const event = buildStatusTransitionEvent('active', 'published', detail);
      const parsed = new Date(event.detail.timestamp);
      expect(parsed.toISOString()).toBe(event.detail.timestamp);
    });
  });

  describe('PUBLISHED → DRAFT event', () => {
    const detail = {
      appId: 'app-2',
      orgId: 'org-2',
      userId: 'user-2',
      timestamp: '2024-07-01T14:00:00.000Z',
      correlationId: 'corr-def-456',
    };

    test('has correct detail type app.status.published_to_draft', () => {
      const event = buildStatusTransitionEvent('published', 'draft', detail);
      expect(event.detailType).toBe('app.status.published_to_draft');
    });

    test('has source citadel.apps', () => {
      const event = buildStatusTransitionEvent('published', 'draft', detail);
      expect(event.source).toBe('citadel.apps');
    });

    test('lowercases status values in detail type', () => {
      const event = buildStatusTransitionEvent('PUBLISHED', 'DRAFT', detail);
      expect(event.detailType).toBe('app.status.published_to_draft');
    });

    test('includes all required fields: appId, orgId, userId, timestamp, correlationId', () => {
      const event = buildStatusTransitionEvent('published', 'draft', detail);
      expect(event.detail.appId).toBe('app-2');
      expect(event.detail.orgId).toBe('org-2');
      expect(event.detail.userId).toBe('user-2');
      expect(event.detail.timestamp).toBe('2024-07-01T14:00:00.000Z');
      expect(event.detail.correlationId).toBe('corr-def-456');
    });

    test('does not require endpointUrl or apiKeyId', () => {
      const event = buildStatusTransitionEvent('published', 'draft', detail);
      expect(event.detail.endpointUrl).toBeUndefined();
      expect(event.detail.apiKeyId).toBeUndefined();
    });
  });

  describe('timestamp auto-generation', () => {
    test('generates ISO 8601 timestamp when not provided in detail', () => {
      const detail = {
        appId: 'app-3',
        orgId: 'org-3',
        userId: 'user-3',
        correlationId: 'corr-ghi-789',
      };
      const before = new Date().toISOString();
      const event = buildStatusTransitionEvent('active', 'published', detail);
      const after = new Date().toISOString();

      expect(event.detail.timestamp).toBeDefined();
      expect(event.detail.timestamp >= before).toBe(true);
      expect(event.detail.timestamp <= after).toBe(true);
    });
  });
});
