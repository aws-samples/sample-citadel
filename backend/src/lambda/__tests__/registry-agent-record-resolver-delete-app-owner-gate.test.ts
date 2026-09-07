/**
 * RED-first tests for finding 6400b440: deleteApp had NO authorization
 * check at all — it called revokeFabricatorAuthority() and
 * registry.deleteResource() unguarded, so any authenticated caller could
 * irreversibly delete ANY app in ANY org.
 *
 * Gated with the SAME manifest-access store grantAppAccess/revokeAppAccess
 * already use (assertManifestAccess, requiredRole='owner') — deletion is
 * destructive and irreversible, matching grant/revoke's owner requirement,
 * not the editor-level lifecycle mutations gated by finding 8f8fd119.
 *
 * Threat model asserted:
 *   - cross-org caller → refused, ZERO deleteResource calls, ZERO
 *     revokeFabricatorAuthority calls
 *   - same-org NON-OWNER (editor, no access entry, not createdBy) →
 *     refused, ZERO deleteResource calls, ZERO revokeFabricatorAuthority
 *     calls
 *   - legitimate OWNER → succeeds, exactly one deleteResource call and one
 *     revokeFabricatorAuthority call
 *   - admin group → bypasses (consistent with the other manifest gates)
 */

process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AUTHORITY_UNITS_TABLE = "test-authority-units";
process.env.AWS_REGION = "us-east-1";
delete process.env.MODEL_CATALOG_TABLE;

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);

import {
  seedMockRegistry,
  resetMockRegistry,
  getDeleteResourceCallCount,
} from "./fixtures/registry-service-mock";

jest.mock("../../services/registry-service", () => {
  const { getMockRegistryService } = jest.requireActual(
    "./fixtures/registry-service-mock",
  );
  const actual = jest.requireActual("../../services/registry-service");
  return {
    RegistryService: jest
      .fn()
      .mockImplementation(() => getMockRegistryService()),
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
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

const mockRevokeFabricatorAuthority = jest.fn().mockResolvedValue(undefined);
jest.mock("../registry-agent-authority-lifecycle", () => ({
  grantFabricatorAuthority: jest.fn().mockResolvedValue(undefined),
  revokeFabricatorAuthority: (...args: unknown[]) =>
    mockRevokeFabricatorAuthority(...args),
}));

import { handler } from "../registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  opts: { userId: string; orgId?: string; groups?: string[] },
) {
  const claims: Record<string, unknown> = { sub: opts.userId };
  if (opts.orgId !== undefined) claims["custom:organization"] = opts.orgId;
  if (opts.groups !== undefined) claims["cognito:groups"] = opts.groups;
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: opts.userId, claims },
  } as unknown as HandlerEvent;
}

const APP_ID = "app-1";
const OWNER_ID = "owner-user";
const EDITOR_ID = "editor-user";
const APP_ORG = "org-1";

function seedApp(
  opts: {
    access?: Record<
      string,
      { role: string; grantedAt: string; grantedBy: string }
    >;
    createdBy?: string | null;
  } = {},
) {
  seedMockRegistry("agent", APP_ID, {
    name: "Test App",
    description: "Test",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      appId: APP_ID,
      manifest: {
        orgId: APP_ORG,
        version: 1,
        status: "DRAFT",
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        ...(opts.createdBy !== null && {
          createdBy: opts.createdBy ?? OWNER_ID,
        }),
        access:
          opts.access !== undefined
            ? opts.access
            : {
                [OWNER_ID]: {
                  role: "owner",
                  grantedAt: "2024-01-01T00:00:00Z",
                  grantedBy: "system",
                },
                [EDITOR_ID]: {
                  role: "editor",
                  grantedAt: "2024-01-01T00:00:00Z",
                  grantedBy: OWNER_ID,
                },
              },
        routingConfig: null,
      },
    }),
  });
}

function expectZeroDeleteSideEffects() {
  expect(getDeleteResourceCallCount()).toBe(0);
  expect(mockRevokeFabricatorAuthority).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetMockRegistry();
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({});
  mockRevokeFabricatorAuthority.mockClear();
});

describe("registry-agent-record-resolver — deleteApp owner gate (finding 6400b440)", () => {
  test("refuses a cross-org caller with zero deleteResource and zero revokeFabricatorAuthority calls", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "deleteApp",
          { appId: APP_ID },
          { userId: "attacker", orgId: "org-evil" },
        ),
      ),
    ).rejects.toThrow(/Access denied/i);

    expectZeroDeleteSideEffects();
  });

  test("refuses a same-org NON-OWNER (editor) with zero deleteResource and zero revokeFabricatorAuthority calls", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "deleteApp",
          { appId: APP_ID },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).rejects.toThrow(/Access denied.*owner/i);

    expectZeroDeleteSideEffects();
  });

  test("refuses a same-org caller with no access entry and not createdBy, zero side effects", async () => {
    seedApp({
      access: {
        "viewer-user": {
          role: "viewer",
          grantedAt: "2024-01-01T00:00:00Z",
          grantedBy: OWNER_ID,
        },
      },
    });

    await expect(
      invokeHandler(
        makeEvent(
          "deleteApp",
          { appId: APP_ID },
          { userId: "viewer-user", orgId: APP_ORG },
        ),
      ),
    ).rejects.toThrow(/Access denied.*owner/i);

    expectZeroDeleteSideEffects();
  });

  test("refuses when identity cannot be resolved (fail closed)", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent("deleteApp", { appId: APP_ID }, { userId: "no-org-user" }),
      ),
    ).rejects.toThrow(/Access denied/i);

    expectZeroDeleteSideEffects();
  });

  test("allows the legitimate owner to delete, exactly one delete and one revoke call", async () => {
    seedApp();

    const result = await invokeHandler(
      makeEvent(
        "deleteApp",
        { appId: APP_ID },
        { userId: OWNER_ID, orgId: APP_ORG },
      ),
    );

    expect(result).toMatchObject({ success: true });
    expect(getDeleteResourceCallCount()).toBe(1);
    expect(mockRevokeFabricatorAuthority).toHaveBeenCalledTimes(1);
    expect(mockRevokeFabricatorAuthority).toHaveBeenCalledWith(APP_ID);
  });

  test("allows the implicit creator-owner to delete a legacy app with no access entries", async () => {
    seedApp({ access: {}, createdBy: "legacy-creator" });

    const result = await invokeHandler(
      makeEvent(
        "deleteApp",
        { appId: APP_ID },
        { userId: "legacy-creator", orgId: APP_ORG },
      ),
    );

    expect(result).toMatchObject({ success: true });
    expect(getDeleteResourceCallCount()).toBe(1);
    expect(mockRevokeFabricatorAuthority).toHaveBeenCalledTimes(1);
  });

  test("admin group bypasses the owner gate for deleteApp", async () => {
    seedApp();

    const result = await invokeHandler(
      makeEvent(
        "deleteApp",
        { appId: APP_ID },
        { userId: "admin-1", orgId: "unrelated-org", groups: ["admin"] },
      ),
    );

    expect(result).toMatchObject({ success: true });
    expect(getDeleteResourceCallCount()).toBe(1);
    expect(mockRevokeFabricatorAuthority).toHaveBeenCalledTimes(1);
  });
});
