/**
 * Canary handlers on environment-release-pointer-resolver.ts (decision D2,
 * attribution-only). Mirrors environment-release-pointer-resolver.test.ts's
 * conventions (mocked DDB client, permissive gate + stubbed evidence so the
 * gate is a clean pass, real unmocked store underneath).
 *
 * Covers: D4 (promoteCanary re-runs the full gate), D5 (org ceiling,
 * fail-closed), D6 (release:canary for start/reweight/abort; promoteCanary
 * ALSO requires release:promote), D7 (canary start applies the same ladder
 * adjacency as promotion), D3 (reweight preserves the salt), and the
 * no-active-canary state errors.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type {
  AgentRelease,
  AuthContext,
  EnvironmentLiteral,
  EnvironmentReleasePointer,
} from "../../types";

process.env.AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";
process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE =
  "citadel-environment-release-pointer-history-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.GOVERNANCE_LEDGER_TABLE = "citadel-governance-ledger-test";
process.env.PROMOTION_POLICY_CONFIG_TABLE =
  "citadel-promotion-policy-config-test";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  startCanary,
  reweightCanary,
  promoteCanary,
  abortCanary,
  CanaryCeilingError,
  CanaryStateError,
  PromotionLadderError,
} from "../environment-release-pointer-resolver";
import * as auth from "../../utils/auth";
import * as governanceFlag from "../../utils/governance-flag";
import * as releaseGateEvidence from "../utils/release-gate-evidence";
import type { ReleaseGateInputs } from "../utils/release-gate";
import { DEFAULT_PROMOTION_POLICY } from "../utils/release-gate";

const AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
const POINTERS_TABLE = "citadel-environment-release-pointers-test";
const POLICY_TABLE = "citadel-promotion-policy-config-test";

function authContextFor(role: string): AuthContext {
  return { userId: `user-${role}`, username: role, groups: [], roles: [role] };
}

function release(overrides: Partial<AgentRelease> = {}): AgentRelease {
  return {
    releaseId: "release-candidate",
    orgId: "org-1",
    agentTargetId: "agent-1",
    semver: "2.0.0",
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

function pointer(
  overrides: Partial<EnvironmentReleasePointer> = {},
): EnvironmentReleasePointer {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "DEV",
    releaseId: "release-stable",
    previousReleaseId: null,
    promotedAt: "2026-01-01T00:00:00.000Z",
    promotedBy: "user-architect",
    version: 2,
    ...overrides,
  };
}

/** Stub the (agent, env) current pointer GetCommand. */
function stubCurrentPointer(
  environment: EnvironmentLiteral,
  item: EnvironmentReleasePointer | undefined,
): void {
  ddbMock
    .on(GetCommand, {
      TableName: POINTERS_TABLE,
      Key: {
        orgId: "org-1",
        agentTargetId_environment: `agent-1#${environment}`,
      },
    })
    .resolves({ Item: item });
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
    liveSuite: {
      suiteId: "suite-1",
      orgId: "org-1",
      version: 1,
      status: "FROZEN",
    } as never,
    runCompletedAt: "2026-01-01T00:00:00.000Z",
    now: "2026-01-01T00:00:00.000Z",
    policy: DEFAULT_PROMOTION_POLICY,
  };
}

beforeEach(() => {
  ddbMock.reset();
  jest.restoreAllMocks();
  governanceFlag.__resetGovernanceFlagCacheForTest();
  // Permissive mode + passing evidence => the gate resolves clean without
  // blocking or writing findings, so canary-specific behaviour is isolated.
  jest
    .spyOn(governanceFlag, "getGovernanceEnforce")
    .mockResolvedValue("permissive");
  jest
    .spyOn(releaseGateEvidence, "resolveReleaseGateEvidence")
    .mockResolvedValue({ ok: true, inputs: passingInputs() });
  // Grant both permissions by default; individual tests override.
  jest.spyOn(auth, "hasPermission").mockReturnValue(true);
  // Default: no promotion-policy row => DEFAULT_PROMOTION_POLICY
  // (canaryMaxBasisPoints=2500).
  ddbMock
    .on(GetCommand, { TableName: POLICY_TABLE })
    .resolves({ Item: undefined });
  // Candidate release exists by default.
  ddbMock
    .on(GetCommand, { TableName: AGENT_RELEASES_TABLE })
    .resolves({ Item: release() });
  ddbMock.on(TransactWriteCommand).resolves({});
});

function transactPointerPut() {
  const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input as {
    TransactItems: {
      Put: { TableName: string; Item: Record<string, unknown> };
    }[];
  };
  return input.TransactItems.map((t) => t.Put).find(
    (p) => p.TableName === POINTERS_TABLE,
  )!;
}

describe("startCanary", () => {
  it("starts a canary on the stable pointer with a minted salt and CANARY_START (DEV, D2/D3)", async () => {
    stubCurrentPointer("DEV", pointer());
    const result = await startCanary(
      {
        agentTargetId: "agent-1",
        environment: "DEV",
        candidateReleaseId: "release-candidate",
        percentBasisPoints: 1000,
        stickiness: "conversation",
      },
      authContextFor("architect"),
      "org-1",
    );
    expect(result.releaseId).toBe("release-stable"); // stable arm unchanged
    expect(result.canary?.candidateReleaseId).toBe("release-candidate");
    expect(result.canary?.percentBasisPoints).toBe(1000);
    expect(typeof result.canary?.salt).toBe("string");
    expect(result.canary?.salt?.length).toBeGreaterThan(0);
    expect(result.transitionType).toBe("CANARY_START");
  });

  it("refuses without release:canary permission (D6)", async () => {
    jest.spyOn(auth, "hasPermission").mockReturnValue(false);
    await expect(
      startCanary(
        {
          agentTargetId: "agent-1",
          environment: "DEV",
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 1000,
          stickiness: "conversation",
        },
        authContextFor("developer"),
        "org-1",
      ),
    ).rejects.toThrow(/release:canary/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("refuses a percent above the org ceiling, fail-closed, with zero writes (D5)", async () => {
    stubCurrentPointer("DEV", pointer());
    ddbMock
      .on(GetCommand, { TableName: POLICY_TABLE })
      .resolves({
        Item: { orgId: "org-1", policy: { canaryMaxBasisPoints: 2000 } },
      });
    await expect(
      startCanary(
        {
          agentTargetId: "agent-1",
          environment: "DEV",
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 3000,
          stickiness: "conversation",
        },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(CanaryCeilingError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("uses the DEFAULT 2500bp ceiling when no org policy is configured (D5 default)", async () => {
    stubCurrentPointer("DEV", pointer());
    await expect(
      startCanary(
        {
          agentTargetId: "agent-1",
          environment: "DEV",
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 2501, // just over the default 2500
          stickiness: "conversation",
        },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(CanaryCeilingError);
  });

  it("applies the same ladder adjacency as a promotion and refuses when predecessor differs (D7)", async () => {
    stubCurrentPointer("PROD", pointer({ environment: "PROD" }));
    // STAGING (predecessor) points at a DIFFERENT release than the candidate.
    ddbMock
      .on(GetCommand, {
        TableName: POINTERS_TABLE,
        Key: { orgId: "org-1", agentTargetId_environment: "agent-1#STAGING" },
      })
      .resolves({
        Item: pointer({ environment: "STAGING", releaseId: "release-other" }),
      });
    await expect(
      startCanary(
        {
          agentTargetId: "agent-1",
          environment: "PROD",
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 1000,
          stickiness: "conversation",
        },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(PromotionLadderError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("refuses when there is no current stable pointer to canary against", async () => {
    stubCurrentPointer("DEV", undefined);
    await expect(
      startCanary(
        {
          agentTargetId: "agent-1",
          environment: "DEV",
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 1000,
          stickiness: "conversation",
        },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(CanaryStateError);
  });
});

describe("reweightCanary", () => {
  it("preserves the salt and only moves the threshold (D3)", async () => {
    stubCurrentPointer(
      "DEV",
      pointer({
        canary: {
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 1000,
          stickiness: "conversation",
          salt: "salt-preserved",
          startedAt: "2026-02-01T00:00:00.000Z",
          startedBy: "user-architect",
        },
      }),
    );
    const result = await reweightCanary(
      {
        agentTargetId: "agent-1",
        environment: "DEV",
        percentBasisPoints: 2000,
      },
      authContextFor("architect"),
      "org-1",
    );
    expect(result.canary?.salt).toBe("salt-preserved"); // NOT re-minted
    expect(result.canary?.percentBasisPoints).toBe(2000);
    expect(result.transitionType).toBe("CANARY_REWEIGHT");
  });

  it("refuses when no canary is active", async () => {
    stubCurrentPointer("DEV", pointer()); // no canary
    await expect(
      reweightCanary(
        {
          agentTargetId: "agent-1",
          environment: "DEV",
          percentBasisPoints: 2000,
        },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(CanaryStateError);
  });
});

describe("promoteCanary", () => {
  function activeCanaryPointer(environment: EnvironmentLiteral = "DEV") {
    return pointer({
      environment,
      canary: {
        candidateReleaseId: "release-candidate",
        percentBasisPoints: 1000,
        stickiness: "conversation",
        salt: "salt-A",
        startedAt: "2026-02-01T00:00:00.000Z",
        startedBy: "user-architect",
      },
    });
  }

  it("cuts stable := candidate, clears the canary, CANARY_PROMOTE (D4 happy path)", async () => {
    stubCurrentPointer("DEV", activeCanaryPointer());
    const result = await promoteCanary(
      { agentTargetId: "agent-1", environment: "DEV" },
      authContextFor("architect"),
      "org-1",
    );
    expect(result.releaseId).toBe("release-candidate");
    expect(result.previousReleaseId).toBe("release-stable");
    expect(result.canary).toBeUndefined();
    expect(result.transitionType).toBe("CANARY_PROMOTE");
    const put = transactPointerPut();
    expect(Object.prototype.hasOwnProperty.call(put.Item, "canary")).toBe(
      false,
    );
  });

  it("requires release:promote IN ADDITION to release:canary (D6)", async () => {
    stubCurrentPointer("DEV", activeCanaryPointer());
    // Grant release:canary but NOT release:promote.
    jest
      .spyOn(auth, "hasPermission")
      .mockImplementation(
        (_ctx, permission) => permission === "release:canary",
      );
    await expect(
      promoteCanary(
        { agentTargetId: "agent-1", environment: "DEV" },
        authContextFor("canary-operator"),
        "org-1",
      ),
    ).rejects.toThrow(/release:promote/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("re-runs ladder adjacency at promote (D4) and refuses on predecessor drift", async () => {
    stubCurrentPointer("PROD", activeCanaryPointer("PROD"));
    ddbMock
      .on(GetCommand, {
        TableName: POINTERS_TABLE,
        Key: { orgId: "org-1", agentTargetId_environment: "agent-1#STAGING" },
      })
      .resolves({
        Item: pointer({ environment: "STAGING", releaseId: "release-drifted" }),
      });
    await expect(
      promoteCanary(
        { agentTargetId: "agent-1", environment: "PROD" },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(PromotionLadderError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("refuses when no canary is active", async () => {
    stubCurrentPointer("DEV", pointer());
    await expect(
      promoteCanary(
        { agentTargetId: "agent-1", environment: "DEV" },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(CanaryStateError);
  });
});

describe("abortCanary", () => {
  it("reverts to stable at 0%, clears the canary, CANARY_ABORT", async () => {
    stubCurrentPointer(
      "DEV",
      pointer({
        canary: {
          candidateReleaseId: "release-candidate",
          percentBasisPoints: 1000,
          stickiness: "conversation",
          salt: "salt-A",
          startedAt: "2026-02-01T00:00:00.000Z",
          startedBy: "user-architect",
        },
      }),
    );
    const result = await abortCanary(
      { agentTargetId: "agent-1", environment: "DEV" },
      authContextFor("architect"),
      "org-1",
    );
    expect(result.releaseId).toBe("release-stable"); // unchanged
    expect(result.canary).toBeUndefined();
    expect(result.transitionType).toBe("CANARY_ABORT");
  });

  it("refuses when no canary is active", async () => {
    stubCurrentPointer("DEV", pointer());
    await expect(
      abortCanary(
        { agentTargetId: "agent-1", environment: "DEV" },
        authContextFor("architect"),
        "org-1",
      ),
    ).rejects.toThrow(CanaryStateError);
  });
});
