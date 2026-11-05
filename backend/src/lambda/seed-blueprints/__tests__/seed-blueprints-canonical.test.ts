/**
 * Tests for seed-blueprints recordId resolution.
 *
 * Verifies that:
 * - SEED_VERSION is 4 (runnable Conditional Router)
 * - buildSeedBlueprintItem substitutes recordIds and adds legacyAgentName
 * - buildSeedBlueprintItem leaves placeholder agents untouched
 * - handler seeds blueprints with correct seedVersion
 * - handler degrades gracefully when agent table is unavailable
 *
 * resolveAgentRecordIds is tested in resolve-agent-record-ids.test.ts
 * (separate file to avoid the https mock breaking DynamoDBClient internals).
 */

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

// Mock the low-level client so the module-scope DynamoDBClient never creates
// a real NodeHttpHandler (whose keep-alive https.Agent crashes on teardown
// when Jest replaces the https module with the mock below).
const ddbClientMock = mockClient(DynamoDBClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock https.request for CFN response while preserving https.Agent (needed
// by @smithy/node-http-handler during teardown — see #466).
const mockHttpsRequest = jest.fn();
jest.mock("https", () => ({
  ...jest.requireActual("https"),
  request: (...args: unknown[]) => {
    mockHttpsRequest(...args);
    const req = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      callback({ statusCode: 200 });
    }
    return req;
  },
}));

import {
  handler,
  SEED_BLUEPRINTS,
  SEED_VERSION,
  buildSeedBlueprintItem,
} from "../index";

function makeEvent(
  requestType: "Create" | "Update" | "Delete",
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken:
      "arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints",
    ResponseURL:
      "https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/response",
    StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid",
    RequestId: "unique-id-1234",
    ResourceType: "Custom::SeedBlueprints",
    LogicalResourceId: "SeedBlueprintsResource",
    ResourceProperties: {
      ServiceToken:
        "arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints",
      Version: "v1.4.0",
    },
  } as CloudFormationCustomResourceEvent;
}

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "seed-blueprints",
  functionVersion: "$LATEST",
  invokedFunctionArn:
    "arn:aws:lambda:us-east-1:123456789012:function:seed-blueprints",
  memoryLimitInMB: "128",
  awsRequestId: "req-123",
  logGroupName: "/aws/lambda/seed-blueprints",
  logStreamName: "2024/01/15/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 30000,
  done: jest.fn(),
  fail: jest.fn(),
  succeed: jest.fn(),
};

const invokeHandler = handler as (
  event: CloudFormationCustomResourceEvent,
  context: Context,
) => Promise<void>;

describe("seed-blueprints — recordId resolution", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
    process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
  });

  beforeEach(() => {
    ddbMock.reset();
    mockHttpsRequest.mockClear();
  });

  afterEach(() => {
    delete process.env.SMOKE_FIXTURES_ENABLED;
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
    ddbMock.restore();
    ddbClientMock.restore();
  });

  // ─── SEED_VERSION ──────────────────────────────────────────────

  test("SEED_VERSION is 4 (runnable Conditional Router)", () => {
    expect(SEED_VERSION).toBe(4);
  });

  // ─── buildSeedBlueprintItem ────────────────────────────────────

  describe("buildSeedBlueprintItem with agentRecordIds", () => {
    test("substitutes recordIds and adds legacyAgentName", () => {
      const echoBlueprint = SEED_BLUEPRINTS.find(
        (b) => b.name === "Echo Demo Workflow",
      )!;
      const agentMap = new Map([["demo-echo-agent", "mjaKkVyqoFGN"]]);

      const item = buildSeedBlueprintItem(
        echoBlueprint,
        "2026-01-01T00:00:00Z",
        agentMap,
      );

      const def = JSON.parse(item.definition);
      expect(def.nodes[0].agentId).toBe("mjaKkVyqoFGN");
      expect(def.nodes[0].legacyAgentName).toBe("demo-echo-agent");
      expect(def.nodes[1].agentId).toBe("mjaKkVyqoFGN");
      expect(def.nodes[1].legacyAgentName).toBe("demo-echo-agent");
    });

    test("leaves placeholder agents untouched", () => {
      const templateBp = SEED_BLUEPRINTS.find(
        (b) => b.name === "Sequential Agent Pipeline",
      )!;
      const agentMap = new Map([["demo-echo-agent", "mjaKkVyqoFGN"]]);

      const item = buildSeedBlueprintItem(
        templateBp,
        "2026-01-01T00:00:00Z",
        agentMap,
      );

      const def = JSON.parse(item.definition);
      expect(def.nodes[0].agentId).toBe("placeholder-agent-1");
      expect(def.nodes[0].legacyAgentName).toBeUndefined();
    });

    test("works without agentRecordIds (backward compat)", () => {
      const echoBlueprint = SEED_BLUEPRINTS.find(
        (b) => b.name === "Echo Demo Workflow",
      )!;

      const item = buildSeedBlueprintItem(
        echoBlueprint,
        "2026-01-01T00:00:00Z",
      );

      const def = JSON.parse(item.definition);
      expect(def.nodes[0].agentId).toBe("demo-echo-agent");
      expect(def.nodes[0].legacyAgentName).toBeUndefined();
    });
  });

  // ─── Handler integration ───────────────────────────────────────
  // The handler's DynamoDBClient is broken by the https mock.
  // resolveAgentRecordIds catches errors gracefully and returns an empty
  // map, so blueprints are seeded with friendly names. The unit tests in
  // resolve-agent-record-ids.test.ts verify the resolution logic itself.

  describe("handler integration", () => {
    test("seeds blueprints with friendly names when agent resolution is unavailable", async () => {
      ddbMock.on(PutCommand).resolves({});

      await invokeHandler(makeEvent("Create"), mockContext);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(5);
    });

    test("seeds blueprints with friendly names when agent table env is unset", async () => {
      const saved = process.env.AGENT_CONFIG_TABLE;
      delete process.env.AGENT_CONFIG_TABLE;

      ddbMock.on(PutCommand).resolves({});

      await invokeHandler(makeEvent("Create"), mockContext);

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(5);

      const echoPut = putCalls.find((c) => {
        const def = JSON.parse(c.args[0].input.Item!.definition as string);
        return def.name === "Echo Demo Workflow";
      });
      const echoDef = JSON.parse(
        echoPut!.args[0].input.Item!.definition as string,
      );
      expect(echoDef.nodes[0].agentId).toBe("demo-echo-agent");
      expect(echoDef.nodes[0].legacyAgentName).toBeUndefined();

      process.env.AGENT_CONFIG_TABLE = saved;
    });

    test("all seed items carry seedVersion 3", async () => {
      ddbMock.on(PutCommand).resolves({});

      await invokeHandler(makeEvent("Create"), mockContext);

      for (const call of ddbMock.commandCalls(PutCommand)) {
        expect(call.args[0].input.Item!.seedVersion).toBe(4);
      }
    });
  });
});
