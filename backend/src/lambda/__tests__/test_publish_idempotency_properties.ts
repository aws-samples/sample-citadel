/**
 * Property-based tests for publish/unpublish idempotence (Property 4)
 *
 * **Validates: Requirements 1.10, 8.8**
 *
 * For any already-published app, `publishApp` returns current state without
 * re-provisioning. For any non-published app, `unpublishApp` returns current
 * state without error.
 */
process.env.REGISTRY_ID = 'test-registry-id';

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

import {
  seedMockRegistry,
  resetMockRegistry,
} from './fixtures/registry-service-mock';

// This file tests publishApp/unpublishApp directly (not through the
// handler), so it must mock RegistryService itself for the owner gate
// (finding 13a58234). Every call site below passes an OWNER_EVENT built
// from the property-generated appId, and seedOwnerApp seeds a matching
// Registry record per property run, so the gate passes and the pre-fix
// idempotency behavior is exercised unchanged.
jest.mock('../../services/registry-service', () => {
  const { getMockRegistryService } = jest.requireActual(
    './fixtures/registry-service-mock',
  );
  const actual = jest.requireActual('../../services/registry-service');
  return {
    RegistryService: jest
      .fn()
      .mockImplementation(() => getMockRegistryService()),
    TypeMismatchError: actual.TypeMismatchError,
    RegistryLifecycleError: actual.RegistryLifecycleError,
  };
});

import { publishApp, unpublishApp, AppMetadata } from '../app-publish-handler';
import { PolicyManager } from '../../utils/policy-manager';

// ── Owner-gate fixture (finding 13a58234) ───────────────────

const IDEMPOTENCY_OWNER_ID = 'user-1';
const IDEMPOTENCY_APP_ORG = 'owner-org';

/** AppSync event authorized as the seeded app's owner — see seedOwnerApp. */
const OWNER_EVENT = {
  identity: {
    sub: IDEMPOTENCY_OWNER_ID,
    claims: {
      sub: IDEMPOTENCY_OWNER_ID,
      'custom:organization': IDEMPOTENCY_APP_ORG,
    },
  },
};

/**
 * Seeds a mock Registry record for `appId` whose manifest.createdBy ==
 * IDEMPOTENCY_OWNER_ID and manifest.orgId == IDEMPOTENCY_APP_ORG, matching
 * OWNER_EVENT's claims, so assertManifestAccess's org-equality check plus
 * implicit-creator-owner fallback both pass regardless of the
 * property-generated orgId used in the AppMetadata row itself (that value
 * only flows into the EventBridge event detail, not the Registry gate).
 */
function seedOwnerApp(appId: string) {
  seedMockRegistry('agent', appId, {
    name: 'Test App',
    status: 'ACTIVE',
    customDescriptorContent: JSON.stringify({
      appId,
      manifest: {
        orgId: IDEMPOTENCY_APP_ORG,
        createdBy: IDEMPOTENCY_OWNER_ID,
        access: {},
      },
    }),
  });
}

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
    resetMockRegistry();
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
          resetMockRegistry();
          seedOwnerApp(appId);

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

          const result = await publishApp(appId, 'user-1', OWNER_EVENT, makeDeps());

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
          resetMockRegistry();
          seedOwnerApp(appId);
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

          const result = await unpublishApp(appId, 'user-1', OWNER_EVENT, makeDeps());

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
