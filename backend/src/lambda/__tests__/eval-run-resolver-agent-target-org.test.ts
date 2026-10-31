/**
 * C14: agentTargetId org-binding tests for eval-run-resolver.
 *
 * startEvalRun must resolve input.agentTargetId to its agent-configs row
 * and require row.orgId === suite.orgId || 'All Organizations'. Identical
 * error for missing and foreign targets — no existence oracle across
 * tenants.
 */
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext, EvalSuite } from "../../types";

process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.AGENT_CONFIGS_TABLE = "citadel-agents-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import { startEvalRun } from "../eval-run-resolver";

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
    orgId: "org-A",
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

const DEFAULT_INPUT = {
  suiteId: "suite-1",
  agentTargetId: "agent-target-1",
  agentTargetVersion: "v1",
  idempotencyKey: "key-1",
};

beforeEach(() => {
  ddbMock.reset();
});

/**
 * Helper to configure DDB mock for the standard flow:
 * - GetCommand on suites table → frozen suite
 * - GetCommand on agents table → agent row
 * - QueryCommand on cases table → empty cases
 * - PutCommand → success
 * - GetCommand on runs table → null (for conflict-fetch path)
 */
function setupMocks(opts: {
  suite?: EvalSuite;
  agentRow?: Record<string, unknown> | undefined;
}) {
  const suite = opts.suite ?? frozenSuite();

  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === "citadel-eval-suites-test") {
      return { Item: suite };
    }
    if (input.TableName === "citadel-agents-test") {
      return { Item: opts.agentRow };
    }
    if (input.TableName === "citadel-eval-runs-test") {
      return { Item: undefined };
    }
    return { Item: undefined };
  });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(PutCommand).resolves({});
}

describe("C14 — agentTargetId org binding", () => {
  it("rejects agentTargetId belonging to a different org", async () => {
    setupMocks({
      agentRow: { agentId: "agent-target-1", orgId: "org-B" },
    });

    await expect(
      startEvalRun(DEFAULT_INPUT, authContextFor("architect")),
    ).rejects.toThrow("ValidationError: agentTargetId not found");
  });

  it("rejects agentTargetId that does not exist (null row)", async () => {
    setupMocks({
      agentRow: undefined,
    });

    await expect(
      startEvalRun(DEFAULT_INPUT, authContextFor("architect")),
    ).rejects.toThrow("ValidationError: agentTargetId not found");
  });

  it("accepts agentTargetId in same org as suite", async () => {
    setupMocks({
      agentRow: { agentId: "agent-target-1", orgId: "org-A" },
    });

    const run = await startEvalRun(
      DEFAULT_INPUT,
      authContextFor("architect"),
    );
    expect(run.evalRunId).toBeDefined();
    expect(run.status).toBe("PENDING");
  });

  it('accepts agentTargetId with orgId "All Organizations" (system-seeded)', async () => {
    setupMocks({
      agentRow: {
        agentId: "agent-target-1",
        orgId: "All Organizations",
      },
    });

    const run = await startEvalRun(
      DEFAULT_INPUT,
      authContextFor("architect"),
    );
    expect(run.evalRunId).toBeDefined();
  });

  it("produces identical error for missing vs foreign target (no existence oracle)", async () => {
    // Missing target
    setupMocks({ agentRow: undefined });
    const missingErr = await startEvalRun(
      DEFAULT_INPUT,
      authContextFor("architect"),
    ).catch((e: Error) => e.message);

    // Foreign target
    ddbMock.reset();
    setupMocks({
      agentRow: { agentId: "agent-target-1", orgId: "org-B" },
    });
    const foreignErr = await startEvalRun(
      DEFAULT_INPUT,
      authContextFor("architect"),
    ).catch((e: Error) => e.message);

    expect(missingErr).toBe(foreignErr);
    expect(missingErr).toBe("ValidationError: agentTargetId not found");
  });

  it("rejects agentTargetId with absent orgId on the row (fail-closed)", async () => {
    setupMocks({
      agentRow: { agentId: "agent-target-1" }, // no orgId
    });

    await expect(
      startEvalRun(DEFAULT_INPUT, authContextFor("architect")),
    ).rejects.toThrow("ValidationError: agentTargetId not found");
  });

  it("rejects agentTargetId with empty-string orgId on the row", async () => {
    setupMocks({
      agentRow: { agentId: "agent-target-1", orgId: "" },
    });

    await expect(
      startEvalRun(DEFAULT_INPUT, authContextFor("architect")),
    ).rejects.toThrow("ValidationError: agentTargetId not found");
  });
});
