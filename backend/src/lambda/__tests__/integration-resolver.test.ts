/**
 * Unit Tests for Integration Resolver
 *
 * These tests verify specific examples and edge cases for integration operations.
 *
 * Feature: agentcore-integration-types
 */

import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

// Mock AWS SDK clients
const dynamoMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);
const bedrockAgentMock = mockClient(BedrockAgentCoreControlClient);
// P3.A: integration-resolver now publishes EventBridge events for the
// async target lifecycle. Mock the client so tests don't reach for real
// AWS credentials (which triggers credential-provider-node's dynamic
// import → ESM error under Jest).
const eventBridgeMock = mockClient(EventBridgeClient);

// P2.B: gateway-target-manager now delegates credential provisioning to the real
// credential-provider-manager (was a stub before). Mock that module here so
// MCP_SERVER tests don't need to also stub the AgentCore Identity SDK calls
// for CreateApiKey/CreateOauth2 commands.
jest.mock("../../utils/credential-provider-manager", () => ({
  createOrUpsertApiKeyProvider: jest.fn(
    async ({ integrationId }: { integrationId: string }) => ({
      credentialProviderArn: `arn:aws:bedrock-agentcore:us-east-1:111:api-key-credential-provider/integration-${integrationId}-api-key`,
      internalSecretArn:
        "arn:aws:secretsmanager:us-east-1:111:secret:apikey-test",
      rawResponse: {},
    }),
  ),
  createOrUpsertOauth2Provider: jest.fn(
    async ({ integrationId }: { integrationId: string }) => ({
      credentialProviderArn: `arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-${integrationId}-oauth`,
      callbackUrl: "https://agentcore.aws/oauth/callback/test",
      internalSecretArn:
        "arn:aws:secretsmanager:us-east-1:111:secret:oauth-test",
      rawResponse: {},
    }),
  ),
  deleteApiKeyProvider: jest.fn(async () => undefined),
  deleteOauth2Provider: jest.fn(async () => undefined),
}));
jest.mock("../../utils/oauth-metadata", () => {
  const actual = jest.requireActual("../../utils/oauth-metadata");
  return {
    ...actual,
    discoverOAuthEndpoints: jest.fn(async () => null),
  };
});

// Import the handler after mocking
import { handler } from "../integration-resolver";
// These resolve to the jest.mock factories above (jest.mock is hoisted),
// replacing the previous inline `require()` calls.
import * as credentialProviderManager from "../../utils/credential-provider-manager";
import * as oauthMetadata from "../../utils/oauth-metadata";

type HandlerEvent = Parameters<typeof handler>[0];

/** Result fields read by the assertions in this file. */
interface IntegrationResult {
  integrationType?: string;
  gatewayTargetId?: string;
  status?: string;
  targetStatus?: string;
  success?: boolean;
  credentialProviderArn?: string;
  agentCoreCallbackUrl?: string;
  authorizationUrl?: string;
}

/**
 * Invokes the handler with a partially-specified AppSync event literal.
 * The handler's real signature is a single-event async function; tests
 * build structural event literals, so the cast is centralized here.
 */
async function invoke<T = IntegrationResult>(
  event: Record<string, unknown>,
): Promise<T> {
  return (await handler(event as unknown as HandlerEvent)) as T;
}

describe("Integration Resolver - Unit Tests", () => {
  beforeEach(() => {
    dynamoMock.reset();
    secretsMock.reset();
    ssmMock.reset();
    bedrockAgentMock.reset();
    eventBridgeMock.reset();
    // Default: EventBridge publish succeeds. Specific tests override.
    eventBridgeMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [] });

    // Set environment variables
    process.env.INTEGRATIONS_TABLE = "test-integrations-table";
    process.env.AGENTCORE_GATEWAY_ID = "test-gateway-id";
    process.env.AWS_REGION = "us-east-1";
    process.env.ACCOUNT_ID = "123456789012";
    process.env.ENVIRONMENT = "test";
    process.env.EVENT_BUS_NAME = "test-event-bus";
  });

  afterEach(() => {
    delete process.env.INTEGRATIONS_TABLE;
    delete process.env.AGENTCORE_GATEWAY_ID;
    delete process.env.AWS_REGION;
    delete process.env.ACCOUNT_ID;
    delete process.env.ENVIRONMENT;
    delete process.env.EVENT_BUS_NAME;
  });

  describe("createIntegration - AWS Lambda", () => {
    test("should create Lambda integration with gateway target", async () => {
      const mockTargetId = "target-lambda-123";

      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda",
      });

      // Mock SSM
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "AWS_LAMBDA",
            name: "Test Lambda Integration",
            orgId: "org-123",
            credentials: {
              executionRoleArn:
                "arn:aws:iam::123456789012:role/LambdaExecutionRole",
            },
            config: {
              lambdaArn:
                "arn:aws:lambda:us-east-1:123456789012:function:MyFunction",
              toolSchema: JSON.stringify({
                name: "my_tool",
                description: "Test tool",
                inputSchema: {
                  type: "object",
                  properties: {
                    param1: { type: "string" },
                  },
                },
              }),
              region: "us-east-1",
            },
          },
        },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      expect(result).toBeDefined();
      expect(result.integrationType).toBe("AWS_LAMBDA");
      // P3.A: gatewayTargetId is set asynchronously by
      // gateway-registration-handler — not by the resolver. The resolver
      // returns immediately with status=CONFIGURED and targetStatus=PENDING.
      expect(result.gatewayTargetId).toBeUndefined();
      expect(result.status).toBe("CONFIGURED");
      expect(result.targetStatus).toBe("PENDING");

      // Verify the resolver published `integration.connect.requested`
      // (which is what triggers async target creation in the handler).
      const eventCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(eventCalls.length).toBe(1);
      const entry = eventCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe("integration.connect.requested");
      // Resolver must NOT call Bedrock directly anymore — target creation
      // is the handler's responsibility.
      expect(bedrockAgentMock.calls().length).toBe(0);
    });

    test("should surface credential-provider provisioning failure with secret cleanup", async () => {
      // P3.A: the only sync failure surface left in createIntegration is
      // credential-provider provisioning (target creation is async). When
      // provisioning rejects, the resolver must roll back the secret and
      // re-throw with a `Failed to provision credential provider` prefix.
      const upsertApiKeyMock =
        credentialProviderManager.createOrUpsertApiKeyProvider as jest.Mock;

      upsertApiKeyMock.mockImplementationOnce(async () => {
        throw new Error("AgentCore Identity service unavailable");
      });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-mcp",
      });

      // Mock SSM
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "Test MCP Integration",
            orgId: "org-123",
            credentials: { authMethod: "API_KEY", apiKey: "k-1" },
            config: { serverUrl: "https://mcp.example.com" },
          },
        },
        identity: { username: "test-user" },
      };

      await expect(invoke(event)).rejects.toThrow(
        /Failed to provision credential provider/,
      );

      // Verify secret cleanup was attempted (best-effort rollback).
      const deleteSecretCalls = secretsMock
        .calls()
        .filter(
          (call) => call.firstArg?.constructor?.name === "DeleteSecretCommand",
        );
      expect(deleteSecretCalls.length).toBeGreaterThan(0);

      // Restore default mock for downstream tests in this file.
      upsertApiKeyMock.mockImplementation(
        async ({ integrationId }: { integrationId: string }) => ({
          credentialProviderArn: `arn:aws:bedrock-agentcore:us-east-1:111:api-key-credential-provider/integration-${integrationId}-api-key`,
          internalSecretArn:
            "arn:aws:secretsmanager:us-east-1:111:secret:apikey-test",
          rawResponse: {},
        }),
      );
    });
  });

  describe("createIntegration - AWS Smithy", () => {
    test("should create Smithy integration with gateway target", async () => {
      const mockTargetId = "target-smithy-123";

      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-smithy",
      });

      // Mock SSM
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "AWS_SMITHY",
            name: "Test Smithy Integration",
            orgId: "org-123",
            credentials: {
              executionRoleArn:
                "arn:aws:iam::123456789012:role/ServiceExecutionRole",
            },
            config: {
              serviceType: "dynamodb",
              region: "us-east-1",
            },
          },
        },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      expect(result).toBeDefined();
      expect(result.integrationType).toBe("AWS_SMITHY");
      // P3.A: target creation is async — gatewayTargetId not set by resolver.
      expect(result.gatewayTargetId).toBeUndefined();
      expect(result.status).toBe("CONFIGURED");
      expect(result.targetStatus).toBe("PENDING");
      expect(eventBridgeMock.commandCalls(PutEventsCommand).length).toBe(1);
      expect(bedrockAgentMock.calls().length).toBe(0);
    });
  });

  describe("createIntegration - MCP Server", () => {
    test("should create MCP Server integration with API Key auth", async () => {
      const mockTargetId = "target-mcp-123";

      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-mcp",
      });

      // Mock SSM
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "Test MCP Server Integration",
            orgId: "org-123",
            credentials: {
              authMethod: "API_KEY",
              apiKey: "test-api-key-123",
            },
            config: {
              serverUrl: "https://mcp.example.com",
            },
          },
        },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      expect(result).toBeDefined();
      expect(result.integrationType).toBe("MCP_SERVER");
      // P3.A: target creation is async; gatewayTargetId is set later by handler.
      expect(result.gatewayTargetId).toBeUndefined();
      expect(result.status).toBe("CONFIGURED");
      expect(result.targetStatus).toBe("PENDING");
      expect(eventBridgeMock.commandCalls(PutEventsCommand).length).toBe(1);
      expect(bedrockAgentMock.calls().length).toBe(0);
    });

    test("should create MCP Server integration with OAuth2 auth", async () => {
      const mockTargetId = "target-mcp-oauth-123";

      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: mockTargetId });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-mcp-oauth",
      });

      // Mock SSM
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "Test MCP Server OAuth Integration",
            orgId: "org-123",
            credentials: {
              authMethod: "OAUTH2",
              clientId: "test-client-id",
              clientSecret: "test-client-secret",
              grantType: "CLIENT_CREDENTIALS",
              scopes: ["read:tools"],
              tokenUrl: "https://idp.example.com/oauth/token",
            },
            config: {
              serverUrl: "https://mcp-oauth.example.com",
            },
          },
        },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      expect(result).toBeDefined();
      expect(result.integrationType).toBe("MCP_SERVER");
      // P3.A: target creation is async.
      expect(result.gatewayTargetId).toBeUndefined();
      expect(result.status).toBe("CONFIGURED");
      expect(result.targetStatus).toBe("PENDING");
      expect(eventBridgeMock.commandCalls(PutEventsCommand).length).toBe(1);
      expect(bedrockAgentMock.calls().length).toBe(0);
    });
  });

  describe("deleteIntegration - AgentCore types", () => {
    test("should delete Lambda integration and gateway target", async () => {
      const integrationId = "lambda-integration-123";
      const mockTargetId = "target-lambda-123";

      // Mock DynamoDB Query to return integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-123",
            SK: `INTEGRATION#AWS_LAMBDA#${integrationId}`,
            integrationId,
            integrationType: "AWS_LAMBDA",
            name: "Test Lambda Integration",
            status: "CONFIGURED",
            orgId: "org-123",
            gatewayTargetId: mockTargetId,
            secretArn:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda",
            ssmParameterPrefix: "/test/lambda",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "Amazon Web Services",
              authMethod: "IAM_ROLE",
            },
          },
        ],
      });

      // Mock gateway target deletion (verify resolver does NOT call it).
      let gatewayDeleteCalled = false;
      bedrockAgentMock.on(DeleteGatewayTargetCommand).callsFake(() => {
        gatewayDeleteCalled = true;
        return {};
      });

      // Mock secrets manager deletion
      secretsMock.on(DeleteSecretCommand).resolves({});

      // Mock SSM deletion
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB deletion (P3.A: resolver uses UpdateCommand for DELETING; handler does the DeleteCommand later).
      dynamoMock.on(DeleteCommand).resolves({});
      dynamoMock.on(UpdateCommand).resolves({});

      const event = {
        info: { fieldName: "deleteIntegration" },
        arguments: { integrationId },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      expect(result.success).toBe(true);
      // P3.A: deleteIntegration emits an event and marks DDB targetStatus=DELETING.
      // Actual gateway-target deletion is the handler's responsibility — the
      // resolver MUST NOT call it directly anymore.
      expect(gatewayDeleteCalled).toBe(false);
      const eventCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(eventCalls.length).toBe(1);
      expect(eventCalls[0].args[0].input.Entries![0].DetailType).toBe(
        "integration.disconnect.requested",
      );
      expect(dynamoMock.commandCalls(UpdateCommand).length).toBe(1);
    });

    test("should treat ResourceNotFoundException as success and continue deletion", async () => {
      // P2.A contract change: deleteIntegration is strict — only
      // ResourceNotFoundException is treated as success. Other errors
      // surface and abort downstream cleanup. See the P2.A "target delete
      // failure (non-RNF)" test below for the failure path.
      const integrationId = "lambda-integration-456";
      const mockTargetId = "target-lambda-456";

      // Mock DynamoDB Query to return integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-123",
            SK: `INTEGRATION#AWS_LAMBDA#${integrationId}`,
            integrationId,
            integrationType: "AWS_LAMBDA",
            name: "Test Lambda Integration",
            status: "CONFIGURED",
            orgId: "org-123",
            gatewayTargetId: mockTargetId,
            secretArn:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda",
            ssmParameterPrefix: "/test/lambda",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "Amazon Web Services",
              authMethod: "IAM_ROLE",
            },
          },
        ],
      });

      // Mock gateway target deletion to throw ResourceNotFoundException —
      // treated as success per the P2.A strict-ordering contract.
      const rnf = new Error("Gateway target not found");
      rnf.name = "ResourceNotFoundException";
      bedrockAgentMock.on(DeleteGatewayTargetCommand).rejects(rnf);

      // Mock secrets manager deletion
      secretsMock.on(DeleteSecretCommand).resolves({});

      // Mock SSM deletion
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB deletion
      dynamoMock.on(DeleteCommand).resolves({});

      const event = {
        info: { fieldName: "deleteIntegration" },
        arguments: { integrationId },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      // Should still succeed when target was already gone (RNF = idempotent).
      expect(result.success).toBe(true);
    });

    test("should not call gateway delete for non-AgentCore types", async () => {
      const integrationId = "confluence-integration-123";

      // Mock DynamoDB Query to return non-AgentCore integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-123",
            SK: `INTEGRATION#CONFLUENCE#${integrationId}`,
            integrationId,
            integrationType: "CONFLUENCE",
            name: "Test Confluence Integration",
            status: "CONFIGURED",
            orgId: "org-123",
            secretArn:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-confluence",
            ssmParameterPrefix: "/test/confluence",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "REST",
              provider: "Atlassian",
              authMethod: "API_KEY",
            },
          },
        ],
      });

      // Mock secrets manager deletion
      secretsMock.on(DeleteSecretCommand).resolves({});

      // Mock SSM deletion
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB deletion
      dynamoMock.on(DeleteCommand).resolves({});

      const event = {
        info: { fieldName: "deleteIntegration" },
        arguments: { integrationId },
        identity: { username: "test-user" },
      };

      const result = await invoke(event);

      expect(result.success).toBe(true);
      // Verify gateway API was NOT called
      expect(bedrockAgentMock.calls().length).toBe(0);
    });
  });

  describe("testIntegration - AgentCore types", () => {
    test("should retrieve config from SSM for Lambda integration", async () => {
      const integrationId = "lambda-integration-test-123";

      // Mock DynamoDB Query to return integration
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-123",
            SK: `INTEGRATION#AWS_LAMBDA#${integrationId}`,
            integrationId,
            integrationType: "AWS_LAMBDA",
            name: "Test Lambda Integration",
            status: "CONFIGURED",
            orgId: "org-123",
            gatewayTargetId: "target-123",
            secretArn:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-lambda",
            ssmParameterPrefix: "/test/lambda",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "Amazon Web Services",
              authMethod: "IAM_ROLE",
            },
          },
        ],
      });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        SecretString: JSON.stringify({
          executionRoleArn:
            "arn:aws:iam::123456789012:role/LambdaExecutionRole",
        }),
      });

      // Track SSM parameter retrieval
      let ssmGetCalled = false;
      ssmMock.on(GetParameterCommand).callsFake(() => {
        ssmGetCalled = true;
        return {
          Parameter: {
            Value: "test-value",
          },
        };
      });

      // Mock DynamoDB Put for status update
      dynamoMock.on(PutCommand).resolves({});

      const event = {
        info: { fieldName: "testIntegration" },
        arguments: { integrationId },
        identity: { username: "test-user" },
      };

      // This will fail at connection test but we can verify SSM retrieval
      try {
        await invoke(event);
      } catch {
        // Expected to fail at connection test
      }

      // Verify SSM was called to retrieve config
      expect(ssmGetCalled).toBe(true);
    });
  });

  describe("Error handling and logging", () => {
    test("should sanitize IAM role ARNs in logs", async () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      // Mock gateway target creation
      bedrockAgentMock.onAnyCommand().resolves({ targetId: "target-123" });

      // Mock secrets manager
      secretsMock.onAnyCommand().resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test",
      });

      // Mock SSM
      ssmMock.onAnyCommand().resolves({});

      // Mock DynamoDB
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "AWS_LAMBDA",
            name: "Test Lambda Integration",
            orgId: "org-123",
            credentials: {
              executionRoleArn: "arn:aws:iam::123456789012:role/SensitiveRole",
            },
            config: {
              lambdaArn:
                "arn:aws:lambda:us-east-1:123456789012:function:MyFunction",
              toolSchema: JSON.stringify({
                name: "my_tool",
                description: "Test tool",
                inputSchema: { type: "object" },
              }),
              region: "us-east-1",
            },
          },
        },
        identity: { username: "test-user" },
      };

      await invoke(event);

      // Check that logs don't contain the actual role ARN
      const logCalls = consoleSpy.mock.calls;
      const hasRedactedCredentials = logCalls.some((call) =>
        JSON.stringify(call).includes("[REDACTED]"),
      );

      expect(hasRedactedCredentials).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P2.A: Wired credential-provider provisioning + 3LO authorization +
  // strict deletion ordering. Backed by the refactored gateway-target-manager
  // (P2.B) and the Phase 1 credential-provider-manager.
  // ────────────────────────────────────────────────────────────────────────
  describe("P2.A: createIntegration MCP_SERVER credential-provider wiring", () => {
    const upsertOauth2Mock =
      credentialProviderManager.createOrUpsertOauth2Provider as jest.Mock;
    const upsertApiKeyMock =
      credentialProviderManager.createOrUpsertApiKeyProvider as jest.Mock;
    const deleteOauth2Mock =
      credentialProviderManager.deleteOauth2Provider as jest.Mock;
    const deleteApiKeyMock =
      credentialProviderManager.deleteApiKeyProvider as jest.Mock;
    const discoverMock = oauthMetadata.discoverOAuthEndpoints as jest.Mock;

    beforeEach(() => {
      upsertOauth2Mock.mockClear();
      upsertApiKeyMock.mockClear();
      deleteOauth2Mock.mockClear();
      deleteApiKeyMock.mockClear();
      discoverMock.mockClear();
      // Restore the default mock impl in case a prior test overrode it.
      discoverMock.mockImplementation(async () => null);
    });

    test("MCP_SERVER + OAUTH2 + CLIENT_CREDENTIALS persists credentialProviderArn and agentCoreCallbackUrl", async () => {
      const mockTargetId = "target-mcp-2lo-1";
      bedrockAgentMock
        .on(CreateGatewayTargetCommand)
        .resolves({ targetId: mockTargetId });
      secretsMock
        .onAnyCommand()
        .resolves({
          ARN: "arn:aws:secretsmanager:us-east-1:111:secret:mcp-2lo",
        });
      ssmMock.onAnyCommand().resolves({});
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "MCP 2LO",
            orgId: "org-2lo",
            credentials: {
              authMethod: "OAUTH2",
              clientId: "cid",
              clientSecret: "csec",
              grantType: "CLIENT_CREDENTIALS",
              scopes: ["read:tools"],
              tokenUrl: "https://idp.example.com/oauth/token",
            },
            config: { serverUrl: "https://mcp.example.com" },
          },
        },
        identity: { username: "tester" },
      };

      const result = await invoke(event);

      expect(upsertOauth2Mock).toHaveBeenCalledTimes(1);
      const provisionCall = upsertOauth2Mock.mock.calls[0][0];
      expect(provisionCall.clientId).toBe("cid");
      expect(provisionCall.clientSecret).toBe("csec");
      expect(provisionCall.grantType).toBe("CLIENT_CREDENTIALS");
      expect(provisionCall.endpoints.tokenEndpoint).toBe(
        "https://idp.example.com/oauth/token",
      );

      // P3.A: target creation is async — the resolver does NOT call
      // CreateGatewayTargetCommand. It emits `integration.connect.requested`
      // with the credentialProviderArn so the handler can build the target
      // payload using the real ARN from the credential-provider-manager mock.
      const createCalls = bedrockAgentMock.commandCalls(
        CreateGatewayTargetCommand,
      );
      expect(createCalls.length).toBe(0);
      const eventCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(eventCalls.length).toBe(1);
      const detail = JSON.parse(
        eventCalls[0].args[0].input.Entries![0].Detail!,
      );
      expect(detail.credentialProviderArn).toMatch(
        /oauth2-credential-provider/,
      );
      expect(detail.credentialProviderType).toBe("OAUTH2");

      // The DDB record persists credentialProviderArn + agentCoreCallbackUrl.
      const putCalls = dynamoMock.commandCalls(PutCommand);
      const persisted = putCalls[putCalls.length - 1].args[0].input
        .Item as Record<string, unknown>;
      // P3.A: gatewayTargetId is set later by the handler; resolver leaves it undefined.
      expect(persisted.gatewayTargetId).toBeUndefined();
      expect(persisted.targetStatus).toBe("PENDING");
      expect(persisted.credentialProviderArn).toMatch(
        /oauth2-credential-provider/,
      );
      expect(persisted.agentCoreCallbackUrl).toBe(
        "https://agentcore.aws/oauth/callback/test",
      );
      expect(persisted.credentialProviderType).toBe("OAUTH2");
      // 2LO has no authorizationUrl.
      expect(persisted.authorizationUrl).toBeUndefined();

      // Returned to caller (sanitised).
      expect(result.credentialProviderArn).toMatch(
        /oauth2-credential-provider/,
      );
      expect(result.agentCoreCallbackUrl).toBe(
        "https://agentcore.aws/oauth/callback/test",
      );
    });

    test("MCP_SERVER + OAUTH2 + AUTHORIZATION_CODE persists PENDING + emits event with OAUTH2 type", async () => {
      // P3.A: the resolver no longer creates the gateway target sync, so
      // the CREATE_PENDING_AUTH transition + authorizationUrl now come from
      // the gateway-registration-handler asynchronously. The resolver's
      // contract here is:
      //   - persist `targetStatus: PENDING` (handler will flip to
      //     CREATE_PENDING_AUTH)
      //   - emit `integration.connect.requested` with credentialProviderType
      //     OAUTH2 so the handler knows to expect a 3LO challenge
      //   - leave `authorizationUrl` unset until the handler resolves it
      const idpAuthUrl = "https://idp.example.com/oauth/authorize?state=abc";
      void idpAuthUrl; // retained for parity with the handler-level test
      secretsMock
        .onAnyCommand()
        .resolves({
          ARN: "arn:aws:secretsmanager:us-east-1:111:secret:mcp-3lo",
        });
      ssmMock.onAnyCommand().resolves({});
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "MCP 3LO",
            orgId: "org-3lo",
            credentials: {
              authMethod: "OAUTH2",
              clientId: "cid",
              clientSecret: "csec",
              grantType: "AUTHORIZATION_CODE",
              scopes: ["read:tools"],
              tokenUrl: "https://idp.example.com/oauth/token",
              authorizationUrl: "https://idp.example.com/oauth/authorize",
            },
            config: { serverUrl: "https://mcp.example.com" },
          },
        },
        identity: { username: "tester" },
      };

      const result = await invoke(event);

      const putCalls = dynamoMock.commandCalls(PutCommand);
      const persisted = putCalls[putCalls.length - 1].args[0].input
        .Item as Record<string, unknown>;
      expect(persisted.targetStatus).toBe("PENDING");
      // Resolver does not yet know the IdP authorization URL — handler
      // populates it after sync-target creation.
      expect(persisted.authorizationUrl).toBeUndefined();
      expect(persisted.credentialProviderType).toBe("OAUTH2");

      const eventCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(eventCalls.length).toBe(1);
      const detail = JSON.parse(
        eventCalls[0].args[0].input.Entries![0].Detail!,
      );
      expect(detail.credentialProviderType).toBe("OAUTH2");

      expect(result.targetStatus).toBe("PENDING");
      expect(result.authorizationUrl).toBeUndefined();
    });

    test("MCP_SERVER + OAUTH2 + discoveryUrl uses discovered endpoints", async () => {
      discoverMock.mockResolvedValueOnce({
        issuer: "https://idp.example.com",
        tokenEndpoint: "https://idp.example.com/discovered/token",
        authorizationEndpoint: "https://idp.example.com/discovered/authorize",
        codeChallengeMethodsSupported: ["S256"],
        raw: {},
      });
      bedrockAgentMock
        .on(CreateGatewayTargetCommand)
        .resolves({ targetId: "target-mcp-disc" });
      secretsMock
        .onAnyCommand()
        .resolves({
          ARN: "arn:aws:secretsmanager:us-east-1:111:secret:mcp-disc",
        });
      ssmMock.onAnyCommand().resolves({});
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "MCP discovery",
            orgId: "org-disc",
            credentials: {
              authMethod: "OAUTH2",
              clientId: "cid",
              clientSecret: "csec",
              grantType: "CLIENT_CREDENTIALS",
              scopes: ["read:tools"],
              discoveryUrl:
                "https://idp.example.com/.well-known/oauth-authorization-server",
            },
            config: { serverUrl: "https://mcp.example.com" },
          },
        },
        identity: { username: "tester" },
      };

      await invoke(event);

      expect(discoverMock).toHaveBeenCalledWith(
        "https://idp.example.com/.well-known/oauth-authorization-server",
        expect.objectContaining({ requireAuthorizationCodePKCE: false }),
      );
      const provisionCall = upsertOauth2Mock.mock.calls[0][0];
      expect(provisionCall.endpoints.tokenEndpoint).toBe(
        "https://idp.example.com/discovered/token",
      );
      expect(provisionCall.endpoints.authorizationEndpoint).toBe(
        "https://idp.example.com/discovered/authorize",
      );
    });

    test("MCP_SERVER + API_KEY provisions API_KEY provider with no callbackUrl", async () => {
      bedrockAgentMock
        .on(CreateGatewayTargetCommand)
        .resolves({ targetId: "target-mcp-api" });
      secretsMock
        .onAnyCommand()
        .resolves({
          ARN: "arn:aws:secretsmanager:us-east-1:111:secret:mcp-api",
        });
      ssmMock.onAnyCommand().resolves({});
      dynamoMock.onAnyCommand().resolves({});

      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "MCP api key",
            orgId: "org-api",
            credentials: { authMethod: "API_KEY", apiKey: "k-1" },
            config: { serverUrl: "https://mcp.example.com" },
          },
        },
        identity: { username: "tester" },
      };

      await invoke(event);

      expect(upsertApiKeyMock).toHaveBeenCalledTimes(1);
      expect(upsertOauth2Mock).not.toHaveBeenCalled();
      const provisionCall = upsertApiKeyMock.mock.calls[0][0];
      expect(provisionCall.apiKey).toBe("k-1");

      const putCalls = dynamoMock.commandCalls(PutCommand);
      const persisted = putCalls[putCalls.length - 1].args[0].input
        .Item as Record<string, unknown>;
      expect(persisted.credentialProviderArn).toMatch(
        /api-key-credential-provider/,
      );
      expect(persisted.credentialProviderType).toBe("API_KEY");
      // API_KEY flow returns no callbackUrl from AgentCore.
      expect(persisted.agentCoreCallbackUrl).toBeUndefined();
      expect(persisted.authorizationUrl).toBeUndefined();
    });

    test("createIntegration MCP_SERVER OAUTH2 with legacy minimal shape is rejected by validateCredentials", async () => {
      const event = {
        info: { fieldName: "createIntegration" },
        arguments: {
          input: {
            integrationType: "MCP_SERVER",
            name: "legacy MCP",
            orgId: "org-legacy",
            // Legacy minimal shape: no grantType, scopes, tokenUrl, or discoveryUrl.
            credentials: {
              authMethod: "OAUTH2",
              clientId: "cid",
              clientSecret: "csec",
            },
            config: { serverUrl: "https://mcp.example.com" },
          },
        },
        identity: { username: "tester" },
      };

      await expect(invoke(event)).rejects.toThrow(/grantType/);
      // None of the AgentCore-side calls should have run.
      expect(upsertOauth2Mock).not.toHaveBeenCalled();
      expect(
        bedrockAgentMock.commandCalls(CreateGatewayTargetCommand).length,
      ).toBe(0);
    });
  });

  describe("P2.A: connectIntegration 3LO authorization redirect", () => {
    test("returns authorizationUrl for AUTHORIZATION_CODE integration in CREATE_PENDING_AUTH", async () => {
      const integrationId = "mcp-3lo-existing";
      const idpAuthUrl = "https://idp.example.com/oauth/authorize?state=xyz";
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-3lo",
            SK: `INTEGRATION#MCP_SERVER#${integrationId}`,
            integrationId,
            integrationType: "MCP_SERVER",
            name: "mcp 3lo existing",
            status: "CONFIGURED",
            orgId: "org-3lo",
            gatewayTargetId: "target-mcp-3lo-existing",
            credentialProviderArn:
              "arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-mcp-3lo-existing-oauth",
            credentialProviderType: "OAUTH2",
            targetStatus: "CREATE_PENDING_AUTH",
            authorizationUrl: idpAuthUrl,
            agentCoreCallbackUrl: "https://agentcore.aws/oauth/callback/test",
            secretArn:
              "arn:aws:secretsmanager:us-east-1:111:secret:mcp-3lo-existing",
            ssmParameterPrefix:
              "/citadel/integrations/org-3lo/mcp_server-mcp-3lo-existing",
            config: { serverUrl: "https://mcp.example.com" },
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "External",
              authMethod: "CONFIGURABLE",
            },
          },
        ],
      });
      dynamoMock.on(PutCommand).resolves({});

      const event = {
        info: { fieldName: "connectIntegration" },
        arguments: { integrationId },
        identity: { username: "tester" },
      };

      const result = await invoke(event);

      expect(result.authorizationUrl).toBe(idpAuthUrl);
      expect(result.status).toBe("CONNECTING");
      // 3LO connect must NOT re-create the target (already created).
      expect(
        bedrockAgentMock.commandCalls(CreateGatewayTargetCommand).length,
      ).toBe(0);
    });
  });

  describe("P2.A: deleteIntegration ordering", () => {
    const deleteOauth2Mock =
      credentialProviderManager.deleteOauth2Provider as jest.Mock;
    const deleteApiKeyMock =
      credentialProviderManager.deleteApiKeyProvider as jest.Mock;

    beforeEach(() => {
      deleteOauth2Mock.mockClear();
      deleteApiKeyMock.mockClear();
      // Restore default success behaviour in case a previous test failed it.
      deleteOauth2Mock.mockImplementation(async () => undefined);
      deleteApiKeyMock.mockImplementation(async () => undefined);
    });

    // P3.A: deleteIntegration is now async via EventBridge — the resolver
    // emits `integration.disconnect.requested` and marks the row
    // `targetStatus: DELETING`. The strict target → provider → secret →
    // SSM → DDB ordering now lives in `gateway-registration-handler` and
    // is exercised in handler tests. The resolver-side contract under
    // test here is reduced to: (a) emit the event with the right detail,
    // (b) flip targetStatus to DELETING, (c) NOT touch Bedrock /
    // Secrets / SSM / cred-provider directly.

    test("emits disconnect event with full detail and marks DDB DELETING", async () => {
      const integrationId = "mcp-del-happy";

      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-del",
            SK: `INTEGRATION#MCP_SERVER#${integrationId}`,
            integrationId,
            integrationType: "MCP_SERVER",
            name: "happy del",
            status: "CONFIGURED",
            orgId: "org-del",
            gatewayTargetId: "target-mcp-del-happy",
            credentialProviderArn:
              "arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-mcp-del-happy-oauth",
            credentialProviderType: "OAUTH2",
            secretArn:
              "arn:aws:secretsmanager:us-east-1:111:secret:mcp-del-happy",
            ssmParameterPrefix:
              "/citadel/integrations/org-del/mcp_server-mcp-del-happy",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "External",
              authMethod: "CONFIGURABLE",
            },
          },
        ],
      });
      dynamoMock.on(UpdateCommand).resolves({});

      const event = {
        info: { fieldName: "deleteIntegration" },
        arguments: { integrationId },
        identity: { username: "tester" },
      };

      const result = await invoke(event);

      expect(result.success).toBe(true);

      // Resolver MUST NOT call any of the underlying delete APIs directly.
      expect(deleteOauth2Mock).not.toHaveBeenCalled();
      expect(deleteApiKeyMock).not.toHaveBeenCalled();
      expect(
        bedrockAgentMock.commandCalls(DeleteGatewayTargetCommand).length,
      ).toBe(0);
      expect(secretsMock.commandCalls(DeleteSecretCommand).length).toBe(0);

      // Resolver MUST emit `integration.disconnect.requested` with all the
      // fields the handler needs to do the strict-ordered teardown.
      const eventCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(eventCalls.length).toBe(1);
      const entry = eventCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe("integration.disconnect.requested");
      const detail = JSON.parse(entry.Detail!);
      expect(detail.integrationId).toBe(integrationId);
      expect(detail.gatewayTargetId).toBe("target-mcp-del-happy");
      expect(detail.credentialProviderArn).toMatch(
        /oauth2-credential-provider/,
      );
      expect(detail.credentialProviderType).toBe("OAUTH2");
      expect(detail.secretArn).toBe(
        "arn:aws:secretsmanager:us-east-1:111:secret:mcp-del-happy",
      );
      expect(detail.ssmParameterPrefix).toBe(
        "/citadel/integrations/org-del/mcp_server-mcp-del-happy",
      );
      expect(detail.keepResources).toBe(false);

      // Resolver flips DDB targetStatus to DELETING via UpdateCommand
      // (no DeleteCommand — that's the handler's job).
      expect(dynamoMock.commandCalls(UpdateCommand).length).toBe(1);
      const updateInput =
        dynamoMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(updateInput.ExpressionAttributeValues![":ts"]).toBe("DELETING");
      expect(dynamoMock.commandCalls(DeleteCommand).length).toBe(0);
    });

    test("EventBridge publish failure surfaces as a thrown error and skips DDB update", async () => {
      // P3.A: the only sync failure surface left in deleteIntegration is
      // EventBridge publication. When PutEventsCommand rejects, the
      // resolver must rethrow so AppSync surfaces the error to the
      // frontend (the user can retry; nothing on the AWS side has been
      // mutated yet).
      const integrationId = "mcp-del-tgt-fail";
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-del",
            SK: `INTEGRATION#MCP_SERVER#${integrationId}`,
            integrationId,
            integrationType: "MCP_SERVER",
            name: "tgt fail",
            status: "CONFIGURED",
            orgId: "org-del",
            gatewayTargetId: "target-mcp-del-tgt-fail",
            credentialProviderArn:
              "arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-mcp-del-tgt-fail-oauth",
            credentialProviderType: "OAUTH2",
            secretArn:
              "arn:aws:secretsmanager:us-east-1:111:secret:mcp-del-tgt-fail",
            ssmParameterPrefix:
              "/citadel/integrations/org-del/mcp_server-mcp-del-tgt-fail",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "External",
              authMethod: "CONFIGURABLE",
            },
          },
        ],
      });
      eventBridgeMock
        .on(PutEventsCommand)
        .rejects(new Error("EventBridge unreachable"));

      const event = {
        info: { fieldName: "deleteIntegration" },
        arguments: { integrationId },
        identity: { username: "tester" },
      };

      await expect(invoke(event)).rejects.toThrow(/EventBridge unreachable/);
      // No teardown performed: the handler is what does cred / secret / DDB
      // cleanup, and it never received the event.
      expect(deleteOauth2Mock).not.toHaveBeenCalled();
      expect(deleteApiKeyMock).not.toHaveBeenCalled();
      expect(
        bedrockAgentMock.commandCalls(DeleteGatewayTargetCommand).length,
      ).toBe(0);
      expect(secretsMock.commandCalls(DeleteSecretCommand).length).toBe(0);
      expect(dynamoMock.commandCalls(UpdateCommand).length).toBe(0);
      expect(dynamoMock.commandCalls(DeleteCommand).length).toBe(0);
    });

    test("legacy integration without credentialProviderArn emits event without provider fields", async () => {
      const integrationId = "mcp-del-legacy";
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: "ORG#org-del",
            SK: `INTEGRATION#MCP_SERVER#${integrationId}`,
            integrationId,
            integrationType: "MCP_SERVER",
            name: "legacy del",
            status: "CONFIGURED",
            orgId: "org-del",
            gatewayTargetId: "target-mcp-del-legacy",
            // no credentialProviderArn — legacy record from before P2.A
            secretArn:
              "arn:aws:secretsmanager:us-east-1:111:secret:mcp-del-legacy",
            ssmParameterPrefix:
              "/citadel/integrations/org-del/mcp_server-mcp-del-legacy",
            config: {},
            metadata: {
              version: "1.0",
              protocol: "MCP",
              provider: "External",
              authMethod: "CONFIGURABLE",
            },
          },
        ],
      });
      dynamoMock.on(UpdateCommand).resolves({});

      const event = {
        info: { fieldName: "deleteIntegration" },
        arguments: { integrationId },
        identity: { username: "tester" },
      };

      const result = await invoke(event);
      expect(result.success).toBe(true);
      // Resolver MUST NOT call provider deprovision (that's the handler's
      // job, and the legacy record signals there's no provider to delete).
      expect(deleteOauth2Mock).not.toHaveBeenCalled();
      expect(deleteApiKeyMock).not.toHaveBeenCalled();

      // Emitted event has no credentialProviderArn — the handler will
      // therefore skip the provider-deprovision step.
      const eventCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(eventCalls.length).toBe(1);
      const detail = JSON.parse(
        eventCalls[0].args[0].input.Entries![0].Detail!,
      );
      expect(detail.credentialProviderArn).toBeUndefined();
      // inferCredentialProviderType returns undefined when there's no ARN.
      expect(detail.credentialProviderType).toBeUndefined();
      expect(detail.gatewayTargetId).toBe("target-mcp-del-legacy");
    });
  });
});
