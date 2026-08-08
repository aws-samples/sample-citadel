/**
 * release-resolver.test.ts — cutAgentRelease assembly operation (slice 2).
 *
 * Structural mirror of eval-run-resolver.test.ts's conventions: mocked DDB
 * client, authContext fixtures per role, direct function calls (not the
 * AppSync `handler` dispatch, except where explicitly noted).
 *
 * Slice 1 (release-store.ts / release-hash.ts) is exercised through its
 * real, unmocked exports — this suite never mocks putRelease/getRelease
 * directly, only the DynamoDB client underneath them, so the create-only
 * and idempotency guarantees stay load-bearing for these tests too.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import type {
  AuthContext,
  EvalRun,
  EvalSuite,
  ExecutionSpecification,
} from "../../types";
import type { RegistryRecord } from "../../services/registry-service";

process.env.AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
process.env.EXECUTION_SPECS_TABLE = "citadel-execution-specifications-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.PROJECTS_TABLE = "citadel-projects-test";
process.env.USER_POOL_ID = "us-west-2_testpool";
process.env.REGISTRY_ENABLED = "true";
process.env.REGISTRY_ID = "test-registry";

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

// registry-service is mocked at module level: cutAgentRelease only needs
// getResource(type, id), the same surface agent-config-resolver.ts uses.
const mockGetResource = jest.fn();
jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
  })),
}));

import {
  cutAgentRelease,
  validateReleaseGate,
  handler,
} from "../release-resolver";

function authContextFor(role: string): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function approvedRegistryRecord(
  overrides: Partial<RegistryRecord> = {},
  metaOverrides: Record<string, unknown> = {},
): RegistryRecord {
  return {
    recordId: "agent-1",
    name: "intake-agent",
    status: "APPROVED",
    customDescriptorContent: JSON.stringify({
      orgId: "org-1",
      manifest: { name: "intake-agent" },
      ...metaOverrides,
    }),
    ...overrides,
  };
}

function approvedExecSpec(
  overrides: Partial<ExecutionSpecification> = {},
): ExecutionSpecification {
  return {
    specId: "spec-123",
    projectId: "project-1",
    sourceAdrIds: ["adr-1"],
    structuredPayload: "{}",
    narrativeS3Uri:
      "s3://citadel-governance-transcripts-dev-123456789012-us-east-1/projects/project-1/n.md",
    status: "APPROVED",
    version: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "architect-1",
    ...overrides,
  };
}

function completedEvalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    evalRunId: "run-1",
    orgId: "org-1",
    suiteId: "suite-1",
    suiteVersion: 2,
    agentTargetId: "agent-1",
    agentTargetVersion: "v1",
    status: "COMPLETED",
    caseCount: 3,
    pendingCases: 0,
    startedAt: "2026-08-01T00:00:00.000Z",
    startedBy: "architect-1",
    idempotencyKey: "key-1",
    ...overrides,
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

function baseCutInput() {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    semver: "1.0.0",
    registryRecordId: "agent-1",
    execSpecId: "spec-123",
    evalRunId: "run-1",
    promptVersions: {
      supervisor: { sourceId: "p1", content: "you are...", digest: "d1" },
    },
    modelConfigSnapshots: [
      { slot: "supervisor", content: "claude-x", digest: "m1" },
    ],
    toolConfigs: [{ sourceId: "tool-a", content: "{}", digest: "t1" }],
    policySnapshot: {
      enforcementMode: "strict",
      ruleSetVersion: "v3",
      authorityUnitGrantIds: ["grant-1"],
    },
    gitSha: "abc123",
    region: "us-east-1",
    runId: "run-abc",
  };
}

/** Wires the three GetCommand-backed lookups (execSpec, evalRun, evalSuite)
 * plus registry getResource to the "everything is valid" fixtures, and the
 * two write paths (release PutCommand, suite UpdateCommand) to success.
 * Also wires the exec spec's Project (PROJECTS_TABLE) and its Cognito
 * owner-org lookup to resolve to the caller's own org ("org-1"), so
 * existing happy-path tests exercise the exec-spec org check without
 * having to know about it. */
function mockHappyPath(): void {
  mockGetResource.mockResolvedValue(approvedRegistryRecord());
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === process.env.EXECUTION_SPECS_TABLE) {
      return { Item: approvedExecSpec() };
    }
    if (input.TableName === process.env.EVAL_RUNS_TABLE) {
      return { Item: completedEvalRun() };
    }
    if (input.TableName === process.env.EVAL_SUITES_TABLE) {
      return { Item: frozenSuite() };
    }
    if (input.TableName === process.env.PROJECTS_TABLE) {
      return { Item: { id: "project-1", owner: "owner-in-org-1" } };
    }
    return {};
  });
  ddbMock.on(PutCommand).resolves({});
  ddbMock
    .on(UpdateCommand)
    .resolves({ Attributes: frozenSuite({ references: ["run-1"] }) });
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [{ Name: "custom:organization", Value: "org-1" }],
  });
}

function mockAdminGetUserResolves(
  attributes: { Name: string; Value: string }[],
): void {
  cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: attributes });
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  jest.clearAllMocks();
});

describe("cutAgentRelease — authorization", () => {
  test("throws UnauthorizedError without release:cut permission", async () => {
    mockHappyPath();
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("developer"), "org-1"),
    ).rejects.toThrow(/UnauthorizedError/);
  });

  test("allows architect", async () => {
    mockHappyPath();
    const release = await cutAgentRelease(
      baseCutInput(),
      authContextFor("architect"),
      "org-1",
    );
    expect(release.releaseId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("permission check happens before any DDB lookup", async () => {
    // No mocks wired at all — if the permission check were skipped or
    // deferred, the very first unmocked call would throw a jest-mock
    // "not implemented" style rejection instead of UnauthorizedError.
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("developer"), "org-1"),
    ).rejects.toThrow(/UnauthorizedError/);
    expect(mockGetResource).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe("cutAgentRelease — registry record validation", () => {
  test("rejects when the registry record does not exist", async () => {
    mockHappyPath();
    mockGetResource.mockResolvedValue(null);
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*registry/i);
  });

  test("rejects when the registry record is not APPROVED", async () => {
    mockHappyPath();
    mockGetResource.mockResolvedValue(
      approvedRegistryRecord({ status: "DRAFT" }),
    );
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*APPROVED/);
  });

  test("rejects (security) when the registry record belongs to a different org", async () => {
    mockHappyPath();
    mockGetResource.mockResolvedValue(
      approvedRegistryRecord({}, { orgId: "org-OTHER" }),
    );
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/cross-org|different org/i);
  });

  test("rejects (fail-closed) when the registry record's descriptor lacks an orgId entirely", async () => {
    mockHappyPath();
    mockGetResource.mockResolvedValue(
      approvedRegistryRecord({
        customDescriptorContent: JSON.stringify({
          manifest: { name: "intake-agent" },
        }),
      }),
    );
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/SecurityError.*org/i);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("no DDB write occurs when registry validation fails", async () => {
    mockHappyPath();
    mockGetResource.mockResolvedValue(
      approvedRegistryRecord({ status: "DRAFT" }),
    );
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("cutAgentRelease — exec spec validation", () => {
  test("rejects when the exec spec does not exist", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE) return {};
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*exec/i);
  });

  test("rejects when the exec spec is not APPROVED", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE) {
        return { Item: approvedExecSpec({ status: "DRAFT" }) };
      }
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*APPROVED/);
  });

  test("rejects (security) when the exec spec's project is owned by a different org (via Project.owner -> lookupUserOrganization)", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-OTHER" } };
      }
      return {};
    });
    mockAdminGetUserResolves([
      { Name: "custom:organization", Value: "org-OTHER" },
    ]);
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/SecurityError.*exec spec/i);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("allows when the exec spec's project owner resolves to the caller's own org", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    mockAdminGetUserResolves([{ Name: "custom:organization", Value: "org-1" }]);
    const release = await cutAgentRelease(
      baseCutInput(),
      authContextFor("architect"),
      "org-1",
    );
    expect(release.releaseId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects (fail-closed) when the exec spec's project cannot be found", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) return {};
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/SecurityError.*exec spec/i);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("rejects (fail-closed) when the exec spec's project owner's org cannot be resolved (Cognito lookup returns nothing)", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-unknown" } };
      }
      return {};
    });
    mockAdminGetUserResolves([]);
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/SecurityError.*exec spec/i);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("cutAgentRelease — eval run validation", () => {
  test("rejects when the eval run does not exist", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE) return {};
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*eval run/i);
  });

  test("rejects when the eval run is not COMPLETED", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE) {
        return { Item: completedEvalRun({ status: "RUNNING" }) };
      }
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*COMPLETED/);
  });

  test("rejects (security) when the eval run belongs to a different org", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE) {
        return { Item: completedEvalRun({ orgId: "org-OTHER" }) };
      }
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/cross-org|different org/i);
  });

  test("rejects when the pinned suite version does not match the eval run's suiteVersion", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE) {
        return { Item: completedEvalRun({ suiteVersion: 5 }) };
      }
      if (input.TableName === process.env.EVAL_SUITES_TABLE) {
        return { Item: frozenSuite({ version: 2 }) };
      }
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ValidationError.*suiteVersion/i);
  });

  test("rejects (security) when the eval suite belongs to a different org than the caller", async () => {
    mockHappyPath();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE) {
        return { Item: frozenSuite({ orgId: "org-OTHER" }) };
      }
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/SecurityError.*suite/i);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("cutAgentRelease — release orgId is derived from callerOrgId, not trusted from input", () => {
  test("the stored release's orgId is the caller's org even when input.orgId claims a different org", async () => {
    mockHappyPath();
    const release = await cutAgentRelease(
      { ...baseCutInput(), orgId: "org-EVIL" },
      authContextFor("architect"),
      "org-1",
    );
    expect(release.orgId).toBe("org-1");
  });
});

describe("cutAgentRelease — validation happens before hashing/storing", () => {
  test("a validation failure never calls putRelease or markEvalSuiteReferenced", async () => {
    mockHappyPath();
    mockGetResource.mockResolvedValue(
      approvedRegistryRecord({ status: "REJECTED" }),
    );
    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("cutAgentRelease — successful cut", () => {
  test("stores the release and freezes the eval suite by marking it referenced", async () => {
    mockHappyPath();
    const release = await cutAgentRelease(
      baseCutInput(),
      authContextFor("architect"),
      "org-1",
    );

    expect(release.orgId).toBe("org-1");
    expect(release.evalEvidence).toEqual({
      evalRunId: "run-1",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 2,
    });
    expect(release.execSpecId).toBe("spec-123");
    expect(release.execSpecVersion).toBe(3);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.TableName).toBe(
      process.env.AGENT_RELEASES_TABLE,
    );

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.TableName).toBe(
      process.env.EVAL_SUITES_TABLE,
    );
  });

  test("the release store write (PutCommand) happens BEFORE the suite-freeze write (UpdateCommand)", async () => {
    mockHappyPath();
    const callOrder: string[] = [];
    ddbMock.on(PutCommand).callsFake(() => {
      callOrder.push("put-release");
      return {};
    });
    ddbMock.on(UpdateCommand).callsFake(() => {
      callOrder.push("mark-referenced");
      return { Attributes: frozenSuite({ references: ["run-1"] }) };
    });

    await cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1");

    expect(callOrder).toEqual(["put-release", "mark-referenced"]);
  });

  test("cutting identical content twice is idempotent: second call does not overwrite and returns the same releaseId", async () => {
    mockHappyPath();
    const first = await cutAgentRelease(
      baseCutInput(),
      authContextFor("architect"),
      "org-1",
    );

    // Second attempt: the conditional Put now collides on the identical
    // content hash, exactly like release-store.test.ts's duplicate-content
    // scenario.
    ddbMock.on(PutCommand).rejects(
      Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.AGENT_RELEASES_TABLE) {
        return { Item: { ...first } };
      }
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });

    const second = await cutAgentRelease(
      baseCutInput(),
      authContextFor("architect"),
      "org-1",
    );

    expect(second.releaseId).toBe(first.releaseId);
  });

  test("real retry across wall-clock time is idempotent WITHOUT mocking ConditionalCheckFailedException: two cuts of identical constituents at different createdAt produce the SAME releaseId and a single stored row", async () => {
    mockHappyPath();
    jest.useFakeTimers({ now: new Date("2026-08-07T00:00:00.000Z") });

    // A genuine simulation of DynamoDB's attribute_not_exists(releaseId)
    // conditional Put — NOT a pre-canned ConditionalCheckFailedException.
    // The releaseId key space is backed by a real in-memory map keyed on
    // the Item's own releaseId, so the SAME releaseId on a second Put
    // naturally collides, and a DIFFERENT releaseId naturally does not.
    // This is what actually exercises whether computeReleaseHash excludes
    // createdAt — a canned rejection would mask the bug instead.
    const releasesTable = new Map<string, unknown>();
    ddbMock.on(PutCommand).callsFake((input) => {
      if (input.TableName !== process.env.AGENT_RELEASES_TABLE) return {};
      const item = input.Item as { releaseId: string };
      if (releasesTable.has(item.releaseId)) {
        throw Object.assign(new Error("The conditional request failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      releasesTable.set(item.releaseId, item);
      return {};
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.AGENT_RELEASES_TABLE) {
        const releaseId = (input.Key as { releaseId: string }).releaseId;
        const item = releasesTable.get(releaseId);
        return item ? { Item: item } : {};
      }
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });

    try {
      const first = await cutAgentRelease(
        baseCutInput(),
        authContextFor("architect"),
        "org-1",
      );

      // Advance the clock so a fresh createdAt is minted on the retry —
      // the real conditional Put must collide on its own because the
      // hash must depend only on the constituents, not on createdAt.
      jest.setSystemTime(new Date("2026-08-07T00:00:00.123Z"));

      const second = await cutAgentRelease(
        baseCutInput(),
        authContextFor("architect"),
        "org-1",
      );

      expect(second.releaseId).toBe(first.releaseId);
      expect(releasesTable.size).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("cutAgentRelease — ordering / partial failure (store succeeds, freeze fails)", () => {
  /**
   * If putRelease succeeds but markEvalSuiteReferenced then throws, the
   * release row now durably exists while its evalEvidence's suite is still
   * mutable (not yet frozen-by-reference) — the exact guarantee the release
   * exists to make. We deliberately do NOT swallow this: the error must
   * propagate to the caller (observable, e.g. surfaced to an on-call
   * dashboard or a retry queue) rather than returning a release object that
   * looks successful. See the ordering comment in release-resolver.ts for
   * the full fail-safe-ordering rationale (store-then-freeze, never the
   * reverse, because an over-frozen suite is harmless but a release with
   * mutable evidence is not).
   */
  test("propagates the markEvalSuiteReferenced failure rather than swallowing it", async () => {
    mockHappyPath();
    ddbMock
      .on(UpdateCommand)
      .rejects(new Error("ProvisionedThroughputExceeded"));

    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/ProvisionedThroughputExceeded/);

    // The release WAS durably stored — this is the fail-safe half of the
    // ordering choice: an already-put release row is not itself harmful,
    // only its as-yet-unfrozen evidence is a residual risk (surfaced above
    // by not swallowing the error).
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("retrying the identical cut after a freeze failure is safe: the store half is idempotent and the freeze half is re-attempted", async () => {
    mockHappyPath();
    ddbMock.on(UpdateCommand).rejectsOnce(new Error("transient failure"));

    await expect(
      cutAgentRelease(baseCutInput(), authContextFor("architect"), "org-1"),
    ).rejects.toThrow(/transient failure/);

    // Retry: PutCommand will now hit the conditional-check-failed path
    // (content already stored) and UpdateCommand succeeds this time.
    ddbMock.on(PutCommand).rejects(
      Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.AGENT_RELEASES_TABLE) {
        // releaseId is content-derived and deterministic across retries
        // with identical input — recomputed by the resolver itself, so we
        // just need SOME stored row to be returned; the resolver supplies
        // the actual releaseId it computed when it calls getRelease.
        return {};
      }
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });
    ddbMock
      .on(UpdateCommand)
      .resolves({ Attributes: frozenSuite({ references: ["run-1"] }) });

    // getRelease on the conditional-check-failed path needs the exact
    // stored item back; re-wire GetCommand for AGENT_RELEASES_TABLE once we
    // know what the first attempt would have stored (same input -> same
    // hash), by capturing the Put item from the first PutCommand call.
    const firstPutItem =
      ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === process.env.AGENT_RELEASES_TABLE) {
        return { Item: firstPutItem };
      }
      if (input.TableName === process.env.EXECUTION_SPECS_TABLE)
        return { Item: approvedExecSpec() };
      if (input.TableName === process.env.EVAL_RUNS_TABLE)
        return { Item: completedEvalRun() };
      if (input.TableName === process.env.EVAL_SUITES_TABLE)
        return { Item: frozenSuite() };
      if (input.TableName === process.env.PROJECTS_TABLE) {
        return { Item: { id: "project-1", owner: "owner-in-org-1" } };
      }
      return {};
    });

    const retried = await cutAgentRelease(
      baseCutInput(),
      authContextFor("architect"),
      "org-1",
    );
    expect(retried.releaseId).toBe(
      (firstPutItem as { releaseId: string }).releaseId,
    );
  });
});

describe("validateReleaseGate — deferred seam", () => {
  test("exists as a no-op stub, not wired into cutAgentRelease", () => {
    expect(typeof validateReleaseGate).toBe("function");
    expect(validateReleaseGate()).toBeUndefined();
  });
});

describe("handler — AppSync dispatch", () => {
  test("cutAgentRelease field extracts orgId from the identity claim and delegates to cutAgentRelease", async () => {
    mockHappyPath();
    const result = await handler({
      info: { fieldName: "cutAgentRelease" },
      identity: {
        sub: "architect-1",
        "custom:role": "architect",
        claims: { "custom:organization": "org-1" },
      },
      arguments: { input: baseCutInput() } as never,
    } as never);
    expect((result as { releaseId: string }).releaseId).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("rejects when the caller's organization cannot be determined", async () => {
    mockHappyPath();
    // mockHappyPath wires Cognito AdminGetUser to resolve org-1 (for the
    // exec-spec org check's happy path) — override it here so the
    // identity-claim-less caller genuinely cannot resolve an org via
    // either extractOrgFromEvent's claim or Cognito-fallback path.
    cognitoMock.on(AdminGetUserCommand).resolves({ UserAttributes: [] });
    await expect(
      handler({
        info: { fieldName: "cutAgentRelease" },
        identity: { sub: "architect-1", "custom:role": "architect" },
        arguments: { input: baseCutInput() } as never,
      } as never),
    ).rejects.toThrow(/ValidationError.*organization/i);
  });

  test("throws for an unsupported field name", async () => {
    await expect(
      handler({
        info: { fieldName: "deleteAgentRelease" },
        identity: {},
        arguments: {} as never,
      } as never),
    ).rejects.toThrow(/Unsupported field/);
  });
});
