/**
 * Dedicated test module for the "USER_POOL_ID not configured" fallback
 * path in registry-agent-record-resolver's resolveCreatedByName.
 *
 * USER_POOL_ID is read into a module-level `const` at import time
 * (`const USER_POOL_ID = process.env.USER_POOL_ID || ''`), so this scenario
 * can only be exercised by NOT setting the env var before this file's
 * top-level import of the resolver runs — hence a separate file rather than
 * a test case inside registry-agent-record-resolver-name-resolution.test.ts
 * (which sets USER_POOL_ID for its other cases before its own import).
 */
process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.AWS_REGION = "us-east-1";
delete process.env.USER_POOL_ID;
delete process.env.AUTHORITY_UNITS_TABLE;

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

import {
  seedMockRegistry,
  resetMockRegistry,
} from "./fixtures/registry-service-mock";

jest.mock("../../services/registry-service", () => {
  const { getMockRegistryService } = jest.requireActual(
    "./fixtures/registry-service-mock",
  );
  return {
    RegistryService: jest
      .fn()
      .mockImplementation(() => getMockRegistryService()),
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
  };
});

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

jest.mock("../../utils/appsync-publish", () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from "../registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(fieldName: string, args: Record<string, unknown>) {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      sub: "user-123",
      claims: { sub: "user-123", "custom:organization": "org-1" },
    },
  } as unknown as HandlerEvent;
}

describe("registry-agent-record-resolver — resolveCreatedByName with USER_POOL_ID unset", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [], LastEvaluatedKey: undefined });
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    cognitoMock.reset();

    seedMockRegistry("agent", "app-1", {
      name: "Test App",
      description: "Test",
      status: "DRAFT",
      customDescriptorContent: JSON.stringify({
        appId: "app-1",
        manifest: {
          orgId: "org-1",
          createdBy: "user-abc-123",
          version: 1,
          status: "DRAFT",
          workflowIds: [],
          agentBindings: [],
          permissions: [],
          access: {},
        },
      }),
    });
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.AWS_REGION;
    delete process.env.REGISTRY_ID;
  });

  test("falls back to the raw userId and makes zero AdminGetUser calls when USER_POOL_ID is unset", async () => {
    const result = await invokeHandler(makeEvent("getApp", { appId: "app-1" }));

    expect(result.createdByName).toBe("user-abc-123");
    expect(cognitoMock.commandCalls(AdminGetUserCommand)).toHaveLength(0);
  });
});
