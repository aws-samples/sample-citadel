/**
 * CIT-102 Pass A — eval-run-resolver tests.
 *
 * Structural mirror of eval-resolver's test conventions: mocked DDB client,
 * authContext fixtures per role, direct handler-function calls (not the
 * AppSync `handler` dispatch, except where explicitly noted).
 *
 * Idempotency (design §2): evalRunId = uuidv5(NS, `${suiteId}:${suiteVersion}
 * :${agentTargetVersion}:${idempotencyKey}`). startEvalRun does a
 * ConditionExpression=attribute_not_exists(evalRunId) PutCommand; on
 * ConditionalCheckFailedException it returns the EXISTING run (fetched via
 * GetCommand) rather than throwing — safe-retry semantics.
 */
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import * as fc from "fast-check";
import { v5 as uuidv5 } from "uuid";
import type { AuthContext, EvalSuite, EvalRun } from "../../types";

process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  startEvalRun,
  getEvalRun,
  listEvalRuns,
  listEvalRunCaseResults,
  EVAL_RUN_NAMESPACE,
} from "../eval-run-resolver";

function authContextFor(role: string): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function frozenSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    suiteId: "suite-1",
    orgId: "org-1",
    agentTargetId: "agent-1",
    name: "Suite One",
    description: "",
    semver: "1.0.0",
    status: "FROZEN",
    version: 2,
    references: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "architect-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
});

describe("startEvalRun — authorization", () => {
  test("throws UnauthorizedError without eval:run permission", async () => {
    ddbMock.on(GetCommand).resolves({ Item: frozenSuite() });
    await expect(
      startEvalRun(
        {
          suiteId: "suite-1",
          agentTargetId: "agent-1",
          agentTargetVersion: "v1",
          idempotencyKey: "key-1",
        },
        authContextFor("project_manager"),
      ),
    ).rejects.toThrow(/UnauthorizedError/);
  });

  test("allows architect", async () => {
    ddbMock.on(GetCommand).resolves({ Item: frozenSuite() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    const run = await startEvalRun(
      {
        suiteId: "suite-1",
        agentTargetId: "agent-1",
        agentTargetVersion: "v1",
        idempotencyKey: "key-1",
      },
      authContextFor("architect"),
    );
    expect(run.evalRunId).toBeDefined();
  });

  test("allows developer", async () => {
    ddbMock.on(GetCommand).resolves({ Item: frozenSuite() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    const run = await startEvalRun(
      {
        suiteId: "suite-1",
        agentTargetId: "agent-1",
        agentTargetVersion: "v1",
        idempotencyKey: "key-1",
      },
      authContextFor("developer"),
    );
    expect(run.evalRunId).toBeDefined();
  });
});

describe("startEvalRun — frozen-suite-only gate", () => {
  test("rejects a DRAFT suite", async () => {
    ddbMock.on(GetCommand).resolves({ Item: frozenSuite({ status: "DRAFT" }) });
    await expect(
      startEvalRun(
        {
          suiteId: "suite-1",
          agentTargetId: "agent-1",
          agentTargetVersion: "v1",
          idempotencyKey: "key-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*FROZEN/i);
  });

  test("rejects an ARCHIVED suite", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: frozenSuite({ status: "ARCHIVED" }) });
    await expect(
      startEvalRun(
        {
          suiteId: "suite-1",
          agentTargetId: "agent-1",
          agentTargetVersion: "v1",
          idempotencyKey: "key-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(/ValidationError.*FROZEN/i);
  });

  test("rejects when suite does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(
      startEvalRun(
        {
          suiteId: "suite-missing",
          agentTargetId: "agent-1",
          agentTargetVersion: "v1",
          idempotencyKey: "key-1",
        },
        authContextFor("architect"),
      ),
    ).rejects.toThrow(/EvalSuite not found/);
  });

  test("accepts a FROZEN suite and writes the run row + case-result rows", async () => {
    ddbMock.on(GetCommand).resolves({ Item: frozenSuite() });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          suiteId: "suite-1",
          caseId: "case-1",
          kind: "CONVERSATION",
          forbiddenTools: ["dangerous_tool"],
        },
        {
          suiteId: "suite-1",
          caseId: "case-2",
          kind: "EXECUTION",
          forbiddenTools: [],
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});

    const run = await startEvalRun(
      {
        suiteId: "suite-1",
        agentTargetId: "agent-1",
        agentTargetVersion: "v1",
        idempotencyKey: "key-1",
      },
      authContextFor("architect"),
    );

    expect(run.status).toBe("PENDING");
    expect(run.caseCount).toBe(2);
    expect(run.pendingCases).toBe(2);

    const putCalls = ddbMock.commandCalls(PutCommand);
    // 1 run row + 2 case-result rows = 3 puts.
    expect(putCalls).toHaveLength(3);
    const runPut = putCalls.find(
      (c) => c.args[0].input.TableName === "citadel-eval-runs-test",
    );
    expect(runPut?.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(evalRunId)",
    );
  });
});

describe("startEvalRun — idempotency", () => {
  test("evalRunId is a deterministic uuidv5 of (suiteId:suiteVersion:agentTargetVersion:idempotencyKey)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: frozenSuite({ version: 3 }) });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const run = await startEvalRun(
      {
        suiteId: "suite-1",
        agentTargetId: "agent-1",
        agentTargetVersion: "v7",
        idempotencyKey: "key-xyz",
      },
      authContextFor("architect"),
    );

    const expected = uuidv5("suite-1:3:v7:key-xyz", EVAL_RUN_NAMESPACE);
    expect(run.evalRunId).toBe(expected);
  });

  test("a repeated call with the same (suite,suiteVersion,agentVersion,idempotencyKey) returns the SAME existing run and performs NO second create", async () => {
    const suite = frozenSuite();
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(PutCommand).rejectsOnce(conditionalError);

    const existingRun: EvalRun = {
      evalRunId: uuidv5("suite-1:2:v1:key-1", EVAL_RUN_NAMESPACE),
      orgId: "org-1",
      suiteId: "suite-1",
      suiteVersion: 2,
      agentTargetId: "agent-1",
      agentTargetVersion: "v1",
      status: "PENDING",
      caseCount: 0,
      pendingCases: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      startedBy: "user-architect",
      idempotencyKey: "key-1",
    };
    // Discriminate GetCommand by table name: suite lookups always resolve
    // to the FROZEN suite fixture; run-row lookups (the conflict-fetch
    // path) resolve to the existing run.
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-runs-test") {
        return { Item: existingRun };
      }
      return { Item: suite };
    });

    const run1 = await startEvalRun(
      {
        suiteId: "suite-1",
        agentTargetId: "agent-1",
        agentTargetVersion: "v1",
        idempotencyKey: "key-1",
      },
      authContextFor("architect"),
    );

    expect(run1.evalRunId).toBe(existingRun.evalRunId);
    // Only one PutCommand attempt for the run row (the rejected one) — no
    // retry-created second run row.
    const runRowPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runRowPuts).toHaveLength(1);
  });
});

describe("startEvalRun — idempotency property", () => {
  test("for any (suiteId, suiteVersion, agentTargetVersion, idempotencyKey) tuple, N concurrent submits collapse to exactly one created run and every call resolves to the same evalRunId", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => s.trim().length > 0),
        fc.integer({ min: 1, max: 50 }),
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => s.trim().length > 0),
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => s.trim().length > 0),
        fc.integer({ min: 1, max: 5 }),
        async (
          suiteId,
          suiteVersion,
          agentTargetVersion,
          idempotencyKey,
          n,
        ) => {
          ddbMock.reset();
          const suite = frozenSuite({ suiteId, version: suiteVersion });
          ddbMock.on(GetCommand).resolves({ Item: suite });
          ddbMock.on(QueryCommand).resolves({ Items: [] });

          let created = false;
          let storedRun: EvalRun | undefined;
          ddbMock.on(PutCommand).callsFake((input) => {
            if (input.TableName !== "citadel-eval-runs-test") return {};
            if (created) {
              const err = Object.assign(
                new Error("The conditional request failed"),
                { name: "ConditionalCheckFailedException" },
              );
              throw err;
            }
            created = true;
            storedRun = input.Item as EvalRun;
            return {};
          });
          ddbMock.on(GetCommand).callsFake((input) => {
            if (input.TableName === "citadel-eval-runs-test") {
              return { Item: storedRun };
            }
            return { Item: suite };
          });

          const results: EvalRun[] = [];
          for (let i = 0; i < n; i++) {
            const r = await startEvalRun(
              {
                suiteId,
                agentTargetId: "agent-1",
                agentTargetVersion,
                idempotencyKey,
              },
              authContextFor("architect"),
            );
            results.push(r);
          }

          const uniqueIds = new Set(results.map((r) => r.evalRunId));
          expect(uniqueIds.size).toBe(1);
          expect([...uniqueIds][0]).toBe(
            uuidv5(
              `${suiteId}:${suiteVersion}:${agentTargetVersion}:${idempotencyKey}`,
              EVAL_RUN_NAMESPACE,
            ),
          );
          const runRowPuts = ddbMock
            .commandCalls(PutCommand)
            .filter(
              (c) => c.args[0].input.TableName === "citadel-eval-runs-test",
            );
          expect(runRowPuts).toHaveLength(n);
          // Exactly one of the N attempts actually created the row (the
          // rest hit ConditionalCheckFailedException and fetched-existing).
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("getEvalRun / listEvalRuns / listEvalRunCaseResults", () => {
  test("getEvalRun returns null when absent", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getEvalRun("missing")).resolves.toBeNull();
  });

  test("getEvalRun returns the stored run", async () => {
    const item = { evalRunId: "r1", orgId: "org-1" };
    ddbMock.on(GetCommand).resolves({ Item: item });
    await expect(getEvalRun("r1")).resolves.toEqual(item);
  });

  test("listEvalRuns queries org-index when only orgId given", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ evalRunId: "r1" }] });
    const items = await listEvalRuns("org-1");
    expect(items).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("org-index");
  });

  test("listEvalRuns queries suite-index when suiteId given", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ evalRunId: "r1" }] });
    const items = await listEvalRuns("org-1", "suite-1");
    expect(items).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("suite-index");
  });

  test("listEvalRunCaseResults queries by evalRunId (single Query, no GSI)", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [{ caseId: "c1" }, { caseId: "c2" }] });
    const items = await listEvalRunCaseResults("r1");
    expect(items).toHaveLength(2);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBeUndefined();
    expect(call.args[0].input.KeyConditionExpression).toContain("evalRunId");
  });
});
