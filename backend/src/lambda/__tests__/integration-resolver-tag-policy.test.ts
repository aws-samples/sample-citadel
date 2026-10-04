/**
 * CIT-042 PR2: tag-policy enforcement for integration.provision
 * (integration-resolver.ts).
 *
 * Integrations are org-scoped with no bound owning agent and no tags on
 * CreateIntegrationInput. Enforcement is skipped with a debug log — the
 * wiring exists for future owning-agent binding. Tests verify the debug
 * log is emitted and that the import of enforceTagPolicy doesn't break
 * the module.
 */
process.env.INTEGRATIONS_TABLE = "int-table-test";
process.env.ENVIRONMENT = "dev";
process.env.EVENT_BUS_NAME = "citadel-agents-test";

// ── mocks: tag-policy-check ────────────────────────────────────────────
const mockEnforceTagPolicy = jest.fn();
jest.mock("../tag-policy-check", () => ({
  __esModule: true,
  enforceTagPolicy: mockEnforceTagPolicy,
}));

// ── mocks: auth ────────────────────────────────────────────────────────
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("org-int-test"),
  isAdminFromEvent: jest.fn().mockReturnValue(false),
  assertRowOrg: jest.fn(),
}));

// ── mocks: connector-registry ──────────────────────────────────────────
jest.mock("../../utils/connector-registry", () => ({
  getConnectorSpec: jest.fn().mockReturnValue({
    provider: "test",
    authentication: { method: "API_KEY", fields: ["apiKey"] },
    configuration: { required: [], ssmParameters: [] },
  }),
  validateCredentials: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
}));

// ── mocks: credential-manager ──────────────────────────────────────────
jest.mock("../../utils/credential-manager", () => ({
  storeCredentials: jest.fn().mockResolvedValue({
    secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:test",
    ssmParameterPrefix: "/citadel/test",
  }),
}));

// ── mocks: connection-tester ───────────────────────────────────────────
jest.mock("../../utils/connection-tester", () => ({
  testConnection: jest.fn().mockResolvedValue({ success: true }),
}));

// ── mocks: lifecycle-validator ─────────────────────────────────────────
jest.mock("../../utils/lifecycle-validator", () => ({
  validateTransition: jest.fn(),
  getStatusAfterSuccessfulTest: jest.fn().mockReturnValue("TESTED"),
  getStatusAfterFailedTest: jest.fn().mockReturnValue("CONNECTION_FAILED"),
  canTest: jest.fn().mockReturnValue(true),
  canConnect: jest.fn().mockReturnValue(true),
  canDisconnect: jest.fn().mockReturnValue(true),
}));

// ── mocks: gateway-target-manager ──────────────────────────────────────
jest.mock("../../utils/gateway-target-manager", () => ({
  provisionCredentialProvider: jest.fn().mockResolvedValue({
    credentialProviderArn: "arn:aws:test:provider",
  }),
  deprovisionCredentialProvider: jest.fn(),
}));

// ── mocks: AWS SDK ─────────────────────────────────────────────────────
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  CreateSecretCommand: jest.fn(),
  GetSecretValueCommand: jest.fn(),
  DeleteSecretCommand: jest.fn(),
}));

jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutParameterCommand: jest.fn(),
  GetParameterCommand: jest.fn(),
}));

jest.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutEventsCommand: jest.fn(),
}));

// ── SUT ────────────────────────────────────────────────────────────────
import { handler } from "../integration-resolver";

// ── helpers ────────────────────────────────────────────────────────────
const TEST_ORG = "org-int-test";
const CALLER_EVENT = {
  identity: { sub: "user-1", username: "user-1" },
  info: { fieldName: "createIntegration" },
  arguments: {
    orgId: TEST_ORG,
    integrationId: "",
    integrationType: "JIRA",
    input: {
      integrationType: "JIRA",
      name: "Test Integration",
      orgId: TEST_ORG,
      credentials: { apiKey: "test-key" },
      config: { baseUrl: "https://test.atlassian.net" },
      integrationId: "",
    },
  },
};

// ── tests ──────────────────────────────────────────────────────────────
describe("integration-resolver tag-policy enforcement", () => {
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    ddbMock.reset();
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    jest.restoreAllMocks();
  });

  test("createIntegration emits debug log about skipping enforcement (no owning agent)", async () => {
    await handler(CALLER_EVENT as never);

    const debugCalls = debugSpy.mock.calls.map((c) => c[0]);
    const tagPolicySkip = debugCalls.find(
      (msg: string) =>
        typeof msg === "string" &&
        msg.includes("skipped_no_owning_agent") &&
        msg.includes("createIntegration"),
    );
    expect(tagPolicySkip).toBeDefined();
  });

  test("enforceTagPolicy is NOT called (no owning agent, no tags on input)", async () => {
    await handler(CALLER_EVENT as never);

    expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
  });

  test("createIntegration still succeeds despite enforcement import", async () => {
    const result = await handler(CALLER_EVENT as never);

    expect(result).toBeDefined();
  });
});
