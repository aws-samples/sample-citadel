/**
 * RED-first tests for finding 8b0e32a7 (CRE item 4): grantAppAccess and
 * revokeAppAccess must enforce an owner-role gate before writing, using the
 * manifest `access` map as the canonical authorization store — the same
 * store the write path (writeManifestMutation) actually updates. The
 * previously-defined checkOperationAccess/checkAppAccess (app-access-control.ts)
 * read a SEPARATE DynamoDB ACCESS# store that the grant/revoke write path
 * never updates (confirmed zero production writers) — wiring the gate to
 * that store instead would authorize against stale/absent data, which is
 * why this test suite gates against the manifest, not app-access-control.ts.
 *
 * Threat model asserted here:
 *   - same-org NON-OWNER (the case org scoping alone would miss) → refused
 *   - cross-org caller → refused
 *   - owner → succeeds
 *   - admin group → bypasses (consistent with getApp/checkAppAccess convention)
 *   - refusal happens BEFORE any manifest write (assert zero updateResource calls)
 *   - split-brain check: grant, then re-authorize through the SAME gate in
 *     the same test, proving the gate reads what the write just updated.
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

// Cognito lookups are used by extractOrgFromEvent's fallback path; these
// tests always supply custom:organization directly on the event so no
// network call is made, but we still mock the client defensively.
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
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  opts: { userId: string; orgId?: string; groups?: string[] },
) {
  const claims: Record<string, unknown> = {
    sub: opts.userId,
  };
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
const APP_ORG = "org-1";

function seedAppWithAccess(
  access: Record<
    string,
    { role: string; grantedAt: string; grantedBy: string }
  > = {},
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
        access: {
          [OWNER_ID]: {
            role: "owner",
            grantedAt: "2024-01-01T00:00:00Z",
            grantedBy: "system",
          },
          ...access,
        },
        routingConfig: null,
      },
    }),
  });
}

describe("registry-agent-record-resolver — grantAppAccess/revokeAppAccess owner gate (finding 8b0e32a7)", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  describe("grantAppAccess", () => {
    test("refuses a same-org NON-OWNER (the case org scoping alone would miss)", async () => {
      seedAppWithAccess({
        "non-owner-user": {
          role: "editor",
          grantedAt: "2024-01-01T00:00:00Z",
          grantedBy: OWNER_ID,
        },
      });

      await expect(
        invokeHandler(
          makeEvent(
            "grantAppAccess",
            { appId: APP_ID, userId: "attacker", role: "owner" },
            { userId: "non-owner-user", orgId: APP_ORG },
          ),
        ),
      ).rejects.toThrow(/Access denied|owner/i);

      expect(getUpdateResourceCallCount()).toBe(0);
    });

    test("refuses a cross-org caller", async () => {
      seedAppWithAccess();

      await expect(
        invokeHandler(
          makeEvent(
            "grantAppAccess",
            { appId: APP_ID, userId: "attacker", role: "owner" },
            { userId: "cross-org-user", orgId: "org-2" },
          ),
        ),
      ).rejects.toThrow(/Access denied|owner/i);

      expect(getUpdateResourceCallCount()).toBe(0);
    });

    test("refuses when caller identity/org cannot be resolved (fail closed)", async () => {
      seedAppWithAccess();

      await expect(
        invokeHandler(
          makeEvent(
            "grantAppAccess",
            { appId: APP_ID, userId: "attacker", role: "owner" },
            { userId: "no-org-claim-user" }, // no custom:organization, Cognito lookup rejects
          ),
        ),
      ).rejects.toThrow(/Access denied|owner/i);

      expect(getUpdateResourceCallCount()).toBe(0);
    });

    test("allows the owner to grant access", async () => {
      seedAppWithAccess();

      const result = await invokeHandler(
        makeEvent(
          "grantAppAccess",
          { appId: APP_ID, userId: "target-user", role: "editor" },
          { userId: OWNER_ID, orgId: APP_ORG },
        ),
      );

      expect(result).toBeDefined();
      expect(getUpdateResourceCallCount()).toBe(1);

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      expect(
        entries.find((e) => e?.DetailType === "app.access.granted"),
      ).toBeDefined();
    });

    test("admin group bypasses the owner check", async () => {
      seedAppWithAccess();

      const result = await invokeHandler(
        makeEvent(
          "grantAppAccess",
          { appId: APP_ID, userId: "target-user", role: "viewer" },
          { userId: "admin-user", orgId: "unrelated-org", groups: ["admin"] },
        ),
      );

      expect(result).toBeDefined();
      expect(getUpdateResourceCallCount()).toBe(1);
    });

    test("split-brain: after granting owner to a second user, the gate immediately recognizes them as owner", async () => {
      seedAppWithAccess();

      // Original owner grants owner role to a second user.
      await invokeHandler(
        makeEvent(
          "grantAppAccess",
          { appId: APP_ID, userId: "second-owner", role: "owner" },
          { userId: OWNER_ID, orgId: APP_ORG },
        ),
      );

      // The newly-granted owner immediately re-authorizes through the SAME
      // gate, in the same test/process, by performing another owner-gated
      // grant — proving the gate reads the store the FIRST grant write just
      // updated (the manifest `access` map), not a stale/separate ACCESS#
      // DynamoDB table the write never touches. If the gate instead read
      // that separate store, second-owner would have no entry there and
      // this call would be refused with "Access denied".
      await expect(
        invokeHandler(
          makeEvent(
            "grantAppAccess",
            { appId: APP_ID, userId: "target-user-2", role: "viewer" },
            { userId: "second-owner", orgId: APP_ORG },
          ),
        ),
      ).resolves.toBeDefined();

      expect(getUpdateResourceCallCount()).toBe(2);
    });
  });

  describe("revokeAppAccess", () => {
    test("refuses a same-org NON-OWNER", async () => {
      seedAppWithAccess({
        "non-owner-user": {
          role: "editor",
          grantedAt: "2024-01-01T00:00:00Z",
          grantedBy: OWNER_ID,
        },
      });

      await expect(
        invokeHandler(
          makeEvent(
            "revokeAppAccess",
            { appId: APP_ID, userId: OWNER_ID },
            { userId: "non-owner-user", orgId: APP_ORG },
          ),
        ),
      ).rejects.toThrow(/Access denied|owner/i);

      expect(getUpdateResourceCallCount()).toBe(0);
    });

    test("refuses a cross-org caller", async () => {
      seedAppWithAccess();

      await expect(
        invokeHandler(
          makeEvent(
            "revokeAppAccess",
            { appId: APP_ID, userId: OWNER_ID },
            { userId: "cross-org-user", orgId: "org-2" },
          ),
        ),
      ).rejects.toThrow(/Access denied|owner/i);

      expect(getUpdateResourceCallCount()).toBe(0);
    });

    test("allows the owner to revoke access", async () => {
      seedAppWithAccess({
        "target-user": {
          role: "editor",
          grantedAt: "2024-01-01T00:00:00Z",
          grantedBy: OWNER_ID,
        },
      });

      const result = await invokeHandler(
        makeEvent(
          "revokeAppAccess",
          { appId: APP_ID, userId: "target-user" },
          { userId: OWNER_ID, orgId: APP_ORG },
        ),
      );

      expect(result).toBeDefined();
      expect(getUpdateResourceCallCount()).toBe(1);
    });
  });
});
