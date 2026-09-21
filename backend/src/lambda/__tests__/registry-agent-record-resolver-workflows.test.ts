/**
 * Unit tests for bindWorkflowToApp / unbindWorkflowFromApp on the
 * registry-native resolver. PR 6a replacement for the bind/unbind test
 * bodies previously in `agent-app-shim-resolver.test.ts`.
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
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

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

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-123"),
}));

jest.mock("../../utils/appsync-publish", () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from "../registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
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

function seedApp(opts: { manifest?: Record<string, unknown> } = {}): void {
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
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        // Finding c35137bb: bindWorkflowToApp/unbindWorkflowFromApp are now
        // gated at 'editor' via assertManifestAccess. This suite's caller
        // (user-123, org-1, from makeEvent above) is seeded here as the
        // app's createdBy so the implicit-creator-owner fallback grants it
        // access — matching the pattern already used for the datastore and
        // integration remediations. These tests exercise the bind/unbind
        // BEHAVIOUR (idempotency, event emission, not-found handling); the
        // gate's refusal paths have their own dedicated coverage in
        // registry-agent-record-resolver-workflow-binding-editor-gate.test.ts.
        createdBy: "user-123",
        routingConfig: null,
        ...(opts.manifest ?? {}),
      },
    }),
  });
}

describe("registry-agent-record-resolver — workflow binding", () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ddbMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AWS_REGION;
    delete process.env.REGISTRY_ID;
  });

  // ─── bindWorkflowToApp ────────────────────────────────────────

  describe("bindWorkflowToApp", () => {
    test("appends workflowId to app workflowIds", async () => {
      seedApp({ manifest: { workflowIds: ["wf-existing"] } });

      await expect(
        invokeHandler(
          makeEvent("bindWorkflowToApp", {
            appId: "app-1",
            workflowId: "wf-new",
          }),
        ),
      ).resolves.toBeDefined();

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const boundEvents = allEntries.filter(
        (e) => e?.DetailType === "app.workflow.bound",
      );
      expect(boundEvents.length).toBe(1);
    });

    // Finding 4d69104a: bind must update BOTH the registry manifest AND
    // the AppsTable #META mirror's workflowIds — the Agent Apps list reads
    // the mirror (via OrgIndex), and the detail view shadows the manifest
    // whenever the mirror's workflowIds list is non-empty.
    test("mirrors the updated workflowIds onto the AppsTable #META row", async () => {
      seedApp({ manifest: { workflowIds: ["wf-existing"] } });

      await invokeHandler(
        makeEvent("bindWorkflowToApp", {
          appId: "app-1",
          workflowId: "wf-new",
        }),
      );

      const metaUpdate = ddbMock
        .commandCalls(UpdateCommand)
        .find(
          (c) =>
            c.args[0].input.TableName === "citadel-apps-test" &&
            (c.args[0].input.Key as Record<string, unknown> | undefined)
              ?.appId === "app-1",
        );
      expect(metaUpdate).toBeDefined();
      const values = metaUpdate!.args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(values[":v_workflowIds"]).toEqual(["wf-existing", "wf-new"]);
      expect(typeof values[":v_updatedAt"]).toBe("string");
    });

    test("is idempotent when workflow already bound to same app", async () => {
      seedApp({ manifest: { workflowIds: ["wf-1"] } });

      await expect(
        invokeHandler(
          makeEvent("bindWorkflowToApp", {
            appId: "app-1",
            workflowId: "wf-1",
          }),
        ),
      ).resolves.toBeDefined();

      expect(ebMock.commandCalls(PutEventsCommand).length).toBe(0);
      // Idempotent short-circuit returns before any write — no mirror
      // update should be issued either.
      expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
    });

    test("throws when app not found", async () => {
      await expect(
        invokeHandler(
          makeEvent("bindWorkflowToApp", {
            appId: "nonexistent",
            workflowId: "wf-1",
          }),
        ),
      ).rejects.toThrow("App not found");
    });

    // Eventually-consistent contract (matches createApp/updateApp/deleteApp
    // in registry-agent-record-resolver-meta-writes.test.ts): a mirror
    // write failure must not fail the mutation itself.
    test("succeeds even if the AppsTable #META mirror write fails", async () => {
      seedApp({ manifest: { workflowIds: [] } });
      ddbMock.on(UpdateCommand).rejects(new Error("AppsTable down"));

      await expect(
        invokeHandler(
          makeEvent("bindWorkflowToApp", {
            appId: "app-1",
            workflowId: "wf-1",
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  // ─── unbindWorkflowFromApp ────────────────────────────────────

  describe("unbindWorkflowFromApp", () => {
    test("removes workflowId from app workflowIds", async () => {
      seedApp({ manifest: { workflowIds: ["wf-1", "wf-2"] } });

      await expect(
        invokeHandler(
          makeEvent("unbindWorkflowFromApp", {
            appId: "app-1",
            workflowId: "wf-1",
          }),
        ),
      ).resolves.toBeDefined();

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
      const unboundEvents = allEntries.filter(
        (e) => e?.DetailType === "app.workflow.unbound",
      );
      expect(unboundEvents.length).toBe(1);
    });

    // Finding 4d69104a: unbind must also update the AppsTable #META
    // mirror's workflowIds, keeping it in sync with the registry manifest.
    test("mirrors the updated workflowIds onto the AppsTable #META row", async () => {
      seedApp({ manifest: { workflowIds: ["wf-1", "wf-2"] } });

      await invokeHandler(
        makeEvent("unbindWorkflowFromApp", {
          appId: "app-1",
          workflowId: "wf-1",
        }),
      );

      const metaUpdate = ddbMock
        .commandCalls(UpdateCommand)
        .find(
          (c) =>
            c.args[0].input.TableName === "citadel-apps-test" &&
            (c.args[0].input.Key as Record<string, unknown> | undefined)
              ?.appId === "app-1",
        );
      expect(metaUpdate).toBeDefined();
      const values = metaUpdate!.args[0].input
        .ExpressionAttributeValues as Record<string, unknown>;
      expect(values[":v_workflowIds"]).toEqual(["wf-2"]);
    });

    test("throws when app not found", async () => {
      await expect(
        invokeHandler(
          makeEvent("unbindWorkflowFromApp", {
            appId: "nonexistent",
            workflowId: "wf-1",
          }),
        ),
      ).rejects.toThrow("App not found");
    });

    test("succeeds even if the AppsTable #META mirror write fails", async () => {
      seedApp({ manifest: { workflowIds: ["wf-1"] } });
      ddbMock.on(UpdateCommand).rejects(new Error("AppsTable down"));

      await expect(
        invokeHandler(
          makeEvent("unbindWorkflowFromApp", {
            appId: "app-1",
            workflowId: "wf-1",
          }),
        ),
      ).resolves.toBeDefined();
    });
  });
});
