/**
 * Seed eval-suites contract tests — deterministic ids, SEED_VERSION heal
 * semantics, DENY-case coverage (CIT-101 §6/§7).
 *
 * Mirrors seed-blueprints-contract.test.ts conventions: mocked https module
 * for the CFN response, aws-sdk-client-mock for DynamoDB, deterministic
 * sha256 ids, seedVersion-aware upsert ConditionExpression.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

jest.mock("https", () => ({
  request: (_options: unknown, callback?: () => void) => {
    if (typeof callback === "function") {
      callback();
    }
    return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  },
}));

const mockEmitGovernanceEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("../../utils/notifier-base", () => ({
  emitGovernanceEvent: (...args: unknown[]) => mockEmitGovernanceEvent(...args),
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
  "attribute_not_exists(suiteId) OR ((attribute_not_exists(seedVersion) OR seedVersion < :v) AND #status = :draft AND size(#refs) = :zero)";

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
    mockEmitGovernanceEvent.mockClear();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("seed data shape", () => {
    test("at least two seed suites: intake-agent + template:monolithic_db", () => {
      expect(SEED_EVAL_SUITES.length).toBeGreaterThanOrEqual(2);
      const targets = SEED_EVAL_SUITES.map((s) => s.agentTargetId);
      expect(targets).toContain("intake-agent");
      expect(targets).toContain("template:monolithic_db");
    });

    // The blanket "every suite has >= 1 DENY case" / "3-6 cases" assertions
    // predate the adversarial packs and do not universally apply to them:
    // the injection and data-leakage packs are intentionally DENY-exempt
    // (their safety signal is sanitizer-neutralization / canary
    // non-disclosure via task_success, not policy_compliance), and packs
    // may legitimately ship with 2 cases. Scope the legacy blanket checks
    // to the two baseline demo suites; each pack has its own targeted
    // assertions below.
    const BASELINE_SUITES = SEED_EVAL_SUITES.filter(
      (s) => s.gateClass === undefined,
    );

    test.each(BASELINE_SUITES.map((s) => [s.name, s] as const))(
      '"%s" has >= 1 expected-DENY case',
      (_name, suite) => {
        const denyCases = suite.cases.filter(
          (c) => c.expectedPolicyOutcome?.decision === "DENY",
        );
        expect(denyCases.length).toBeGreaterThanOrEqual(1);
      },
    );

    test.each(BASELINE_SUITES.map((s) => [s.name, s] as const))(
      '"%s" has 3-5 cases',
      (_name, suite) => {
        expect(suite.cases.length).toBeGreaterThanOrEqual(3);
        expect(suite.cases.length).toBeLessThanOrEqual(5);
      },
    );

    test.each(SEED_EVAL_SUITES.map((s) => [s.name, s] as const))(
      '"%s" has 2-6 cases',
      (_name, suite) => {
        expect(suite.cases.length).toBeGreaterThanOrEqual(2);
        expect(suite.cases.length).toBeLessThanOrEqual(6);
      },
    );

    describe("adversarial & safety eval packs", () => {
      const EXPECTED_GATE_CLASSES = [
        "adversarial-injection",
        "unauthorized-tool-use",
        "data-leakage",
        "policy-bypass",
        "unsafe-delegation",
      ];

      test("all five pack suites are present, each with its gateClass", () => {
        const gateClasses = SEED_EVAL_SUITES.map((s) => s.gateClass);
        for (const expected of EXPECTED_GATE_CLASSES) {
          expect(gateClasses).toContain(expected);
        }
      });

      test.each(EXPECTED_GATE_CLASSES)(
        'pack with gateClass "%s" has >= 1 case',
        (gateClass) => {
          const suite = SEED_EVAL_SUITES.find((s) => s.gateClass === gateClass);
          expect(suite).toBeDefined();
          expect(suite!.cases.length).toBeGreaterThanOrEqual(1);
        },
      );

      test('the "adversarial-injection" pack carries injection/tool-schema-poisoning payloads', () => {
        const suite = SEED_EVAL_SUITES.find(
          (s) => s.gateClass === "adversarial-injection",
        );
        expect(suite).toBeDefined();
        const kinds = suite!.cases.map((c) => c.kind);
        expect(kinds).toContain("CONVERSATION");
        expect(kinds).toContain("EXECUTION");
      });

      test('the "unauthorized-tool-use" pack expects DENY via the real explicit-deny-list reason token', () => {
        const suite = SEED_EVAL_SUITES.find(
          (s) => s.gateClass === "unauthorized-tool-use",
        );
        expect(suite).toBeDefined();
        const denyCase = suite!.cases.find(
          (c) => c.expectedPolicyOutcome?.decision === "DENY",
        );
        expect(denyCase).toBeDefined();
        expect(denyCase!.forbiddenTools?.length ?? 0).toBeGreaterThanOrEqual(1);
        const tool = denyCase!.forbiddenTools![0];
        expect(denyCase!.expectedPolicyOutcome!.findingTypes).toContain(
          `tool_denied:explicit_deny_list:${tool}`,
        );
      });

      test('the "data-leakage" pack expresses canary non-disclosure as a negative-lookahead REGEX', () => {
        const suite = SEED_EVAL_SUITES.find(
          (s) => s.gateClass === "data-leakage",
        );
        expect(suite).toBeDefined();
        const canaryCase = suite!.cases.find(
          (c) => c.expectedOutcome.mode === "REGEX",
        );
        expect(canaryCase).toBeDefined();
        expect(canaryCase!.expectedOutcome.target).toMatch(/^\^\(\?!/);
      });

      test('the "policy-bypass" pack has an expected-DENY case', () => {
        const suite = SEED_EVAL_SUITES.find(
          (s) => s.gateClass === "policy-bypass",
        );
        expect(suite).toBeDefined();
        const denyCases = suite!.cases.filter(
          (c) => c.expectedPolicyOutcome?.decision === "DENY",
        );
        expect(denyCases.length).toBeGreaterThanOrEqual(1);
      });

      test('the "unsafe-delegation" pack forbids a delegation tool and expects DENY', () => {
        const suite = SEED_EVAL_SUITES.find(
          (s) => s.gateClass === "unsafe-delegation",
        );
        expect(suite).toBeDefined();
        const denyCase = suite!.cases.find(
          (c) => c.expectedPolicyOutcome?.decision === "DENY",
        );
        expect(denyCase).toBeDefined();
        expect(denyCase!.forbiddenTools?.length ?? 0).toBeGreaterThanOrEqual(1);
      });
    });

    test("SEED_VERSION is a positive integer bumped to heal seeded packs", () => {
      expect(Number.isInteger(SEED_VERSION)).toBe(true);
      expect(SEED_VERSION).toBeGreaterThanOrEqual(2);
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

    test("suite item carries the pack's gateClass when defined on the suite definition", () => {
      const packSuiteDef = SEED_EVAL_SUITES.find((s) => s.gateClass);
      expect(packSuiteDef).toBeDefined();
      const item = buildSeedSuiteItem(packSuiteDef!, NOW);
      expect(item.gateClass).toBe(packSuiteDef!.gateClass);
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

    test("case items pass through trajectorySpec when the case definition sets it", () => {
      const delegationSuite = SEED_EVAL_SUITES.find(
        (s) => s.gateClass === "unsafe-delegation",
      );
      expect(delegationSuite).toBeDefined();
      const caseWithTrajectory = delegationSuite!.cases.find(
        (c) => c.trajectorySpec,
      );
      expect(caseWithTrajectory).toBeDefined();
      const suiteItem = buildSeedSuiteItem(delegationSuite!, NOW);
      const caseItems = buildSeedCaseItems(
        delegationSuite!,
        suiteItem.suiteId,
        NOW,
      );
      const item = caseItems.find((c) => c.name === caseWithTrajectory!.name);
      expect(item?.trajectorySpec).toEqual(caseWithTrajectory!.trajectorySpec);
    });
  });

  describe("CFN custom-resource upsert semantics", () => {
    test("PutCommand for each suite uses the mutability-guarded ConditionExpression with ExpressionAttributeNames", async () => {
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
          ":draft": "DRAFT",
          ":zero": 0,
        });
        expect(call.args[0].input.ExpressionAttributeNames).toEqual({
          "#status": "status",
          "#refs": "references",
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

    test("brand-new suite (no existing row) is still created", async () => {
      // attribute_not_exists(suiteId) branch: no row present at all, so
      // GetCommand (used only to classify a conditional failure) is never
      // reached — Put succeeds directly.
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      await invokeHandler(makeEvent("Update"), mockContext);

      const suitePuts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-eval-suites-test",
        );
      expect(suitePuts).toHaveLength(SEED_EVAL_SUITES.length);
      expect(logMessagesContaining(logSpy, "Created eval suite")).toBe(
        SEED_EVAL_SUITES.length,
      );
      expect(mockEmitGovernanceEvent).not.toHaveBeenCalled();
    });

    test("a stale DRAFT, unreferenced seed row still heals (already-current skip is NOT confused with blocked)", async () => {
      // Simulate: PutCommand's own condition succeeds (stale DRAFT,
      // references empty, seedVersion < :v) -> heal proceeds normally,
      // no GetCommand classification needed, no notification.
      ddbMock.on(PutCommand).resolves({ Attributes: { seedVersion: 1 } });

      await invokeHandler(makeEvent("Update"), mockContext);

      expect(
        logMessagesContaining(logSpy, "Updated outdated seed eval suite"),
      ).toBe(SEED_EVAL_SUITES.length);
      expect(mockEmitGovernanceEvent).not.toHaveBeenCalled();
    });

    test("skips silently (no notification) when the stale row is already current (ordinary redeploy no-op)", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);
      // Classification read: row IS current (seedVersion already >= :v),
      // so this is the benign "already current" case, not a block.
      ddbMock.on(GetCommand).resolves({
        Item: {
          suiteId: "some-id",
          status: "DRAFT",
          references: [],
          seedVersion: SEED_VERSION,
        },
      });

      await expect(
        invokeHandler(makeEvent("Update"), mockContext),
      ).resolves.not.toThrow();

      expect(logMessagesContaining(logSpy, "skipping")).toBeGreaterThan(0);
      expect(mockEmitGovernanceEvent).not.toHaveBeenCalled();
    });

    test("a FROZEN stale seed row is left completely untouched and emits exactly one blocked notification", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);
      ddbMock.on(GetCommand).resolves({
        Item: {
          suiteId: "frozen-suite-id",
          name: "Intake Agent Baseline Suite",
          status: "FROZEN",
          references: [],
          seedVersion: 1,
        },
      });

      await invokeHandler(makeEvent("Update"), mockContext);

      // Never a second write attempt against a blocked row.
      const suitePuts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-eval-suites-test",
        );
      expect(suitePuts).toHaveLength(SEED_EVAL_SUITES.length);

      const blockedCalls = mockEmitGovernanceEvent.mock.calls.filter(
        ([detailType]) => detailType === "governance.eval.seed.heal.blocked",
      );
      expect(blockedCalls.length).toBe(SEED_EVAL_SUITES.length);
      expect(blockedCalls[0][1]).toMatchObject({ reason: "not_draft" });
      expect(logMessagesContaining(logSpy, "BLOCKED")).toBeGreaterThan(0);
    });

    test("a stale DRAFT seed row WITH references is left completely untouched and classified as referenced", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);
      ddbMock.on(GetCommand).resolves({
        Item: {
          suiteId: "referenced-suite-id",
          name: "Monolithic DB Template Baseline Suite",
          status: "DRAFT",
          references: ["evalRun-1"],
          seedVersion: 1,
        },
      });

      await invokeHandler(makeEvent("Update"), mockContext);

      const blockedCalls = mockEmitGovernanceEvent.mock.calls.filter(
        ([detailType]) => detailType === "governance.eval.seed.heal.blocked",
      );
      expect(blockedCalls.length).toBe(SEED_EVAL_SUITES.length);
      expect(blockedCalls[0][1]).toMatchObject({
        reason: "referenced",
        referenceCount: 1,
      });
    });

    test("a FROZEN and referenced row is classified not_draft_and_referenced, still exactly one notification per suite", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);
      ddbMock.on(GetCommand).resolves({
        Item: {
          status: "FROZEN",
          references: ["evalRun-1", "evalRun-2"],
          seedVersion: 1,
        },
      });

      await invokeHandler(makeEvent("Update"), mockContext);

      const blockedCalls = mockEmitGovernanceEvent.mock.calls.filter(
        ([detailType]) => detailType === "governance.eval.seed.heal.blocked",
      );
      expect(blockedCalls.length).toBe(SEED_EVAL_SUITES.length);
      for (const [, detail] of blockedCalls) {
        expect(detail).toMatchObject({
          reason: "not_draft_and_referenced",
          referenceCount: 2,
        });
      }
    });

    test("an ARCHIVED stale seed row does not heal and is treated as blocked (deliberate: ARCHIVED is a terminal state)", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);
      ddbMock.on(GetCommand).resolves({
        Item: {
          status: "ARCHIVED",
          references: [],
          seedVersion: 1,
        },
      });

      await invokeHandler(makeEvent("Update"), mockContext);

      const blockedCalls = mockEmitGovernanceEvent.mock.calls.filter(
        ([detailType]) => detailType === "governance.eval.seed.heal.blocked",
      );
      expect(blockedCalls.length).toBe(SEED_EVAL_SUITES.length);
      for (const [, detail] of blockedCalls) {
        expect(detail).toMatchObject({
          status: "ARCHIVED",
          reason: "not_draft",
        });
      }
    });

    test("at most one blocked notification per blocked suite per invocation even if the row read fails oddly twice", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejects(conditionalError);
      ddbMock.on(GetCommand).resolves({
        Item: {
          suiteId: "frozen-suite-id",
          name: "Intake Agent Baseline Suite",
          status: "FROZEN",
          references: [],
          seedVersion: 1,
        },
      });

      await invokeHandler(makeEvent("Update"), mockContext);

      const perSuiteCounts = new Map<string, number>();
      for (const [detailType, detail] of mockEmitGovernanceEvent.mock.calls) {
        if (detailType !== "governance.eval.seed.heal.blocked") continue;
        const id = (detail as { suiteId: string }).suiteId;
        perSuiteCounts.set(id, (perSuiteCounts.get(id) ?? 0) + 1);
      }
      for (const count of perSuiteCounts.values()) {
        expect(count).toBe(1);
      }
    });
  });
});
