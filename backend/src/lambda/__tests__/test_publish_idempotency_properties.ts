/**
 * Property-based tests for publish/unpublish idempotence (Property 4)
 *
 * **Validates: Requirements 1.10, 8.8**
 *
 * For any already-published app, `publishApp` returns current state without
 * re-provisioning. For any non-published app, `unpublishApp` returns current
 * state without error.
 */
import * as fc from 'fast-check';
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateAuthorizerCommand,
  DeleteApiCommand,
} from '@aws-sdk/client-apigatewayv2';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { STSClient } from '@aws-sdk/client-sts';
import { IAMClient } from '@aws-sdk/client-iam';
import { mockClient } from 'aws-sdk-client-mock';

import { publishApp, unpublishApp, AppMetadata } from '../app-publish-handler';
import { PolicyManager } from '../../utils/policy-manager';

// ── Mocks ───────────────────────────────────────────────────

const apiGwMock = mockClient(ApiGatewayV2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const stsMock = mockClient(STSClient);
const iamMock = mockClient(IAMClient);

// ── Test Deps ───────────────────────────────────────────────

const mockPolicyManager = {
  getAccountContext: jest.fn().mockResolvedValue({ accountId: '123456789012', region: 'us-east-1' }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  deleteRole: jest.fn().mockResolvedValue(undefined),
} as unknown as PolicyManager;

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    apiGwClient: new ApiGatewayV2Client({}),
    eventBridgeClient: new EventBridgeClient({}),
    policyManager: mockPolicyManager,
    appsTable: 'citadel-apps-test',
    eventBusName: 'citadel-agents-test',
    environment: 'dev',
    authorizerFnArn: 'arn:aws:lambda:us-east-1:123:function:auth',
    region: 'us-east-1',
  };
}

// ── Generators ──────────────────────────────────────────────

/** Valid appId: alphanumeric + hyphens/underscores */
const appIdArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Valid API Gateway endpoint URL */
const endpointUrlArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s))
  .map(id => `https://${id}.execute-api.us-east-1.amazonaws.com`);

/** Valid API Gateway ID */
const apiIdArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s));

/** Valid API key ID */
const keyIdArb = fc.uuid();

/** Valid org ID */
const orgIdArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Non-published app statuses */
const nonPublishedStatusArb = fc.constantFrom('DRAFT', 'APPROVED', 'DEPRECATED');

/** Valid app name */
const appNameArb = fc.string({ minLength: 1, maxLength: 50 })
  .filter(s => s.trim().length > 0);

// ── Property 4 Tests ────────────────────────────────────────

describe('Property 4: Publish and unpublish idempotence', () => {

  beforeEach(() => {
    apiGwMock.reset();
    ddbMock.reset();
    ebMock.reset();
    stsMock.reset();
    iamMock.reset();
    (mockPolicyManager.getAccountContext as jest.Mock).mockClear();
    (mockPolicyManager.ensureRole as jest.Mock).mockClear();
    (mockPolicyManager.deleteRole as jest.Mock).mockClear();
  });

  /**
   * **Validates: Requirements 1.10**
   *
   * For any already-published app with arbitrary appId, endpointUrl, apiId,
   * keyId, and orgId, calling publishApp returns the current state without
   * calling any API Gateway SDK commands or emitting EventBridge events.
   */
  it('publishApp on already-published app returns current state without re-provisioning', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        endpointUrlArb,
        apiIdArb,
        keyIdArb,
        orgIdArb,
        async (appId, endpointUrl, apiId, keyId, orgId) => {
          apiGwMock.reset();
          ddbMock.reset();
          ebMock.reset();

          const publishedApp: AppMetadata = {
            appId,
            name: 'Published App',
            status: 'PUBLISHED',
            workflowIds: ['wf-1'],
            orgId,
            endpointUrl,
            apiId,
            sortId: 'METADATA',
            groupId: `APP#${appId}`,
          };

          ddbMock.on(QueryCommand).resolves({
            Items: [
              publishedApp,
              { sortId: `APIKEY#${keyId}`, keyId, groupId: `APP#${appId}` },
            ],
          });

          const result = await publishApp(appId, 'user-1', makeDeps());

          // Returns current published state
          expect(result.app.status).toBe('PUBLISHED');
          expect(result.endpointUrl).toBe(endpointUrl);
          expect(result.apiKeyId).toBe(keyId);
          // Never re-expose plaintext key
          expect(result.apiKey).toBe('');

          // No API Gateway provisioning commands called
          expect(apiGwMock.commandCalls(CreateApiCommand)).toHaveLength(0);
          expect(apiGwMock.commandCalls(CreateStageCommand)).toHaveLength(0);
          expect(apiGwMock.commandCalls(CreateIntegrationCommand)).toHaveLength(0);
          expect(apiGwMock.commandCalls(CreateRouteCommand)).toHaveLength(0);
          expect(apiGwMock.commandCalls(CreateAuthorizerCommand)).toHaveLength(0);

          // No EventBridge events emitted
          expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 8.8**
   *
   * For any non-published app (DRAFT, APPROVED, DEPRECATED), calling unpublishApp
   * returns the current app state without error or modification. No teardown
   * operations (API Gateway deletion, key revocation, IAM role deletion) are
   * performed.
   */
  it('unpublishApp on non-published app returns current state without error or modification', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        nonPublishedStatusArb,
        orgIdArb,
        appNameArb,
        async (appId, status, orgId, appName) => {
          apiGwMock.reset();
          ddbMock.reset();
          ebMock.reset();
          (mockPolicyManager.deleteRole as jest.Mock).mockClear();

          const app: AppMetadata = {
            appId,
            name: appName,
            status,
            workflowIds: ['wf-1'],
            orgId,
            sortId: 'METADATA',
            groupId: `APP#${appId}`,
          };

          ddbMock.on(QueryCommand).resolves({ Items: [app] });

          const result = await unpublishApp(appId, 'user-1', makeDeps());

          // Returns current state unchanged
          expect(result.app.status).toBe(status);
          expect(result.app.appId).toBe(appId);
          expect(result.app.name).toBe(appName);

          // No teardown operations performed
          expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(0);
          expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
          expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
          expect((mockPolicyManager.deleteRole as jest.Mock)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});
