/**
 * Guard test: decision paths (APPROVED / REJECTED) must never call
 * updateResource. The registry treats any UpdateRegistryRecord on a
 * non-DRAFT record as a content edit and demotes it back to DRAFT, which
 * defeats the decision.
 *
 * Two layers:
 *   A) AST/regex scan of each resolver source: inside any branch where the
 *      target status is APPROVED or REJECTED, `updateResource(` must not
 *      appear.
 *   B) Stateful-fake integration test for updateApp: submit → approve
 *      succeeds with exactly one UpdateRegistryRecordStatus call and zero
 *      updateResource calls.
 */

// -- Environment -----------------------------------------------------------
process.env.REGISTRY_ID = "test-registry-id";
process.env.APPS_TABLE = "citadel-apps-test";
process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.USER_POOL_ID = "us-east-1_test";
process.env.AUTHORITY_UNITS_TABLE = "test-authority-units";
process.env.APPSYNC_ENDPOINT =
  "https://test-api.appsync-api.us-east-1.amazonaws.com/graphql";
process.env.AWS_REGION = "us-east-1";

import * as fs from "fs";
import * as path from "path";

// -- Mocks -----------------------------------------------------------------
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
  getUpdateResourceStatusCallCount,
} from "../src/lambda/__tests__/fixtures/registry-service-mock";

jest.mock("../src/services/registry-service", () => {
  const { getMockRegistryService } = jest.requireActual(
    "../src/lambda/__tests__/fixtures/registry-service-mock",
  );
  const actual = jest.requireActual("../src/services/registry-service");
  return {
    RegistryService: jest
      .fn()
      .mockImplementation(() => getMockRegistryService()),
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
    TypeMismatchError: actual.TypeMismatchError,
    RegistryLifecycleError: actual.RegistryLifecycleError,
    RegistryRecordStatusValues: actual.RegistryRecordStatusValues,
    decideRecord: actual.decideRecord,
    DECISION_STATUSES: actual.DECISION_STATUSES,
  };
});

jest.mock("../src/utils/appsync", () => ({
  getUserId: jest.fn(
    (identity: { sub?: string; claims?: { sub?: string } }) =>
      identity?.sub || identity?.claims?.sub || "anonymous",
  ),
}));

const mockPublishAppStatusEvent = jest.fn().mockResolvedValue({});
jest.mock("../src/utils/appsync-publish", () => ({
  publishAppStatusEvent: mockPublishAppStatusEvent,
}));

jest.mock("uuid", () => ({
  v4: jest.fn().mockReturnValue("test-correlation-id"),
}));

import { handler } from "../src/lambda/registry-agent-record-resolver";

type HandlerEvent = Parameters<typeof handler>[0];
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  admin = false,
) {
  return {
    info: { fieldName },
    arguments: args,
    identity: admin
      ? {
          sub: "admin-1",
          claims: { sub: "admin-1", "custom:role": "admin" },
          "custom:role": "admin",
          "cognito:groups": ["admin"],
        }
      : {
          sub: "user-123",
          claims: { sub: "user-123", "custom:organization": "org-1" },
        },
  } as unknown as HandlerEvent;
}

function seedApp(status: string, version = 1, orgId = "org-1") {
  seedMockRegistry("agent", "app-1", {
    name: "Test App",
    description: "Test",
    status,
    customDescriptorContent: JSON.stringify({
      appId: "app-1",
      manifest: {
        orgId,
        version,
        status,
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        createdBy: "user-123",
        access: {},
        routingConfig: null,
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Part A: AST / regex guard — no `updateResource(` inside decision branches
// ---------------------------------------------------------------------------

const RESOLVER_FILES = [
  "src/lambda/registry-agent-record-resolver.ts",
  "src/lambda/tool-config-resolver.ts",
  "src/lambda/agent-config-resolver.ts",
];

describe("decision-paths-no-content-write guard", () => {
  describe("Part A: source scan — no updateResource inside APPROVED/REJECTED branches", () => {
    for (const relPath of RESOLVER_FILES) {
      const absPath = path.resolve(__dirname, "..", relPath);
      if (!fs.existsSync(absPath)) continue;

      it(`${relPath} — decision branches do not call updateResource`, () => {
        const src = fs.readFileSync(absPath, "utf-8");
        const lines = src.split("\n");

        // Walk the source and flag any updateResource( call that occurs
        // inside a decision branch. A "decision branch" is detected by
        // tracking brace depth after a line that matches the decision-status
        // pattern (APPROVED|REJECTED status check in an if/else block).
        const violations: string[] = [];
        let inDecisionBranch = false;
        let braceDepth = 0;
        let branchStartLine = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // Skip comments
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

          // Detect entry into a decision branch: a line that has both a
          // status check for APPROVED/REJECTED and an opening brace.
          if (
            !inDecisionBranch &&
            /(?:===?\s*["'](?:APPROVED|REJECTED)["']|DECISION_STATUSES\.has|isDecision|decision.*short-circuit)/i.test(
              line,
            ) &&
            /\{/.test(line)
          ) {
            inDecisionBranch = true;
            braceDepth = 0;
            branchStartLine = i + 1;
            // Count braces on this line
            for (const ch of line) {
              if (ch === "{") braceDepth++;
              if (ch === "}") braceDepth--;
            }
            continue;
          }

          if (inDecisionBranch) {
            for (const ch of line) {
              if (ch === "{") braceDepth++;
              if (ch === "}") braceDepth--;
            }

            // Check for updateResource( — but NOT updateResourceStatus(
            if (
              /\bupdateResource\s*\(/.test(trimmed) &&
              !/\bupdateResourceStatus\s*\(/.test(trimmed)
            ) {
              violations.push(
                `${relPath}:${i + 1} — updateResource() call inside decision branch starting at L${branchStartLine}`,
              );
            }

            if (braceDepth <= 0) {
              inDecisionBranch = false;
            }
          }
        }

        expect(violations).toEqual([]);
      });
    }
  });

  // -----------------------------------------------------------------------
  // Part B: stateful-fake integration — submit → approve uses exactly one
  // updateResourceStatus and zero updateResource calls.
  // -----------------------------------------------------------------------

  describe("Part B: updateApp submit → approve uses status-only call", () => {
    beforeEach(() => {
      resetMockRegistry();
      ebMock.reset();
      mockPublishAppStatusEvent.mockClear();
      ebMock.on(PutEventsCommand).resolves({});
    });

    afterAll(() => {
      delete process.env.APPS_TABLE;
      delete process.env.WORKFLOWS_TABLE;
      delete process.env.AGENT_CONFIG_TABLE;
      delete process.env.EVENT_BUS_NAME;
      delete process.env.USER_POOL_ID;
      delete process.env.APPSYNC_ENDPOINT;
      delete process.env.AWS_REGION;
      delete process.env.REGISTRY_ID;
      delete process.env.AUTHORITY_UNITS_TABLE;
    });

    it("approve triggers exactly one updateResourceStatus and zero updateResource calls", async () => {
      // Seed a PENDING_APPROVAL record
      seedApp("PENDING_APPROVAL", 1);

      // Snapshot counters before
      const statusBefore = getUpdateResourceStatusCallCount();
      const writeBefore = getUpdateResourceCallCount();

      // Approve
      const result = (await invokeHandler(
        makeEvent(
          "updateApp",
          { input: { appId: "app-1", status: "APPROVED", version: 1 } },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe("APPROVED");

      // Exactly one updateResourceStatus (the decision) and zero updateResource
      const statusDelta = getUpdateResourceStatusCallCount() - statusBefore;
      const writeDelta = getUpdateResourceCallCount() - writeBefore;

      expect(statusDelta).toBe(1);
      expect(writeDelta).toBe(0);
    });

    it("reject triggers exactly one updateResourceStatus and zero updateResource calls", async () => {
      seedApp("PENDING_APPROVAL", 1);

      const statusBefore = getUpdateResourceStatusCallCount();
      const writeBefore = getUpdateResourceCallCount();

      const result = (await invokeHandler(
        makeEvent(
          "updateApp",
          {
            input: {
              appId: "app-1",
              status: "REJECTED",
              statusReason: "does not meet policy",
              version: 1,
            },
          },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe("REJECTED");

      const statusDelta = getUpdateResourceStatusCallCount() - statusBefore;
      const writeDelta = getUpdateResourceCallCount() - writeBefore;

      expect(statusDelta).toBe(1);
      expect(writeDelta).toBe(0);
    });

    it("content + decision in the same request is rejected", async () => {
      seedApp("PENDING_APPROVAL", 1);

      await expect(
        invokeHandler(
          makeEvent(
            "updateApp",
            {
              input: {
                appId: "app-1",
                status: "APPROVED",
                name: "Changed Name",
                version: 1,
              },
            },
            true,
          ),
        ),
      ).rejects.toThrow(/content fields.*cannot be changed/i);
    });
  });
});
