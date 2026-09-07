/**
 * RED-first tests for finding 13a58234: publishApp/unpublishApp in
 * app-publish-handler.ts had NO org or role check at all. Any
 * authenticated caller could publish (mint+return a plaintext API key,
 * provision a billable external API Gateway, create an IAM role) or
 * unpublish (irreversibly delete the API Gateway/endpoint, revoke all
 * keys, delete the IAM role) ANY org's app.
 *
 * Fix under test: both mutations now fetch the app's Registry record and
 * gate via the SAME shared manifest-access gate landed in PR 134
 * (assertManifestAccess from registry-agent-record-resolver.ts), pinned at
 * requiredRole='owner', identical to grantAppAccess/revokeAppAccess and
 * deleteApp. The handler previously could not read the Registry record at
 * all; this suite exercises the new RegistryService wiring.
 *
 * Threat model asserted per operation (publishApp, unpublishApp):
 *   - cross-org caller (different org entirely): refused, ZERO side effects
 *   - same-org NON-OWNER (no access entry, no createdBy match): refused,
 *     ZERO side effects
 *   - missing identity / anonymous: refused, ZERO side effects
 *   - unresolvable org (extractOrgFromEvent returns null): refused
 *   - missing Registry record (app not found): refused
 *   - record with no owner entry AND no createdBy: refused (no implicit
 *     bypass possible)
 *   - legitimate OWNER (explicit access entry): succeeds end to end
 *   - legitimate implicit creator-owner (no access map yet, createdBy
 *     matches caller): succeeds end to end
 *   - admin bypass: succeeds even without an owner entry
 *
 * "Zero side effects" is asserted directly against the AWS SDK client
 * mocks: zero ApiGatewayV2 Create/Delete calls, zero API key generation
 * (no PutCommand with an APIKEY sortId), zero IAM role create/delete
 * (PolicyManager.ensureRole/deleteRole spies), zero EventBridge
 * PutEventsCommand calls, and zero app-metadata UpdateCommand status
 * writes. Additionally, no plaintext apiKey is ever present on a refused
 * publishApp response.
 */

process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.ENVIRONMENT = "test";
process.env.AUTHORIZER_FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:test-authorizer";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AWS_REGION = "us-east-1";

import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  CreateAuthorizerCommand,
  CreateRouteCommand,
  DeleteApiCommand,
} from "@aws-sdk/client-apigatewayv2";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

import {
  seedMockRegistry,
  resetMockRegistry,
} from "./fixtures/registry-service-mock";
import * as apiKeyHash from "../../utils/api-key-hash";
import { PolicyManager } from "../../utils/policy-manager";

const apiGwMock = mockClient(ApiGatewayV2Client);
const cwLogsMock = mockClient(CloudWatchLogsClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

jest.mock("../../services/registry-service", () => {
  const { getMockRegistryService } = jest.requireActual(
    "./fixtures/registry-service-mock",
  );
  const actual = jest.requireActual("../../services/registry-service");
  return {
    RegistryService: jest
      .fn()
      .mockImplementation(() => getMockRegistryService()),
    TypeMismatchError: actual.TypeMismatchError,
    RegistryLifecycleError: actual.RegistryLifecycleError,
  };
});

jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
    send: jest
      .fn()
      .mockRejectedValue(new Error("Cognito not reachable in test")),
  })),
  AdminGetUserCommand: jest.fn(),
}));

import { handler } from "../app-publish-handler";

const TEST_PEPPER = "e".repeat(64);

const APP_ID = "app-1";
const OWNER_ID = "owner-user";
const ATTACKER_ID = "attacker-user";
const APP_ORG = "org-1";
const OTHER_ORG = "org-2";

function seedApp(
  opts: {
    status?: string;
    orgId?: string | null;
    access?: Record<
      string,
      { role: string; grantedAt: string; grantedBy: string }
    > | null;
    createdBy?: string | null;
  } = {},
) {
  const manifest: Record<string, unknown> = {
    orgId: opts.orgId === undefined ? APP_ORG : opts.orgId,
    version: 1,
    status: opts.status ?? "ACTIVE",
    workflowIds: ["wf-1"],
    agentBindings: [],
    permissions: [],
    configSchema: null,
    configValues: null,
    authConfig: null,
    routingConfig: null,
  };
  if (opts.createdBy !== null) {
    manifest.createdBy = opts.createdBy ?? OWNER_ID;
  }
  manifest.access =
    opts.access !== undefined
      ? opts.access
      : {
          [OWNER_ID]: {
            role: "owner",
            grantedAt: "2024-01-01T00:00:00Z",
            grantedBy: "system",
          },
        };

  seedMockRegistry("agent", APP_ID, {
    name: "Test App",
    description: "Test",
    status: opts.status ?? "ACTIVE",
    customDescriptorContent: JSON.stringify({
      appId: APP_ID,
      manifest,
    }),
  });
}

function makeEvent(
  fieldName: "publishApp" | "unpublishApp",
  opts: { userId?: string; orgId?: string; groups?: string[] } = {},
) {
  const claims: Record<string, unknown> = {};
  if (opts.userId !== undefined) claims.sub = opts.userId;
  if (opts.orgId !== undefined) claims["custom:organization"] = opts.orgId;
  if (opts.groups !== undefined) claims["cognito:groups"] = opts.groups;
  return {
    info: { fieldName },
    arguments: { appId: APP_ID },
    identity:
      opts.userId !== undefined
        ? { sub: opts.userId, claims }
        : { claims: {} },
  };
}

function setupDefaultAwsMocks() {
  apiGwMock.reset();
  cwLogsMock.reset();
  ddbMock.reset();
  ebMock.reset();

  apiGwMock.on(CreateApiCommand).resolves({ ApiId: "api-123" });
  apiGwMock.on(CreateStageCommand).resolves({});
  apiGwMock.on(CreateIntegrationCommand).resolves({ IntegrationId: "int-1" });
  apiGwMock.on(CreateAuthorizerCommand).resolves({ AuthorizerId: "auth-1" });
  apiGwMock.on(CreateRouteCommand).resolves({});
  apiGwMock.on(DeleteApiCommand).resolves({});

  cwLogsMock.on(CreateLogGroupCommand).resolves({});
  cwLogsMock.on(DescribeLogGroupsCommand).resolves({
    logGroups: [
      {
        logGroupName: "/aws/apigateway/citadel-app-app-1-test",
        arn: "arn:aws:logs:us-east-1:123456789012:log-group:test:*",
      },
    ],
  });

  ddbMock.on(QueryCommand).resolves({
    Items: [
      {
        appId: APP_ID,
        sortId: "METADATA",
        groupId: `APP#${APP_ID}`,
        name: "Test App",
        status: "ACTIVE",
        workflowIds: ["wf-1"],
        orgId: APP_ORG,
        version: 1,
      },
    ],
  });
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});

  ebMock.on(PutEventsCommand).resolves({ Entries: [] });
}

function apiGwProvisioningCallCount(): number {
  return apiGwMock.commandCalls(CreateApiCommand).length;
}
function apiGwDeleteCallCount(): number {
  return apiGwMock.commandCalls(DeleteApiCommand).length;
}
function apiKeyPutCallCount(): number {
  return ddbMock
    .commandCalls(PutCommand)
    .filter((c) =>
      String(c.args[0].input.Item?.sortId ?? "").startsWith("APIKEY#"),
    ).length;
}
function statusUpdateCallCount(): number {
  return ddbMock.commandCalls(UpdateCommand).length;
}
function eventBridgePublishCount(): number {
  return ebMock.commandCalls(PutEventsCommand).length;
}

let ensureRoleSpy: jest.SpyInstance;
let deleteRoleSpy: jest.SpyInstance;

function expectZeroSideEffects() {
  expect(apiGwProvisioningCallCount()).toBe(0);
  expect(apiGwDeleteCallCount()).toBe(0);
  expect(apiKeyPutCallCount()).toBe(0);
  expect(statusUpdateCallCount()).toBe(0);
  expect(eventBridgePublishCount()).toBe(0);
  expect(ensureRoleSpy).not.toHaveBeenCalled();
  expect(deleteRoleSpy).not.toHaveBeenCalled();
}

describe("app-publish-handler — owner gate (finding 13a58234)", () => {
  beforeEach(() => {
    resetMockRegistry();
    setupDefaultAwsMocks();
    apiKeyHash.__resetApiKeyPepperCacheForTest();
    jest.spyOn(apiKeyHash, "getApiKeyPepper").mockResolvedValue(TEST_PEPPER);
    ensureRoleSpy = jest
      .spyOn(PolicyManager.prototype, "ensureRole")
      .mockResolvedValue(undefined as never);
    deleteRoleSpy = jest
      .spyOn(PolicyManager.prototype, "deleteRole")
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(PolicyManager.prototype, "getAccountContext")
      .mockResolvedValue({ accountId: "123456789012" } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("publishApp", () => {
    test("cross-org caller is refused with ZERO provisioning/key/IAM/event/status side effects", async () => {
      seedApp({ status: "ACTIVE" });
      const event = makeEvent("publishApp", {
        userId: ATTACKER_ID,
        orgId: OTHER_ORG,
      });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expectZeroSideEffects();
    });

    test("same-org non-owner caller is refused with ZERO side effects", async () => {
      seedApp({ status: "ACTIVE" });
      const event = makeEvent("publishApp", {
        userId: ATTACKER_ID,
        orgId: APP_ORG,
      });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expectZeroSideEffects();
    });

    test("missing identity is refused with ZERO side effects", async () => {
      seedApp({ status: "ACTIVE" });
      const event = makeEvent("publishApp", {});

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expectZeroSideEffects();
    });

    test("unresolvable org (no custom:organization claim, Cognito lookup fails) is refused", async () => {
      seedApp({ status: "ACTIVE" });
      const event = makeEvent("publishApp", { userId: ATTACKER_ID });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expectZeroSideEffects();
    });

    test("missing Registry record (app not found) is refused, not silently allowed", async () => {
      // No seedApp call — record does not exist.
      const event = makeEvent("publishApp", {
        userId: OWNER_ID,
        orgId: APP_ORG,
      });

      await expect(handler(event)).rejects.toThrow();
      expectZeroSideEffects();
    });

    test("record with no owner entry and no createdBy is refused (no implicit bypass)", async () => {
      seedApp({ status: "ACTIVE", access: {}, createdBy: null });
      const event = makeEvent("publishApp", {
        userId: ATTACKER_ID,
        orgId: APP_ORG,
      });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expectZeroSideEffects();
    });

    test("refused publishApp NEVER returns a plaintext apiKey", async () => {
      seedApp({ status: "ACTIVE" });
      const event = makeEvent("publishApp", {
        userId: ATTACKER_ID,
        orgId: OTHER_ORG,
      });

      let caught: unknown;
      try {
        await handler(event);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // The rejection is an Error, not a PublishResult — no apiKey field
      // could have leaked via a partial/successful-looking response.
      expect((caught as { apiKey?: unknown }).apiKey).toBeUndefined();
    });

    test("legitimate explicit owner succeeds end to end", async () => {
      seedApp({ status: "ACTIVE" });
      const event = makeEvent("publishApp", {
        userId: OWNER_ID,
        orgId: APP_ORG,
      });

      const result = await handler(event);
      expect(result.apiKey).toBeTruthy();
      expect(apiGwProvisioningCallCount()).toBe(1);
      expect(apiKeyPutCallCount()).toBe(1);
      expect(statusUpdateCallCount()).toBeGreaterThanOrEqual(1);
      expect(eventBridgePublishCount()).toBeGreaterThanOrEqual(1);
    });

    test("legitimate implicit creator-owner (no access map yet, createdBy matches) succeeds", async () => {
      seedApp({ status: "ACTIVE", access: {}, createdBy: OWNER_ID });
      const event = makeEvent("publishApp", {
        userId: OWNER_ID,
        orgId: APP_ORG,
      });

      const result = await handler(event);
      expect(result.apiKey).toBeTruthy();
    });

    test("admin bypass succeeds even without an owner entry", async () => {
      seedApp({ status: "ACTIVE", access: {}, createdBy: null });
      const event = makeEvent("publishApp", {
        userId: ATTACKER_ID,
        orgId: OTHER_ORG,
        groups: ["admin"],
      });

      const result = await handler(event);
      expect(result.apiKey).toBeTruthy();
    });
  });

  describe("unpublishApp", () => {
    test("cross-org caller is refused with ZERO teardown side effects", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            appId: APP_ID,
            sortId: "METADATA",
            groupId: `APP#${APP_ID}`,
            name: "Test App",
            status: "PUBLISHED",
            workflowIds: ["wf-1"],
            orgId: APP_ORG,
            apiId: "api-victim",
            endpointUrl: "https://api-victim.execute-api.us-east-1.amazonaws.com",
            version: 1,
          },
        ],
      });
      seedApp({ status: "PUBLISHED" });
      const event = makeEvent("unpublishApp", {
        userId: ATTACKER_ID,
        orgId: OTHER_ORG,
      });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expect(apiGwDeleteCallCount()).toBe(0);
      expect(statusUpdateCallCount()).toBe(0);
      expect(eventBridgePublishCount()).toBe(0);
      expect(deleteRoleSpy).not.toHaveBeenCalled();
    });

    test("same-org non-owner caller is refused with ZERO teardown side effects", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            appId: APP_ID,
            sortId: "METADATA",
            groupId: `APP#${APP_ID}`,
            name: "Test App",
            status: "PUBLISHED",
            workflowIds: ["wf-1"],
            orgId: APP_ORG,
            apiId: "api-victim",
            endpointUrl: "https://api-victim.execute-api.us-east-1.amazonaws.com",
            version: 1,
          },
        ],
      });
      seedApp({ status: "PUBLISHED" });
      const event = makeEvent("unpublishApp", {
        userId: ATTACKER_ID,
        orgId: APP_ORG,
      });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expect(apiGwDeleteCallCount()).toBe(0);
      expect(statusUpdateCallCount()).toBe(0);
      expect(eventBridgePublishCount()).toBe(0);
      expect(deleteRoleSpy).not.toHaveBeenCalled();
    });

    test("missing identity is refused with ZERO teardown side effects", async () => {
      seedApp({ status: "PUBLISHED" });
      const event = makeEvent("unpublishApp", {});

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expect(apiGwDeleteCallCount()).toBe(0);
      expect(deleteRoleSpy).not.toHaveBeenCalled();
    });

    test("missing Registry record is refused, not silently allowed", async () => {
      const event = makeEvent("unpublishApp", {
        userId: OWNER_ID,
        orgId: APP_ORG,
      });

      await expect(handler(event)).rejects.toThrow();
      expect(apiGwDeleteCallCount()).toBe(0);
    });

    test("record with no owner entry and no createdBy is refused", async () => {
      seedApp({ status: "PUBLISHED", access: {}, createdBy: null });
      const event = makeEvent("unpublishApp", {
        userId: ATTACKER_ID,
        orgId: APP_ORG,
      });

      await expect(handler(event)).rejects.toThrow(
        /Access denied/i,
      );
      expect(apiGwDeleteCallCount()).toBe(0);
      expect(deleteRoleSpy).not.toHaveBeenCalled();
    });

    test("legitimate explicit owner succeeds end to end", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            appId: APP_ID,
            sortId: "METADATA",
            groupId: `APP#${APP_ID}`,
            name: "Test App",
            status: "PUBLISHED",
            workflowIds: ["wf-1"],
            orgId: APP_ORG,
            apiId: "api-1",
            endpointUrl: "https://api-1.execute-api.us-east-1.amazonaws.com",
            version: 1,
          },
        ],
      });
      seedApp({ status: "PUBLISHED" });
      const event = makeEvent("unpublishApp", {
        userId: OWNER_ID,
        orgId: APP_ORG,
      });

      const result = await handler(event);
      expect(result.status).toBe("DRAFT");
      expect(apiGwDeleteCallCount()).toBe(1);
    });

    test("admin bypass succeeds even without an owner entry", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            appId: APP_ID,
            sortId: "METADATA",
            groupId: `APP#${APP_ID}`,
            name: "Test App",
            status: "PUBLISHED",
            workflowIds: ["wf-1"],
            orgId: APP_ORG,
            apiId: "api-1",
            endpointUrl: "https://api-1.execute-api.us-east-1.amazonaws.com",
            version: 1,
          },
        ],
      });
      seedApp({ status: "PUBLISHED", access: {}, createdBy: null });
      const event = makeEvent("unpublishApp", {
        userId: ATTACKER_ID,
        orgId: OTHER_ORG,
        groups: ["admin"],
      });

      const result = await handler(event);
      expect(result.status).toBe("DRAFT");
    });
  });
});
