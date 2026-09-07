/**
 * RED-first tests for finding c35137bb: bindWorkflowToApp and
 * unbindWorkflowFromApp mutate manifest.workflowIds with NO
 * assertManifestAccess call, so any authenticated user could change which
 * workflows another organization's app executes.
 *
 * These two ops were the last entries in the dispatch enumeration guard's
 * EXEMPT_OPS, explicitly flagged as a "PRE-EXISTING GAP, not yet gated"
 * (see registry-agent-record-resolver-dispatch-gate-enumeration.test.ts).
 * This suite gates both at 'editor' (they alter app behaviour, not destroy
 * the app — same tier as updateApp/addAppComponent/updateAgentBinding from
 * finding 8f8fd119), using the SAME assertManifestAccess helper and the
 * SAME table-driven threat model as
 * registry-agent-record-resolver-lifecycle-editor-gate.test.ts:
 *
 *   - cross-org caller (different org entirely) → refused, ZERO manifest
 *     writes, ZERO EventBridge publishes
 *   - same-org NON-EDITOR (no access entry, not createdBy) → refused, ZERO
 *     side effects
 *   - unresolvable identity → refused, fail closed
 *   - legitimate same-org EDITOR → succeeds
 *   - legitimate OWNER (implicit creator-owner fallback for legacy apps
 *     with no access entries) → succeeds
 *   - admin group bypasses the gate
 */

process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AWS_REGION = "us-east-1";
delete process.env.AUTHORITY_UNITS_TABLE;

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
// network call is made, but mock defensively as the other gate suites do.
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({
    send: jest
      .fn()
      .mockRejectedValue(new Error("Cognito not reachable in test")),
  })),
  AdminGetUserCommand: jest.fn(),
}));

jest.mock("../../utils/appsync-publish", () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
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
    workflowIds?: string[];
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
        workflowIds: opts.workflowIds ?? [],
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

function expectZeroSideEffects() {
  expect(getUpdateResourceCallCount()).toBe(0);
  expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
}

beforeEach(() => {
  resetMockRegistry();
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({});
});

type OpCase = { name: string; fieldName: string };

const GATED_OPS: OpCase[] = [
  { name: "bindWorkflowToApp", fieldName: "bindWorkflowToApp" },
  { name: "unbindWorkflowFromApp", fieldName: "unbindWorkflowFromApp" },
];

describe("registry-agent-record-resolver — workflow binding editor gate (finding c35137bb)", () => {
  for (const op of GATED_OPS) {
    describe(op.name, () => {
      test("refuses a cross-org caller with zero manifest writes", async () => {
        seedApp({ workflowIds: ["wf-1"] });

        await expect(
          invokeHandler(
            makeEvent(
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: "attacker", orgId: "org-evil" },
            ),
          ),
        ).rejects.toThrow(/Access denied/i);

        expectZeroSideEffects();
      });

      test("refuses a same-org NON-EDITOR (no access entry, not createdBy) with zero manifest writes", async () => {
        seedApp({
          workflowIds: ["wf-1"],
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
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: "viewer-user", orgId: APP_ORG },
            ),
          ),
        ).rejects.toThrow(/Access denied/i);

        expectZeroSideEffects();
      });

      test("refuses when identity cannot be resolved (fail closed)", async () => {
        seedApp({ workflowIds: ["wf-1"] });

        await expect(
          invokeHandler(
            makeEvent(
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: "no-org-user" },
            ),
          ),
        ).rejects.toThrow(/Access denied/i);

        expectZeroSideEffects();
      });

      test("succeeds for a same-org editor", async () => {
        seedApp({
          workflowIds: op.fieldName === "bindWorkflowToApp" ? [] : ["wf-1"],
        });

        await expect(
          invokeHandler(
            makeEvent(
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: EDITOR_ID, orgId: APP_ORG },
            ),
          ),
        ).resolves.toBeDefined();

        expect(getUpdateResourceCallCount()).toBe(1);
      });

      test("succeeds for the owner", async () => {
        seedApp({
          workflowIds: op.fieldName === "bindWorkflowToApp" ? [] : ["wf-1"],
        });

        await expect(
          invokeHandler(
            makeEvent(
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: OWNER_ID, orgId: APP_ORG },
            ),
          ),
        ).resolves.toBeDefined();

        expect(getUpdateResourceCallCount()).toBe(1);
      });

      test("succeeds for the implicit creator-owner on a legacy app with no access entries", async () => {
        seedApp({
          workflowIds: op.fieldName === "bindWorkflowToApp" ? [] : ["wf-1"],
          access: {},
          createdBy: "legacy-creator",
        });

        await expect(
          invokeHandler(
            makeEvent(
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: "legacy-creator", orgId: APP_ORG },
            ),
          ),
        ).resolves.toBeDefined();

        expect(getUpdateResourceCallCount()).toBe(1);
      });

      test("admin group bypasses the gate", async () => {
        seedApp({
          workflowIds: op.fieldName === "bindWorkflowToApp" ? [] : ["wf-1"],
        });

        await expect(
          invokeHandler(
            makeEvent(
              op.fieldName,
              { appId: APP_ID, workflowId: "wf-1" },
              { userId: "admin-1", orgId: "unrelated-org", groups: ["admin"] },
            ),
          ),
        ).resolves.toBeDefined();

        expect(getUpdateResourceCallCount()).toBe(1);
      });
    });
  }

  test("bindWorkflowToApp idempotent early return does NOT bypass the gate — a refused caller still gets zero writes even when the workflow is already bound", async () => {
    seedApp({ workflowIds: ["wf-1"] });

    await expect(
      invokeHandler(
        makeEvent(
          "bindWorkflowToApp",
          { appId: APP_ID, workflowId: "wf-1" },
          { userId: "attacker", orgId: "org-evil" },
        ),
      ),
    ).rejects.toThrow(/Access denied/i);

    expectZeroSideEffects();
  });
});
