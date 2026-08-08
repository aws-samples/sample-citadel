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
import type { AuthContext, AgentRelease } from "../../types";

process.env.AGENT_RELEASES_TABLE = "citadel-agent-releases-test";
process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE =
  "citadel-environment-release-pointers-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  promoteEnvironmentReleasePointer,
  getCurrentEnvironmentReleasePointer,
  listEnvironmentReleasePointers,
  validateReleaseGate,
  handler,
} from "../environment-release-pointer-resolver";

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
});

describe("validateReleaseGate", () => {
  test("is an explicit no-op seam — never enforces, never throws", () => {
    expect(() => validateReleaseGate()).not.toThrow();
    expect(validateReleaseGate()).toBeUndefined();
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

    const putCall = ddbMock.commandCalls(PutCommand)[0].args[0].input;
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
