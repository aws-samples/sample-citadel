/**
 * Idempotency-seam smoke workflow — non-prod gating + idempotency tests for
 * seed-blueprints/index.ts.
 *
 * Contract under test:
 *  - SMOKE_FIXTURES_ENABLED unset/not 'true' (prod) -> the Idempotency
 *    Smoke Workflow row is NEVER seeded (SMOKE_BLUEPRINTS is never appended
 *    to what gets written).
 *  - SMOKE_FIXTURES_ENABLED='true' (non-prod) -> exactly one smoke workflow
 *    row is put, referencing 'smoke-idempotency-agent'.
 *  - Re-running the seeder twice with the gate enabled resolves to the SAME
 *    deterministic workflowId both times — no duplicate rows.
 */

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

const ddbMock = mockClient(DynamoDBDocumentClient);

const mockHttpsRequest = jest.fn();
jest.mock("https", () => ({
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

// Import handler after mocks are set up (same convention as
// seed-blueprints.test.ts) — a single module instance for the whole file;
// the gate itself is read lazily from process.env inside the handler
// (smokeFixturesEnabled()), so no jest.resetModules()/dynamic re-import is
// needed to flip it between tests.
import { handler, deterministicId } from "../index";

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
      Version: "v1.0.0",
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

function smokeItemsFromCalls() {
  return ddbMock
    .commandCalls(PutCommand)
    .map((c) => c.args[0].input.Item!)
    .filter(
      (item) =>
        JSON.parse(item.definition as string).name ===
        "Idempotency Smoke Workflow",
    );
}

describe("seed-blueprints — idempotency smoke workflow gating", () => {
  beforeAll(() => {
    process.env.WORKFLOWS_TABLE = "citadel-workflows-test";
  });

  beforeEach(() => {
    ddbMock.reset();
    mockHttpsRequest.mockClear();
    ddbMock.on(PutCommand).resolves({});
  });

  afterEach(() => {
    delete process.env.SMOKE_FIXTURES_ENABLED;
  });

  afterAll(() => {
    delete process.env.WORKFLOWS_TABLE;
  });

  test("smoke workflow is NEVER seeded when SMOKE_FIXTURES_ENABLED is unset", async () => {
    delete process.env.SMOKE_FIXTURES_ENABLED;

    await invokeHandler(makeEvent("Create"), mockContext);

    expect(smokeItemsFromCalls()).toHaveLength(0);
  });

  test("smoke workflow is NEVER seeded when SMOKE_FIXTURES_ENABLED=false", async () => {
    process.env.SMOKE_FIXTURES_ENABLED = "false";

    await invokeHandler(makeEvent("Create"), mockContext);

    expect(smokeItemsFromCalls()).toHaveLength(0);
  });

  test("smoke workflow IS seeded exactly once when SMOKE_FIXTURES_ENABLED=true", async () => {
    process.env.SMOKE_FIXTURES_ENABLED = "true";

    await invokeHandler(makeEvent("Create"), mockContext);

    const smokeItems = smokeItemsFromCalls();
    expect(smokeItems).toHaveLength(1);
    const def = JSON.parse(smokeItems[0].definition as string);
    expect(def.nodes).toHaveLength(1);
    expect(def.nodes[0].agentId).toBe("smoke-idempotency-agent");
  });

  test("smoke workflow PutCommand carries the seedVersion-aware ConditionExpression", async () => {
    process.env.SMOKE_FIXTURES_ENABLED = "true";

    await invokeHandler(makeEvent("Create"), mockContext);

    const smokeCall = ddbMock
      .commandCalls(PutCommand)
      .find(
        (c) =>
          JSON.parse(c.args[0].input.Item!.definition as string).name ===
          "Idempotency Smoke Workflow",
      );

    expect(smokeCall).toBeDefined();
    expect(smokeCall!.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(workflowId) OR attribute_not_exists(seedVersion) OR seedVersion < :v",
    );
  });

  test("re-running the seeder twice with the gate enabled resolves to the SAME deterministic id — no duplicate row", async () => {
    process.env.SMOKE_FIXTURES_ENABLED = "true";

    await invokeHandler(makeEvent("Create"), mockContext);
    const firstSmokeIds = smokeItemsFromCalls().map((item) => item.workflowId);

    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
    await invokeHandler(makeEvent("Update"), mockContext);
    const secondSmokeIds = smokeItemsFromCalls().map((item) => item.workflowId);

    // Same name -> same deterministic workflowId on every re-run. The real
    // DynamoDB ConditionExpression (asserted above) is what turns a second
    // real Put into a true no-op against a table that already holds this
    // id; here the mock always accepts the Put, so idempotency is verified
    // via id stability, matching the existing "uses deterministic
    // workflowId based on blueprint name" convention in
    // seed-blueprints.test.ts.
    expect(firstSmokeIds).toHaveLength(1);
    expect(secondSmokeIds).toHaveLength(1);
    expect(firstSmokeIds[0]).toBe(secondSmokeIds[0]);
    expect(firstSmokeIds[0]).toBe(
      deterministicId("Idempotency Smoke Workflow"),
    );
  });
});
