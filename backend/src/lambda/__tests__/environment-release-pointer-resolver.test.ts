/**
 * environment-release-pointer-resolver.test.ts — promoteEnvironmentReleasePointer
 * mutation and the two read queries.
 *
 * Structural mirror of release-resolver.test.ts's conventions: mocked DDB
 * client, authContext fixtures per role, direct function calls (not the
 * AppSync `handler` dispatch, except where explicitly noted).
 *
 * The store module (environment-release-pointer-store.ts) is exercised
 * through its real, unmocked exports — this suite never mocks
 * setEnvironmentReleasePointer/getEnvironmentReleasePointer directly, only
 * the DynamoDB client underneath, so the optimistic-locking guarantee
 * stays load-bearing for these tests too.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext, AgentRelease, EvalSuite } from "../../types";

process.env.AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.GOVERNANCE_LEDGER_TABLE = "citadel-governance-ledger-test";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  promoteEnvironmentReleasePointer,
  getCurrentEnvironmentReleasePointer,
  listEnvironmentReleasePointers,
  validateReleaseGate,
  handler,
} from "../environment-release-pointer-resolver";
import * as governanceFlag from "../../utils/governance-flag";
import * as releaseGateEvidence from "../utils/release-gate-evidence";
import * as releaseGateFindingWriter from "../utils/release-gate-finding-writer";
import type { ReleaseGateInputs } from "../utils/release-gate";

function evalSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    suiteId: "suite-1",
    orgId: "org-1",
    version: 1,
    status: "FROZEN",
    ...overrides,
  } as EvalSuite;
}

function authContextFor(role: string): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function release(overrides: Partial<AgentRelease> = {}): AgentRelease {
  return {
    releaseId: "release-1",
    orgId: "org-1",
    agentTargetId: "agent-1",
    semver: "1.0.0",
    agentConfig: { sourceId: "rec-1", content: "{}", digest: "d" },
    promptVersions: {},
    execSpecId: "spec-1",
    execSpecVersion: 1,
    modelConfigSnapshots: [],
    toolConfigs: [],
    policySnapshot: {
      enforcementMode: "strict",
      ruleSetVersion: "1",
      authorityUnitGrantIds: [],
    },
    evalEvidence: {
      evalRunId: "run-1",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 1,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "architect-1",
    gitSha: "abc123",
    region: "us-east-1",
    runId: "runid-1",
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  jest.restoreAllMocks();
  governanceFlag.__resetGovernanceFlagCacheForTest();
});

/** Convenience: stub the evidence resolver to return a fixed
 * ReleaseGateInputs shape (Slice 3 tests exercise the WIRING —
 * evidence-resolution correctness is Slice 2's own test file). */
function stubEvidence(inputs: ReleaseGateInputs) {
  jest
    .spyOn(releaseGateEvidence, "resolveReleaseGateEvidence")
    .mockResolvedValue({ ok: true, inputs });
}

function passingInputs(): ReleaseGateInputs {
  return {
    hasBaseline: true,
    comparisonVerdict: {
      verdictStatus: "PASS",
      anyMaterialRegression: false,
      materiallyRegressedDimensions: [],
      dimensions: [],
    } as never,
    candidateAggregates: [
      {
        dimension: "task_success",
        passRate: 1.0,
        scoredCount: 10,
        passedCount: 10,
      },
    ] as never,
    pinnedSuiteVersion: 1,
    liveSuite: evalSuite(),
    runCompletedAt: "2026-01-01T00:00:00.000Z",
    now: "2026-01-01T01:00:00.000Z",
    policy: {
      taskSuccessMin: 0.9,
      policyComplianceMin: 1.0,
      latencyP95TargetMs: 5000,
      avgCostBudgetUsd: 1.0,
      minSampleCount: 5,
      requiredGateClasses: [],
      maxEvidenceAgeDays: 7,
      allowNoBaselineOnAbsoluteFloors: false,
    },
  };
}

function failingInputs(): ReleaseGateInputs {
  return {
    ...passingInputs(),
    comparisonVerdict: {
      verdictStatus: "REGRESSED",
      anyMaterialRegression: true,
      materiallyRegressedDimensions: ["task_success"],
      dimensions: [],
    } as never,
  };
}

describe("validateReleaseGate — real async signature", () => {
  const architect = authContextFor("architect");

  test("has a real async signature — returns a Promise, not undefined", () => {
    stubEvidence(passingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("permissive");

    const result = validateReleaseGate(release(), "PROD", "org-1", architect);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  test("PASS verdict resolves without throwing in every mode", async () => {
    stubEvidence(passingInputs());
    for (const mode of ["permissive", "shadow", "strict"] as const) {
      jest
        .spyOn(governanceFlag, "getGovernanceEnforce")
        .mockResolvedValue(mode);
      await expect(
        validateReleaseGate(release(), "PROD", "org-1", architect),
      ).resolves.toBeUndefined();
    }
  });
});

describe("validateReleaseGate — mode literal contract (guards Python/TS drift)", () => {
  const architect = authContextFor("architect");

  test.each(["permissive", "shadow", "strict"] as const)(
    "mode=%s is a recognized literal accepted by validateReleaseGate",
    async (mode) => {
      stubEvidence(passingInputs());
      jest
        .spyOn(governanceFlag, "getGovernanceEnforce")
        .mockResolvedValue(mode);
      await expect(
        validateReleaseGate(release(), "PROD", "org-1", architect),
      ).resolves.toBeUndefined();
    },
  );

  test("permissive: FAIL verdict does NOT block, and does NOT write a finding (telemetry only)", async () => {
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("permissive");
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("shadow: FAIL verdict writes a finding but does NOT block", async () => {
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("shadow");
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).resolves.toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toMatchObject({
      decision: "deny",
      mode: "shadow",
    });
  });

  test("strict: FAIL verdict writes a finding AND blocks (throws)", async () => {
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("strict");
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).rejects.toThrow(/ReleaseGateError|quality gate/i);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toMatchObject({
      decision: "deny",
      mode: "strict",
    });
  });

  test("the verdict is computed IDENTICALLY across all three modes — evidence resolver called once per mode with the same inputs", async () => {
    const evidence = passingInputs();
    const evidenceSpy = jest
      .spyOn(releaseGateEvidence, "resolveReleaseGateEvidence")
      .mockResolvedValue({ ok: true, inputs: evidence });

    for (const mode of ["permissive", "shadow", "strict"] as const) {
      jest
        .spyOn(governanceFlag, "getGovernanceEnforce")
        .mockResolvedValue(mode);
      await validateReleaseGate(release(), "PROD", "org-1", architect);
    }

    // Called once per mode iteration — same evidence, same evaluation
    // path, not skipped for permissive.
    expect(evidenceSpy).toHaveBeenCalledTimes(3);
  });

  test("PASS verdict: never blocks in any mode; a finding is written only when the mode's disposition records (shadow/strict), never in permissive", async () => {
    stubEvidence(passingInputs());
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("permissive");
    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();

    for (const mode of ["shadow", "strict"] as const) {
      jest
        .spyOn(governanceFlag, "getGovernanceEnforce")
        .mockResolvedValue(mode);
      await expect(
        validateReleaseGate(release(), "PROD", "org-1", architect),
      ).resolves.toBeUndefined();
    }
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls[0][0]).toMatchObject({ decision: "permit" });
    expect(writeSpy.mock.calls[1][0]).toMatchObject({ decision: "permit" });
  });
});

describe("validateReleaseGate — ordering and failure independence (design item 5)", () => {
  const architect = authContextFor("architect");

  // UPDATED for finding 23971f32 (fail-closed in both modes): previously
  // this asserted the refusal came from the FAIL verdict specifically
  // (ReleaseGateError), independent of the write's own error surfacing.
  // Under unified fail-closed, a write failure now propagates AS ITSELF
  // rather than being swallowed — so for a FAIL verdict, the promotion
  // is refused either way (the caller never proceeds), but the thrown
  // error is the ledger write's own error, not a ReleaseGateError. The
  // load-bearing guarantee this test protects — "the promotion never
  // slips through" — still holds; only the specific rejection identity
  // changed, which is intentional (see the resolver's module doc,
  // ORDERING AND FAILURE section).
  test("strict, FAIL verdict: the promotion is still refused when the ledger write fails — surfaces the write's own error under fail-closed", async () => {
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("strict");
    jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockRejectedValue(new Error("GOVERNANCE_LEDGER_TABLE unavailable"));

    // Must still refuse the promotion — a telemetry failure must never
    // let it proceed. Fail-closed means the caller sees the write's own
    // error rather than a ReleaseGateError in this scenario.
    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).rejects.toThrow(/GOVERNANCE_LEDGER_TABLE unavailable/);
  });

  test("shadow: a failed finding write is surfaced (thrown), not swallowed — it is the SOLE record of a would-block", async () => {
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("shadow");
    jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockRejectedValue(new Error("GOVERNANCE_LEDGER_TABLE unavailable"));

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).rejects.toThrow(/GOVERNANCE_LEDGER_TABLE unavailable/);
  });

  // Finding 23971f32 regression coverage: the PREVIOUS strict-mode
  // try/catch swallowed exactly this case (a PASS verdict, so `shouldBlock`
  // is false, so nothing else would have thrown) — a passing promotion
  // would have proceeded UNRECORDED. USER DECISION: fail-closed in BOTH
  // modes means a write failure must abort the promotion regardless of
  // the underlying verdict.
  test("strict, PASS verdict: a failed finding write now aborts the promotion — fail-closed, not swallowed (finding 23971f32 regression)", async () => {
    stubEvidence(passingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("strict");
    jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockRejectedValue(new Error("GOVERNANCE_LEDGER_TABLE unavailable"));

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).rejects.toThrow(/GOVERNANCE_LEDGER_TABLE unavailable/);
  });

  test("shadow, PASS verdict: a failed finding write aborts the promotion — same fail-closed posture as strict", async () => {
    stubEvidence(passingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("shadow");
    jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockRejectedValue(new Error("GOVERNANCE_LEDGER_TABLE unavailable"));

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).rejects.toThrow(/GOVERNANCE_LEDGER_TABLE unavailable/);
  });

  // Dedupe must never abort — the ConditionalCheckFailedException swallow
  // lives inside writeReleaseGateFinding itself (see
  // release-gate-finding-writer.test.ts's own dedupe coverage); this
  // asserts the caller-side contract: a resolved (non-rejected) write
  // call — which is what a dedupe-swallowed write looks like from
  // validateReleaseGate's point of view — never blocks a PASS promotion.
  test("dedupe (writer resolves normally on a swallowed ConditionalCheckFailedException) does NOT abort the promotion", async () => {
    stubEvidence(passingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("strict");
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).resolves.toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test("permissive: never attempts a finding write, so a ledger outage cannot affect permissive-mode promotions", async () => {
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("permissive");
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockRejectedValue(new Error("GOVERNANCE_LEDGER_TABLE unavailable"));

    await expect(
      validateReleaseGate(release(), "PROD", "org-1", architect),
    ).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("promoteEnvironmentReleasePointer — gate wiring position + zero-write-on-refusal (design item 1)", () => {
  const architect = authContextFor("architect");

  test("strict FAIL: pointer write is never attempted — zero PutCommand calls, not merely an unchanged value", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({ Item: release() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("strict");
    jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "PROD",
          releaseId: "release-1",
        },
        architect,
        "org-1",
      ),
    ).rejects.toThrow(/ReleaseGateError|quality gate/i);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("shadow FAIL: pointer write STILL proceeds (shadow never blocks)", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({ Item: release() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    stubEvidence(failingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("shadow");
    jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    const result = await promoteEnvironmentReleasePointer(
      {
        agentTargetId: "agent-1",
        environment: "PROD",
        releaseId: "release-1",
      },
      architect,
      "org-1",
    );
    expect(result.releaseId).toBe("release-1");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("PASS verdict: pointer write proceeds and a PERMIT finding is written in shadow/strict", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({ Item: release() });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    stubEvidence(passingInputs());
    jest
      .spyOn(governanceFlag, "getGovernanceEnforce")
      .mockResolvedValue("strict");
    const writeSpy = jest
      .spyOn(releaseGateFindingWriter, "writeReleaseGateFinding")
      .mockResolvedValue(undefined);

    const result = await promoteEnvironmentReleasePointer(
      {
        agentTargetId: "agent-1",
        environment: "PROD",
        releaseId: "release-1",
      },
      architect,
      "org-1",
    );
    expect(result.releaseId).toBe("release-1");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toMatchObject({ decision: "permit" });
  });

  test("gate runs AFTER permission/existence/org checks — an unauthorized caller never reaches evidence resolution", async () => {
    const evidenceSpy = jest.spyOn(
      releaseGateEvidence,
      "resolveReleaseGateEvidence",
    );

    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "PROD",
          releaseId: "release-1",
        },
        authContextFor("developer"),
        "org-1",
      ),
    ).rejects.toThrow(/UnauthorizedError/);

    expect(evidenceSpy).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("gate runs AFTER existence/org checks — a nonexistent release never reaches evidence resolution", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({ Item: undefined });
    const evidenceSpy = jest.spyOn(
      releaseGateEvidence,
      "resolveReleaseGateEvidence",
    );

    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "PROD",
          releaseId: "release-missing",
        },
        architect,
        "org-1",
      ),
    ).rejects.toThrow(/ValidationError/);

    expect(evidenceSpy).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("validateReleaseGate", () => {
  test("legacy zero-arg no-op form no longer applies — the real signature requires release/environment/orgId/authContext", () => {
    // Retained as documentation that the seam's SHAPE changed in Slice 3:
    // validateReleaseGate is no longer callable with zero arguments. A
    // TypeScript compile error is the real enforcement here (see
    // tsc --noEmit); this test only documents intent for a reader
    // skimming the suite.
    expect(typeof validateReleaseGate).toBe("function");
    expect(validateReleaseGate.length).toBeGreaterThanOrEqual(4);
  });
});

describe("promoteEnvironmentReleasePointer — permission gate", () => {
  test("rejects a caller without release:promote before touching DynamoDB", async () => {
    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-1",
        },
        authContextFor("developer"),
        "org-1",
      ),
    ).rejects.toThrow(/UnauthorizedError/);

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("architect role (release:promote) is allowed through the gate", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: release(),
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const result = await promoteEnvironmentReleasePointer(
      {
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-1",
      },
      authContextFor("architect"),
      "org-1",
    );

    expect(result.releaseId).toBe("release-1");
  });
});

describe("promoteEnvironmentReleasePointer — release existence + org validation", () => {
  const architect = authContextFor("architect");

  test("rejects when the target release does not exist", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: undefined,
      });

    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-missing",
        },
        architect,
        "org-1",
      ),
    ).rejects.toThrow(/ValidationError/);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("rejects when the target release belongs to a different org", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: release({ orgId: "org-OTHER" }),
      });

    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-1",
        },
        architect,
        "org-1",
      ),
    ).rejects.toThrow(/SecurityError/);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("accepts a same-org, existing release and writes the pointer", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: release({ orgId: "org-1" }),
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const result = await promoteEnvironmentReleasePointer(
      { agentTargetId: "agent-1", environment: "PROD", releaseId: "release-1" },
      architect,
      "org-1",
    );

    expect(result.orgId).toBe("org-1");
    expect(result.environment).toBe("PROD");
    expect(result.releaseId).toBe("release-1");
    expect(result.previousReleaseId).toBeNull();
    expect(result.version).toBe(1);
  });
});

describe("promoteEnvironmentReleasePointer — moving an existing pointer", () => {
  const architect = authContextFor("architect");

  test("retains previousReleaseId from the current pointer and bumps version", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: release({ orgId: "org-1", releaseId: "release-2" }),
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({
        Item: {
          orgId: "org-1",
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-1",
          previousReleaseId: null,
          promotedAt: "2026-01-01T00:00:00.000Z",
          promotedBy: "user-architect-old",
          version: 1,
        },
      });
    ddbMock.on(PutCommand).resolves({});

    const result = await promoteEnvironmentReleasePointer(
      {
        agentTargetId: "agent-1",
        environment: "STAGING",
        releaseId: "release-2",
      },
      architect,
      "org-1",
    );

    expect(result.previousReleaseId).toBe("release-1");
    expect(result.releaseId).toBe("release-2");
    expect(result.version).toBe(2);

    const putCall = ddbMock
      .commandCalls(PutCommand)
      .find(
        (call) =>
          call.args[0].input.TableName ===
          "citadel-environment-release-pointers-test",
      )!.args[0].input;
    expect(putCall.ConditionExpression).toBe(
      "attribute_not_exists(orgId) OR #version = :expectedVersion",
    );
    expect(putCall.ExpressionAttributeValues).toMatchObject({
      ":expectedVersion": 1,
    });
  });

  test("surfaces ConcurrentPromotionError as a distinct, catchable error when two promotions race", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: release({ orgId: "org-1", releaseId: "release-2" }),
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({
        Item: {
          orgId: "org-1",
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-1",
          previousReleaseId: null,
          promotedAt: "2026-01-01T00:00:00.000Z",
          promotedBy: "user-architect-old",
          version: 1,
        },
      });
    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(PutCommand).rejects(conditionalError);

    await expect(
      promoteEnvironmentReleasePointer(
        {
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-2",
        },
        architect,
        "org-1",
      ),
    ).rejects.toThrow(/ConcurrentPromotionError/);
  });
});

describe("getCurrentEnvironmentReleasePointer", () => {
  test("returns null when nothing has been promoted yet", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getCurrentEnvironmentReleasePointer(
      "org-1",
      "agent-1",
      "PROD",
    );

    expect(result).toBeNull();
  });

  test("returns the current pointer row for an agent+environment", async () => {
    const pointer = {
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "PROD" as const,
      releaseId: "release-9",
      previousReleaseId: "release-8",
      promotedAt: "2026-01-01T00:00:00.000Z",
      promotedBy: "user-architect",
      version: 4,
    };
    ddbMock.on(GetCommand).resolves({ Item: pointer });

    const result = await getCurrentEnvironmentReleasePointer(
      "org-1",
      "agent-1",
      "PROD",
    );

    expect(result).toEqual(pointer);
  });
});

describe("listEnvironmentReleasePointers", () => {
  test("returns every environment's pointer for the agent", async () => {
    const staging = {
      orgId: "org-1",
      agentTargetId: "agent-1",
      environment: "STAGING" as const,
      releaseId: "release-5",
      previousReleaseId: null,
      promotedAt: "2026-01-01T00:00:00.000Z",
      promotedBy: "user-architect",
      version: 1,
    };
    const prod = {
      ...staging,
      environment: "PROD" as const,
      releaseId: "release-3",
      version: 2,
    };
    ddbMock.on(QueryCommand).resolves({ Items: [staging, prod] });

    const result = await listEnvironmentReleasePointers("org-1", "agent-1");

    expect(result).toEqual([staging, prod]);
  });
});

describe("handler — AppSync dispatch", () => {
  test("routes promoteEnvironmentReleasePointer through the custom:organization claim", async () => {
    ddbMock
      .on(GetCommand, { TableName: "citadel-agent-releases-test" })
      .resolves({
        Item: release({ orgId: "org-1" }),
      });
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-environment-release-pointers-test",
      })
      .resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      info: { fieldName: "promoteEnvironmentReleasePointer" },
      identity: {
        sub: "user-1",
        "custom:role": "architect",
        "custom:organization": "org-1",
      },
      arguments: {
        input: {
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-1",
        },
      },
    };

    const result = (await handler(event as never)) as { releaseId: string };
    expect(result.releaseId).toBe("release-1");
  });

  test("rejects when the caller organization cannot be determined", async () => {
    const event = {
      info: { fieldName: "promoteEnvironmentReleasePointer" },
      identity: { sub: "user-1", "custom:role": "architect" },
      arguments: {
        input: {
          agentTargetId: "agent-1",
          environment: "STAGING",
          releaseId: "release-1",
        },
      },
    };

    await expect(handler(event as never)).rejects.toThrow(/ValidationError/);
  });

  test("throws for an unsupported field name", async () => {
    const event = {
      info: { fieldName: "somethingElse" },
      identity: {},
      arguments: {},
    };
    await expect(handler(event as never)).rejects.toThrow(/Unsupported field/);
  });
});
