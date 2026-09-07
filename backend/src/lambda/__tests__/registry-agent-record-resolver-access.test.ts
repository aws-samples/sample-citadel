/**
 * Unit tests for registry-native resolver access/auth surfaces.
 * PR 6a — covers setAppAuthConfig, grantAppAccess, revokeAppAccess, and
 * listAppAccessEntries.
 *
 * Finding 603e732f: listAppAccessEntries previously delegated to
 * `app-access-control.ts#listAppAccessEntries`, a DynamoDB ACCESS#-row
 * reader with ZERO production writers — grant/revoke write ONLY the
 * manifest, so the old listing always returned `[]` even when grants
 * existed. That module was deleted; listing now reads `manifest.access`
 * directly (the SAME store grant/revoke write), gated at 'viewer' via
 * `assertManifestAccess`.
 */

process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AUTHORITY_UNITS_TABLE = "test-authority-units";
process.env.AWS_REGION = "us-east-1";

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);

import {
  seedMockRegistry,
  resetMockRegistry,
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

// Cognito lookups are used by extractOrgFromEvent's fallback path; these
// tests always supply custom:organization directly on the event so no
// network call is made, but we still mock the client defensively (mirrors
// registry-agent-record-resolver-access-owner-gate.test.ts's convention).
// NOTE: utils/appsync#getUserId is intentionally left UNMOCKED (unlike the
// original version of this file) — assertManifestAccess/listAppAccessEntries
// now vary the caller identity per test via makeEvent's `opts.userId`, and
// the real getUserId correctly derives it from `identity.sub`.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
    send: jest
      .fn()
      .mockRejectedValue(new Error("Cognito not reachable in test")),
  })),
  AdminGetUserCommand: jest.fn(),
}));

// Cognito lookups are used by extractOrgFromEvent's fallback path; these
// tests always supply custom:organization directly on the event so no
// network call is made, but we still mock the client defensively (mirrors
// registry-agent-record-resolver-access-owner-gate.test.ts's convention).
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
    send: jest
      .fn()
      .mockRejectedValue(new Error("Cognito not reachable in test")),
  })),
  AdminGetUserCommand: jest.fn(),
}));

import { handler } from "../registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  opts: { userId?: string; orgId?: string; groups?: string[] } = {},
) {
  const userId = opts.userId ?? "user-123";
  // Default orgId to "org-1" (seedApp's org) so calls that omit `opts`
  // entirely keep the pre-existing success-path behaviour; callers that
  // want to test a MISSING org claim pass `orgId: undefined` explicitly
  // alongside a non-default userId.
  const orgId = "orgId" in opts ? opts.orgId : "org-1";
  const claims: Record<string, unknown> = { sub: userId };
  if (orgId !== undefined) claims["custom:organization"] = orgId;
  if (opts.groups !== undefined) claims["cognito:groups"] = opts.groups;
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: userId, claims },
  } as unknown as HandlerEvent;
}

function seedApp(): void {
  seedMockRegistry("agent", "app-1", {
    name: "Test App",
    description: "Test",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      appId: "app-1",
      manifest: {
        orgId: "org-1",
        version: 1,
        status: "DRAFT",
        createdBy: "user-123",
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        // user-123 is the caller used by every test in this file (see
        // makeEvent) and is seeded here as an explicit owner so the
        // grantAppAccess/revokeAppAccess owner gate (finding 8b0e32a7)
        // does not refuse these pre-existing success-path tests. The
        // owner-gate's own refusal paths are covered separately in
        // registry-agent-record-resolver-access-owner-gate.test.ts.
        access: {
          "user-123": {
            role: "owner",
            grantedAt: "2024-01-01T00:00:00Z",
            grantedBy: "system",
          },
        },
        routingConfig: null,
      },
    }),
  });
}

describe("registry-agent-record-resolver — access / auth surfaces", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  // ─── setAppAuthConfig ────────────────────────────────────────

  describe("setAppAuthConfig", () => {
    test("succeeds and emits app.auth.config.set event", async () => {
      seedApp();

      await invokeHandler(
        makeEvent("setAppAuthConfig", {
          appId: "app-1",
          authConfig: JSON.stringify({
            provider: "cognito",
            userPoolId: "up-1",
          }),
        }),
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const set = entries.find((e) => e?.DetailType === "app.auth.config.set");
      expect(set).toBeDefined();
      expect(set!.Source).toBe("citadel.apps");
    });

    test("throws when app not found", async () => {
      await expect(
        invokeHandler(
          makeEvent("setAppAuthConfig", {
            appId: "nonexistent",
            authConfig: JSON.stringify({ provider: "cognito" }),
          }),
        ),
      ).rejects.toThrow("App not found");
    });
  });

  // ─── grantAppAccess ───────────────────────────────────────────

  describe("grantAppAccess", () => {
    test("succeeds and emits app.access.granted event with grantedBy user id", async () => {
      seedApp();

      await invokeHandler(
        makeEvent("grantAppAccess", {
          appId: "app-1",
          userId: "target-user",
          role: "editor",
        }),
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const granted = entries.find(
        (e) => e?.DetailType === "app.access.granted",
      );
      expect(granted).toBeDefined();

      const detail = JSON.parse(granted!.Detail!);
      expect(detail.appId).toBe("app-1");
      expect(detail.userId).toBe("target-user");
      expect(detail.role).toBe("editor");
      expect(detail.grantedBy).toBe("user-123");
    });

    test("throws when app not found", async () => {
      await expect(
        invokeHandler(
          makeEvent("grantAppAccess", {
            appId: "nonexistent",
            userId: "target-user",
            role: "editor",
          }),
        ),
      ).rejects.toThrow("App not found");
    });
  });

  // ─── revokeAppAccess ──────────────────────────────────────────

  describe("revokeAppAccess", () => {
    test("succeeds and emits app.access.revoked event with revokedBy user id", async () => {
      seedApp();

      await invokeHandler(
        makeEvent("revokeAppAccess", {
          appId: "app-1",
          userId: "target-user",
        }),
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const revoked = entries.find(
        (e) => e?.DetailType === "app.access.revoked",
      );
      expect(revoked).toBeDefined();

      const detail = JSON.parse(revoked!.Detail!);
      expect(detail.appId).toBe("app-1");
      expect(detail.userId).toBe("target-user");
      expect(detail.revokedBy).toBe("user-123");
    });

    test("throws when app not found", async () => {
      await expect(
        invokeHandler(
          makeEvent("revokeAppAccess", {
            appId: "nonexistent",
            userId: "target-user",
          }),
        ),
      ).rejects.toThrow("App not found");
    });
  });

  // ─── listAppAccessEntries ────────────────────────────────────

  describe("listAppAccessEntries", () => {
    test("returns entries that exist in the manifest (previously returned empty — finding 603e732f)", async () => {
      seedMockRegistry("agent", "app-1", {
        name: "Test App",
        description: "Test",
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({
          appId: "app-1",
          manifest: {
            orgId: "org-1",
            version: 1,
            status: "DRAFT",
            createdBy: "user-123",
            workflowIds: [],
            agentBindings: [],
            permissions: [],
            configSchema: null,
            configValues: null,
            authConfig: null,
            access: {
              "user-123": {
                role: "owner",
                grantedAt: "2024-01-01T00:00:00Z",
                grantedBy: "system",
              },
              "target-user": {
                role: "editor",
                grantedAt: "2024-02-01T00:00:00Z",
                grantedBy: "user-123",
              },
            },
            routingConfig: null,
          },
        }),
      });

      const result = await invokeHandler(
        makeEvent("listAppAccessEntries", { appId: "app-1" }),
      );

      expect(result).toEqual(
        expect.arrayContaining([
          {
            userId: "user-123",
            role: "owner",
            grantedBy: "system",
            grantedAt: "2024-01-01T00:00:00Z",
          },
          {
            userId: "target-user",
            role: "editor",
            grantedBy: "user-123",
            grantedAt: "2024-02-01T00:00:00Z",
          },
        ]),
      );
      expect((result as unknown[]).length).toBe(2);
    });

    test("surfaces the implicit creator-owner when the manifest has no explicit owner entry yet", async () => {
      seedMockRegistry("agent", "app-legacy", {
        name: "Legacy App",
        description: "Test",
        status: "DRAFT",
        createdAt: new Date("2023-06-01T00:00:00Z"),
        customDescriptorContent: JSON.stringify({
          appId: "app-legacy",
          manifest: {
            orgId: "org-1",
            version: 1,
            status: "DRAFT",
            createdBy: "user-123",
            workflowIds: [],
            agentBindings: [],
            permissions: [],
            configSchema: null,
            configValues: null,
            authConfig: null,
            access: {}, // pre-owner-gate-fix app: no explicit owner entry
            routingConfig: null,
          },
        }),
      });

      const result = await invokeHandler(
        makeEvent("listAppAccessEntries", { appId: "app-legacy" }),
      );

      expect(result).toEqual([
        {
          userId: "user-123",
          role: "owner",
          grantedBy: "system",
          grantedAt: "2023-06-01T00:00:00.000Z",
        },
      ]);
    });

    test("returns empty array when the app exists but has no access entries and no createdBy", async () => {
      seedMockRegistry("agent", "app-empty", {
        name: "Empty App",
        description: "Test",
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({
          appId: "app-empty",
          manifest: {
            orgId: "org-1",
            version: 1,
            status: "DRAFT",
            workflowIds: [],
            agentBindings: [],
            permissions: [],
            configSchema: null,
            configValues: null,
            authConfig: null,
            access: {},
            routingConfig: null,
          },
        }),
      });

      // user-123 is not in the access map and there's no createdBy fallback,
      // so authorize as admin to reach the (empty) listing itself.
      const result = await invokeHandler(
        makeEvent(
          "listAppAccessEntries",
          { appId: "app-empty" },
          { userId: "admin-user", orgId: "org-1", groups: ["admin"] },
        ),
      );

      expect(result).toEqual([]);
    });

    test("throws when app not found", async () => {
      await expect(
        invokeHandler(
          makeEvent("listAppAccessEntries", { appId: "nonexistent" }),
        ),
      ).rejects.toThrow("App not found");
    });

    // ─── authorization (viewer-and-above; finding 603e732f) ───────

    test("allows a viewer-role caller to list access entries", async () => {
      seedMockRegistry("agent", "app-1", {
        name: "Test App",
        description: "Test",
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({
          appId: "app-1",
          manifest: {
            orgId: "org-1",
            version: 1,
            status: "DRAFT",
            createdBy: "owner-user",
            workflowIds: [],
            agentBindings: [],
            permissions: [],
            configSchema: null,
            configValues: null,
            authConfig: null,
            access: {
              "owner-user": {
                role: "owner",
                grantedAt: "2024-01-01T00:00:00Z",
                grantedBy: "system",
              },
              "viewer-user": {
                role: "viewer",
                grantedAt: "2024-01-02T00:00:00Z",
                grantedBy: "owner-user",
              },
            },
            routingConfig: null,
          },
        }),
      });

      await expect(
        invokeHandler(
          makeEvent(
            "listAppAccessEntries",
            { appId: "app-1" },
            { userId: "viewer-user", orgId: "org-1" },
          ),
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: "viewer-user" }),
        ]),
      );
    });

    test("refuses a cross-org caller (fails closed, consistent with the owner gate)", async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent(
            "listAppAccessEntries",
            { appId: "app-1" },
            { userId: "cross-org-user", orgId: "org-2" },
          ),
        ),
      ).rejects.toThrow(/Access denied/i);
    });

    test("refuses a same-org caller with no access entry and no implicit-owner fallback", async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent(
            "listAppAccessEntries",
            { appId: "app-1" },
            { userId: "stranger-user", orgId: "org-1" },
          ),
        ),
      ).rejects.toThrow(/Access denied/i);
    });

    test("admin group bypasses the viewer check", async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent(
            "listAppAccessEntries",
            { appId: "app-1" },
            { userId: "admin-user", orgId: "unrelated-org", groups: ["admin"] },
          ),
        ),
      ).resolves.toBeDefined();
    });
  });
});
