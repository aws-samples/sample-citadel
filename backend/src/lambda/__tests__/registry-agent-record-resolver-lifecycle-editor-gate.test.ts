/**
 * RED-first tests for finding 8f8fd119: the editor-reserved lifecycle
 * mutations on registry-agent-record-resolver.ts had NO role check and NO
 * org check at all — any authenticated caller could mint a plaintext API
 * key for any app in any org, reassign an app's orgId (tenant takeover),
 * inject IAM permissions into an app's provisioned role (addAppComponent),
 * or tamper config/auth/bindings for a victim's app.
 *
 * This suite gates every op in scope via the SAME manifest-access store
 * grantAppAccess/revokeAppAccess already use (finding 8b0e32a7's
 * assertManifestOwnerAccess, generalized here to assertManifestAccess with
 * requiredRole='editor') — never assertRowOrg, which is an org-equality
 * check on a plain DynamoDB row with no role hierarchy and does not fit
 * Registry manifest apps.
 *
 * Threat model asserted per gated op:
 *   - cross-org caller (different org entirely) → refused, ZERO side effects
 *   - same-org NON-EDITOR (no access entry, no createdBy match) → refused,
 *     ZERO side effects
 *   - legitimate same-org EDITOR → succeeds
 *   - legitimate OWNER (implicit creator-owner fallback) → succeeds
 *   - grantAppAccess/revokeAppAccess still require OWNER — an EDITOR must be
 *     refused (regression proving the generalization did not weaken
 *     grant/revoke)
 *   - updateApp cannot change orgId, even for a legitimate editor
 *
 * "Zero side effects" is asserted via the mock registry's updateResource
 * call counter (getUpdateResourceCallCount) plus the EventBridge mock's
 * PutEventsCommand call count — covers "zero manifest writes" and "zero
 * EventBridge publishes" from the acceptance criteria. createAppApiKey/
 * rotateAppApiKey additionally assert the app-api-key-management module
 * mocks were never invoked ("zero key generation"). None of the gated ops
 * touch IAM directly in this resolver (addAppComponent stages permission
 * entries into the manifest; the actual IAM role bake-in happens later at
 * publish time in app-publish-handler.ts) — "zero IAM changes" is therefore
 * equivalent to "zero manifest writes" for addAppComponent here.
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
  getUpdateResourceCallCount,
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

// Cognito lookups are used by extractOrgFromEvent's fallback path; every
// test here supplies custom:organization directly on the event so no
// network call is made, but mock defensively as the owner-gate suite does.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
    send: jest
      .fn()
      .mockRejectedValue(new Error("Cognito not reachable in test")),
  })),
  AdminGetUserCommand: jest.fn(),
}));

const mockCreateKey = jest.fn();
const mockRevokeKey = jest.fn();
const mockRotateKey = jest.fn();
jest.mock("../app-api-key-management", () => ({
  createAppApiKey: (...args: unknown[]) => mockCreateKey(...args),
  revokeAppApiKey: (...args: unknown[]) => mockRevokeKey(...args),
  rotateAppApiKey: (...args: unknown[]) => mockRotateKey(...args),
  listAppApiKeys: jest.fn(),
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
    agentBindings?: unknown[];
    configSchema?: unknown;
    configValues?: unknown;
    version?: number;
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
        version: opts.version ?? 1,
        status: "DRAFT",
        workflowIds: [],
        agentBindings: opts.agentBindings ?? [],
        permissions: [],
        configSchema: opts.configSchema ?? null,
        configValues: opts.configValues ?? null,
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

function expectZeroSideEffects() {
  expect(getUpdateResourceCallCount()).toBe(0);
  expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  expect(mockCreateKey).not.toHaveBeenCalled();
  expect(mockRevokeKey).not.toHaveBeenCalled();
  expect(mockRotateKey).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetMockRegistry();
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({});
  mockCreateKey.mockReset();
  mockRevokeKey.mockReset();
  mockRotateKey.mockReset();
});

// ---------------------------------------------------------------------------
// Table-driven cross-org / same-org-non-editor refusal for every gated op.
// ---------------------------------------------------------------------------
type OpCase = {
  name: string;
  fieldName: string;
  args: Record<string, unknown>;
};

const GATED_OPS: OpCase[] = [
  {
    name: "updateApp",
    fieldName: "updateApp",
    args: { input: { appId: APP_ID, version: 1, name: "Attacker Renamed" } },
  },
  {
    name: "addAppComponent",
    fieldName: "addAppComponent",
    args: {
      appId: APP_ID,
      component: {
        type: "permission",
        data: JSON.stringify({
          permissionId: "perm-evil",
          actions: ["iam:*"],
          resources: ["*"],
        }),
      },
    },
  },
  {
    name: "removeAppComponent",
    fieldName: "removeAppComponent",
    args: { appId: APP_ID, componentType: "agent", componentId: "agent-1" },
  },
  {
    name: "updateAgentBinding",
    fieldName: "updateAgentBinding",
    args: {
      input: { appId: APP_ID, agentId: "agent-1", systemPromptAddition: "x" },
    },
  },
  {
    name: "setAppConfigSchema",
    fieldName: "setAppConfigSchema",
    args: {
      appId: APP_ID,
      schema: JSON.stringify({ type: "object" }),
      version: 1,
    },
  },
  {
    name: "setAppConfigValues",
    fieldName: "setAppConfigValues",
    args: { appId: APP_ID, values: JSON.stringify({}), version: 1 },
  },
  {
    name: "setAppAuthConfig",
    fieldName: "setAppAuthConfig",
    args: { appId: APP_ID, authConfig: JSON.stringify({ type: "none" }) },
  },
  {
    name: "createAppApiKey",
    fieldName: "createAppApiKey",
    args: { appId: APP_ID, name: "attacker-key" },
  },
  {
    name: "revokeAppApiKey",
    fieldName: "revokeAppApiKey",
    args: { appId: APP_ID, keyId: "victim-key" },
  },
  {
    name: "rotateAppApiKey",
    fieldName: "rotateAppApiKey",
    args: { appId: APP_ID, keyId: "victim-key" },
  },
];

describe("registry-agent-record-resolver — lifecycle editor gate (finding 8f8fd119)", () => {
  for (const op of GATED_OPS) {
    describe(op.name, () => {
      test("refuses a cross-org caller with zero side effects", async () => {
        seedApp({ agentBindings: [{ agentId: "agent-1", status: "DESIGN" }] });

        await expect(
          invokeHandler(
            makeEvent(op.fieldName, op.args, {
              userId: "attacker",
              orgId: "org-evil",
            }),
          ),
        ).rejects.toThrow(/Access denied/i);

        expectZeroSideEffects();
      });

      test("refuses a same-org NON-EDITOR (no access entry, not createdBy) with zero side effects", async () => {
        seedApp({
          agentBindings: [{ agentId: "agent-1", status: "DESIGN" }],
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
            makeEvent(op.fieldName, op.args, {
              userId: "viewer-user",
              orgId: APP_ORG,
            }),
          ),
        ).rejects.toThrow(/Access denied/i);

        expectZeroSideEffects();
      });

      test("refuses when identity cannot be resolved (fail closed)", async () => {
        seedApp({ agentBindings: [{ agentId: "agent-1", status: "DESIGN" }] });

        await expect(
          invokeHandler(
            makeEvent(op.fieldName, op.args, { userId: "no-org-user" }),
          ),
        ).rejects.toThrow(/Access denied/i);

        expectZeroSideEffects();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Legitimate-caller paths: editor and owner both succeed.
// ---------------------------------------------------------------------------
describe("registry-agent-record-resolver — lifecycle editor gate: legitimate paths succeed", () => {
  test("updateApp succeeds for a same-org editor", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, name: "Editor Renamed" } },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).resolves.toBeDefined();
    expect(getUpdateResourceCallCount()).toBe(1);
  });

  test("updateApp succeeds for the owner", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, name: "Owner Renamed" } },
          { userId: OWNER_ID, orgId: APP_ORG },
        ),
      ),
    ).resolves.toBeDefined();
    expect(getUpdateResourceCallCount()).toBe(1);
  });

  test("updateApp succeeds for the implicit creator-owner on a legacy app with no access entries", async () => {
    seedApp({ access: {}, createdBy: "legacy-creator" });

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, name: "Legacy Renamed" } },
          { userId: "legacy-creator", orgId: APP_ORG },
        ),
      ),
    ).resolves.toBeDefined();
    expect(getUpdateResourceCallCount()).toBe(1);
  });

  test("createAppApiKey succeeds for a same-org editor", async () => {
    seedApp();
    mockCreateKey.mockResolvedValueOnce({
      keyId: "k1",
      name: "Editor Key",
      prefix: "aaaa1111",
      status: "ACTIVE",
      createdAt: "2025-01-01T00:00:00Z",
      plaintext: "plaintext-secret",
    });

    const result = await invokeHandler(
      makeEvent(
        "createAppApiKey",
        { appId: APP_ID, name: "Editor Key" },
        { userId: EDITOR_ID, orgId: APP_ORG },
      ),
    );

    expect(result).toMatchObject({ apiKey: "plaintext-secret" });
    expect(mockCreateKey).toHaveBeenCalledTimes(1);
  });

  test("rotateAppApiKey succeeds for the owner", async () => {
    seedApp();
    mockRotateKey.mockResolvedValueOnce({
      newKey: {
        keyId: "k2",
        name: "Rotated",
        prefix: "bbbb2222",
        status: "ACTIVE",
        createdAt: "2025-01-01T00:00:00Z",
        plaintext: "new-plaintext",
      },
      revokedKeyId: "k1",
    });

    const result = await invokeHandler(
      makeEvent(
        "rotateAppApiKey",
        { appId: APP_ID, keyId: "k1" },
        { userId: OWNER_ID, orgId: APP_ORG },
      ),
    );

    expect(result).toMatchObject({ apiKey: "new-plaintext" });
    expect(mockRotateKey).toHaveBeenCalledTimes(1);
  });

  test("addAppComponent succeeds for a same-org editor and stages the permission into the manifest", async () => {
    seedApp();

    const result = await invokeHandler(
      makeEvent(
        "addAppComponent",
        {
          appId: APP_ID,
          component: {
            type: "permission",
            data: JSON.stringify({
              permissionId: "perm-1",
              actions: ["s3:GetObject"],
              resources: ["arn:aws:s3:::bucket/*"],
            }),
          },
        },
        { userId: EDITOR_ID, orgId: APP_ORG },
      ),
    );

    expect(result).toBeDefined();
    expect(getUpdateResourceCallCount()).toBe(1);
  });

  test("admin group bypasses the editor gate for updateApp", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, name: "Admin Renamed" } },
          { userId: "admin-1", orgId: "unrelated-org", groups: ["admin"] },
        ),
      ),
    ).resolves.toBeDefined();
    expect(getUpdateResourceCallCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: grantAppAccess/revokeAppAccess must still require OWNER —
// the generalization to assertManifestAccess(requiredRole) must not have
// weakened these two call sites, which pin requiredRole='owner'.
// ---------------------------------------------------------------------------
describe("registry-agent-record-resolver — grantAppAccess/revokeAppAccess still require OWNER", () => {
  test("an EDITOR cannot grant access (regression proving generalization did not downgrade grant to editor-level)", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "grantAppAccess",
          { appId: APP_ID, userId: "new-target", role: "viewer" },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).rejects.toThrow(/Access denied.*owner/i);

    expect(getUpdateResourceCallCount()).toBe(0);
  });

  test("an EDITOR cannot revoke access", async () => {
    seedApp({
      access: {
        "target-user": {
          role: "viewer",
          grantedAt: "2024-01-01T00:00:00Z",
          grantedBy: OWNER_ID,
        },
      },
    });

    await expect(
      invokeHandler(
        makeEvent(
          "revokeAppAccess",
          { appId: APP_ID, userId: "target-user" },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).rejects.toThrow(/Access denied.*owner/i);

    expect(getUpdateResourceCallCount()).toBe(0);
  });

  test("the OWNER can still grant access (unchanged behaviour)", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "grantAppAccess",
          { appId: APP_ID, userId: "new-target", role: "editor" },
          { userId: OWNER_ID, orgId: APP_ORG },
        ),
      ),
    ).resolves.toBeDefined();

    expect(getUpdateResourceCallCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// updateApp: orgId is immutable, even for a legitimate editor/owner.
// ---------------------------------------------------------------------------
describe("registry-agent-record-resolver — updateApp orgId immutability", () => {
  test("rejects an orgId change from a legitimate same-org editor, with zero writes", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, orgId: "org-evil" } },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).rejects.toThrow(/orgId cannot be changed/i);

    expect(getUpdateResourceCallCount()).toBe(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test("rejects an orgId change from the owner too — no legitimate lifecycle path may reassign orgId", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, orgId: "org-evil" } },
          { userId: OWNER_ID, orgId: APP_ORG },
        ),
      ),
    ).rejects.toThrow(/orgId cannot be changed/i);

    expect(getUpdateResourceCallCount()).toBe(0);
  });

  test("allows updateApp when orgId is supplied but unchanged (idempotent no-op on that field)", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          {
            input: {
              appId: APP_ID,
              version: 1,
              orgId: APP_ORG,
              name: "Same Org Rename",
            },
          },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).resolves.toBeDefined();

    expect(getUpdateResourceCallCount()).toBe(1);
  });

  test("allows updateApp when orgId is omitted entirely", async () => {
    seedApp();

    await expect(
      invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: APP_ID, version: 1, name: "No OrgId Field" } },
          { userId: EDITOR_ID, orgId: APP_ORG },
        ),
      ),
    ).resolves.toBeDefined();

    expect(getUpdateResourceCallCount()).toBe(1);
  });
});
