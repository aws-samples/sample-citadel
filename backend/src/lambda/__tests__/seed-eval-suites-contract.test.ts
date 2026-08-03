/**
 * Seed eval-suites contract tests — deterministic ids, SEED_VERSION heal
 * semantics, DENY-case coverage (CIT-101 §6/§7).
 *
 * Mirrors seed-blueprints-contract.test.ts conventions: mocked https module
 * for the CFN response, aws-sdk-client-mock for DynamoDB, deterministic
 * sha256 ids, seedVersion-aware upsert ConditionExpression.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

jest.mock("https", () => ({
  request: (_options: unknown, callback?: () => void) => {
    if (typeof callback === "function") {
      callback();
    }
    return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  },
}));

// Env must be set before importing the module under test (top-level consts
// read process.env at import time).
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";

import {
  handler,
  SEED_EVAL_SUITES,
  SEED_VERSION,
  buildSeedSuiteItem,
  buildSeedCaseItems,
  deterministicId,
} from "../seed-eval-suites";

const ddbMock = mockClient(DynamoDBDocumentClient);

const invokeHandler = handler as (
  event: CloudFormationCustomResourceEvent,
  context: Context,
) => Promise<void>;

const EXPECTED_SUITE_CONDITION_EXPRESSION =
  "attribute_not_exists(suiteId) OR attribute_not_exists(seedVersion) OR seedVersion < :v";

const NOW = "2026-07-17T00:00:00.000Z";

function makeEvent(
  requestType: "Create" | "Update" | "Delete",
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken:
      "arn:aws:lambda:us-east-1:123456789012:function:seed-eval-suites",
    ResponseURL:
      "https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/response",
    StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid",
    RequestId: "unique-id-1234",
    ResourceType: "Custom::SeedEvalSuites",
    LogicalResourceId: "SeedEvalSuitesResource",
    ResourceProperties: {
      ServiceToken:
        "arn:aws:lambda:us-east-1:123456789012:function:seed-eval-suites",
      Version: "v1.0.0",
    },
  } as CloudFormationCustomResourceEvent;
}

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "seed-eval-suites",
  functionVersion: "$LATEST",
  invokedFunctionArn:
    "arn:aws:lambda:us-east-1:123456789012:function:seed-eval-suites",
  memoryLimitInMB: "128",
  awsRequestId: "req-123",
  logGroupName: "/aws/lambda/seed-eval-suites",
  logStreamName: "2026/07/17/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 30000,
  done: jest.fn(),
  fail: jest.fn(),
  succeed: jest.fn(),
};

function logMessagesContaining(spy: jest.SpyInstance, needle: string): number {
  return spy.mock.calls.filter(
    (call) =>
      typeof call[0] === "string" && (call[0] as string).includes(needle),
  ).length;
}

describe("seed-eval-suites contract", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    ddbMock.reset();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("seed data shape", () => {
    test("exactly two seed suites: intake-agent + template:monolithic_db", () => {
      expect(SEED_EVAL_SUITES).toHaveLength(2);
      const targets = SEED_EVAL_SUITES.map((s) => s.agentTargetId);
      expect(targets).toContain("intake-agent");
      expect(targets).toContain("template:monolithic_db");
    });

    test.each(SEED_EVAL_SUITES.map((s) => [s.name, s] as const))(
      '"%s" has >= 1 expected-DENY case',
      (_name, suite) => {
        const denyCases = suite.cases.filter(
          (c) => c.expectedPolicyOutcome?.decision === "DENY",
        );
        expect(denyCases.length).toBeGreaterThanOrEqual(1);
      },
    );

    test.each(SEED_EVAL_SUITES.map((s) => [s.name, s] as const))(
      '"%s" has 3-5 cases',
      (_name, suite) => {
        expect(suite.cases.length).toBeGreaterThanOrEqual(3);
        expect(suite.cases.length).toBeLessThanOrEqual(5);
      },
    );

    test("SEED_VERSION is a positive integer", () => {
      expect(Number.isInteger(SEED_VERSION)).toBe(true);
      expect(SEED_VERSION).toBeGreaterThan(0);
    });

    test("deterministicId is stable for the same input", () => {
      const a = deterministicId("intake-agent-suite");
      const b = deterministicId("intake-agent-suite");
      expect(a).toBe(b);
      expect(a).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    test("deterministicId differs for different inputs", () => {
      expect(deterministicId("a")).not.toBe(deterministicId("b"));
    });
  });

  describe("buildSeedSuiteItem / buildSeedCaseItems", () => {
    test("suite item lands DRAFT, createdBy SYSTEM, stamped with seedVersion", () => {
      const suiteDef = SEED_EVAL_SUITES[0];
      const item = buildSeedSuiteItem(suiteDef, NOW);
      expect(item.status).toBe("DRAFT");
      expect(item.createdBy).toBe("SYSTEM");
      expect(item.seedVersion).toBe(SEED_VERSION);
      expect(item.references).toEqual([]);
      expect(item.suiteId).toBe(
        deterministicId(`citadel-seed-eval-suite:${suiteDef.name}`),
      );
    });

    test("case items reference the parent suiteId and are stamped SYSTEM/seedVersion", () => {
      const suiteDef = SEED_EVAL_SUITES[0];
      const suiteItem = buildSeedSuiteItem(suiteDef, NOW);
      const caseItems = buildSeedCaseItems(suiteDef, suiteItem.suiteId, NOW);
      expect(caseItems).toHaveLength(suiteDef.cases.length);
      for (const c of caseItems) {
        expect(c.suiteId).toBe(suiteItem.suiteId);
        expect(c.createdBy).toBe("SYSTEM");
        expect(c.seedVersion).toBe(SEED_VERSION);
        expect(c.provenance.source).toBe("AUTHORED");
      }
    });
  });

  describe("CFN custom-resource upsert semantics", () => {
    test("PutCommand for each suite uses seedVersion-aware ConditionExpression", async () => {
      ddbMock.on(PutCommand).resolves({});

      await invokeHandler(makeEvent("Update"), mockContext);

      const suitePuts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-eval-suites-test",
        );
      expect(suitePuts).toHaveLength(SEED_EVAL_SUITES.length);
      for (const call of suitePuts) {
        expect(call.args[0].input.ConditionExpression).toBe(
          EXPECTED_SUITE_CONDITION_EXPRESSION,
        );
        expect(call.args[0].input.ExpressionAttributeValues).toEqual({
          ":v": SEED_VERSION,
        });
      }
    });

    test("PutCommand issued for every case across all suites", async () => {
      ddbMock.on(PutCommand).resolves({});
      await invokeHandler(makeEvent("Update"), mockContext);

      const casePuts = ddbMock
        .commandCalls(PutCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-eval-cases-test");
      const totalCases = SEED_EVAL_SUITES.reduce(
        (sum, s) => sum + s.cases.length,
        0,
      );
      expect(casePuts).toHaveLength(totalCases);
    });

    test("Delete request type is a no-op success", async () => {
      await expect(
        invokeHandler(makeEvent("Delete"), mockContext),
      ).resolves.not.toThrow();
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("skips (heals nothing) when rows are current (ConditionalCheckFailedException) and never touches user rows", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);

      await expect(
        invokeHandler(makeEvent("Update"), mockContext),
      ).resolves.not.toThrow();

      expect(logMessagesContaining(logSpy, "skipping")).toBeGreaterThan(0);
    });
  });
});
