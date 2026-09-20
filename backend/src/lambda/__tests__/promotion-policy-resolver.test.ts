/**
 * promotion-policy-resolver.test.ts — decision ada70113 (promotion
 * policy becomes per-org config). Admin-only gate:
 * `roles.includes("admin")` directly, mirroring
 * eval-sampling-config-resolver.test.ts's structure. Also covers decision
 * c5c8429a's org reconciliation gate (client-supplied orgId vs the
 * caller's server-derived org).
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AuthContext } from "../../types";

process.env.PROMOTION_POLICY_CONFIG_TABLE =
  "citadel-promotion-policy-config-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

jest.mock("../../utils/auth-event", () => ({
  ...jest.requireActual("../../utils/auth-event"),
  extractOrgFromEvent: jest.fn(),
}));

import {
  getPromotionPolicy,
  setPromotionPolicy,
  handler,
} from "../promotion-policy-resolver";
import { extractOrgFromEvent } from "../../utils/auth-event";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.MockedFunction<
  typeof extractOrgFromEvent
>;

beforeEach(() => {
  ddbMock.reset();
  mockExtractOrgFromEvent.mockReset();
});

const adminAuth: AuthContext = {
  userId: "admin-1",
  groups: [],
  roles: ["admin"],
};
const nonAdminAuth: AuthContext = {
  userId: "user-1",
  groups: [],
  roles: ["project_manager"],
};

describe("setPromotionPolicy — admin-only gate", () => {
  test("rejects a non-admin caller", async () => {
    await expect(
      setPromotionPolicy(
        "org-1",
        { policy: { taskSuccessMin: 0.95 } },
        nonAdminAuth,
      ),
    ).rejects.toThrow(/UnauthorizedError/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("allows an admin caller and writes the row", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setPromotionPolicy(
      "org-1",
      {
        policy: { taskSuccessMin: 0.95 },
        perAgentPolicyOverrides: { "agent-1": { taskSuccessMin: 0.99 } },
      },
      adminAuth,
    );

    expect(result.orgId).toBe("org-1");
    expect(result.policy).toEqual({ taskSuccessMin: 0.95 });
    expect(result.perAgentPolicyOverrides).toEqual({
      "agent-1": { taskSuccessMin: 0.99 },
    });
    const putArgs = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putArgs.TableName).toBe("citadel-promotion-policy-config-test");
    expect((putArgs.Item as Record<string, unknown>).orgId).toBe("org-1");
  });

  test("updatedBy is server-derived from authContext.userId, never accepted from input", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setPromotionPolicy(
      "org-1",
      // Input has no updatedBy field at all (the type doesn't even allow
      // one) — this test documents that the resolver derives it from the
      // authenticated caller, matching eval-sampling-config-resolver's
      // doctrine.
      { policy: { taskSuccessMin: 0.95 } },
      adminAuth,
    );

    expect(result.updatedBy).toBe("admin-1");
    const putArgs = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect((putArgs.Item as Record<string, unknown>).updatedBy).toBe("admin-1");
  });

  test("a different admin caller's userId is reflected, proving it is not hardcoded", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setPromotionPolicy(
      "org-1",
      { policy: {} },
      { userId: "admin-2", groups: [], roles: ["admin"] },
    );

    expect(result.updatedBy).toBe("admin-2");
  });

  test("defaults policy/perAgentPolicyOverrides to empty objects when omitted", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setPromotionPolicy("org-1", {}, adminAuth);

    expect(result.policy).toEqual({});
    expect(result.perAgentPolicyOverrides).toEqual({});
  });
});

describe("getPromotionPolicy — admin-only gate", () => {
  test("rejects a non-admin caller", async () => {
    await expect(getPromotionPolicy("org-1", nonAdminAuth)).rejects.toThrow(
      /UnauthorizedError/,
    );
  });

  test("returns undefined when no config exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await getPromotionPolicy("org-1", adminAuth);
    expect(result).toBeUndefined();
  });

  test("returns the stored config for an admin", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.95 },
        perAgentPolicyOverrides: {},
      },
    });
    const result = await getPromotionPolicy("org-1", adminAuth);
    expect(result?.policy).toEqual({ taskSuccessMin: 0.95 });
  });
});

describe("handler — AppSync dispatch", () => {
  function eventFor(fieldName: string, args: Record<string, unknown>) {
    return {
      info: { fieldName },
      identity: {
        sub: "admin-1",
        "custom:role": "admin",
        "cognito:groups": ["admin"],
      },
      arguments: args,
    };
  }

  test("routes setPromotionPolicy for an admin", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-1");
    ddbMock.on(PutCommand).resolves({});

    const result = (await handler(
      eventFor("setPromotionPolicy", {
        orgId: "org-1",
        input: { policy: { taskSuccessMin: 0.95 } },
      }) as never,
    )) as { orgId: string };

    expect(result.orgId).toBe("org-1");
  });

  test("routes getPromotionPolicy for an admin", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-1");
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await handler(
      eventFor("getPromotionPolicy", { orgId: "org-1" }) as never,
    );

    expect(result).toBeUndefined();
  });

  test("rejects setPromotionPolicy for a non-admin caller via the handler", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-1");
    const event = {
      info: { fieldName: "setPromotionPolicy" },
      identity: { sub: "user-1", "custom:role": "developer" },
      arguments: { orgId: "org-1", input: { policy: {} } },
    };

    await expect(handler(event as never)).rejects.toThrow(/UnauthorizedError/);
  });

  test("throws for an unsupported field name", async () => {
    const event = {
      info: { fieldName: "somethingElse" },
      identity: {},
      arguments: {},
    };
    await expect(handler(event as never)).rejects.toThrow(/Unknown field/);
  });

  describe("org reconciliation (decision c5c8429a)", () => {
    test("setPromotionPolicy rejects a mismatched orgId argument before any write or read", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-caller");

      await expect(
        handler(
          eventFor("setPromotionPolicy", {
            orgId: "org-foreign",
            input: { policy: { taskSuccessMin: 0.95 } },
          }) as never,
        ),
      ).rejects.toThrow(/AccessDeniedError/);

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    test("getPromotionPolicy rejects a mismatched orgId argument before any read", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-caller");

      await expect(
        handler(
          eventFor("getPromotionPolicy", { orgId: "org-foreign" }) as never,
        ),
      ).rejects.toThrow(/AccessDeniedError/);

      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    test("setPromotionPolicy passes when the argument orgId matches the caller's server-derived org", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-caller");
      ddbMock.on(PutCommand).resolves({});

      const result = (await handler(
        eventFor("setPromotionPolicy", {
          orgId: "org-caller",
          input: { policy: { taskSuccessMin: 0.95 } },
        }) as never,
      )) as { orgId: string };

      expect(result.orgId).toBe("org-caller");
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    test("getPromotionPolicy passes when the argument orgId matches the caller's server-derived org", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-caller");
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      await expect(
        handler(
          eventFor("getPromotionPolicy", { orgId: "org-caller" }) as never,
        ),
      ).resolves.toBeUndefined();
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    });

    test("setPromotionPolicy rejects when the caller's own org cannot be resolved, even with a matching-looking orgId argument", async () => {
      mockExtractOrgFromEvent.mockResolvedValue(null);

      await expect(
        handler(
          eventFor("setPromotionPolicy", {
            orgId: "org-caller",
            input: { policy: { taskSuccessMin: 0.95 } },
          }) as never,
        ),
      ).rejects.toThrow(/AccessDeniedError/);

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("an admin can no longer write another org's promotion policy — the reconciliation gate has no admin bypass", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-admins-own-org");

      await expect(
        handler(
          eventFor("setPromotionPolicy", {
            orgId: "org-some-other-org",
            input: { policy: { taskSuccessMin: 0.99 } },
          }) as never,
        ),
      ).rejects.toThrow(/AccessDeniedError/);

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });
});

describe("setPromotionPolicy — G2 write-time prod≥staging monotonicity", () => {
  test("accepts a monotonic per-env ladder (floors rise DEV→STAGING→PROD)", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setPromotionPolicy(
      "org-1",
      {
        perEnvironmentPolicyOverrides: {
          DEV: { taskSuccessMin: 0.8 },
          STAGING: { taskSuccessMin: 0.9 },
          PROD: { taskSuccessMin: 0.95 },
        },
      },
      adminAuth,
    );

    expect(result.perEnvironmentPolicyOverrides.PROD).toEqual({
      taskSuccessMin: 0.95,
    });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("rejects a non-monotonic ladder (PROD floor lower than STAGING) BEFORE persisting", async () => {
    ddbMock.on(PutCommand).resolves({});

    await expect(
      setPromotionPolicy(
        "org-1",
        {
          perEnvironmentPolicyOverrides: {
            STAGING: { taskSuccessMin: 0.95 },
            PROD: { taskSuccessMin: 0.8 },
          },
        },
        adminAuth,
      ),
    ).rejects.toThrow(/ValidationError.*monotonic/i);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("rejects a non-monotonic ceiling (PROD latency budget looser than STAGING)", async () => {
    ddbMock.on(PutCommand).resolves({});

    await expect(
      setPromotionPolicy(
        "org-1",
        {
          perEnvironmentPolicyOverrides: {
            STAGING: { latencyP95TargetMs: 3000 },
            PROD: { latencyP95TargetMs: 6000 },
          },
        },
        adminAuth,
      ),
    ).rejects.toThrow(/ValidationError.*monotonic/i);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("an org-wide policy with no per-env overrides is trivially monotonic (all envs share the same base)", async () => {
    ddbMock.on(PutCommand).resolves({});

    await expect(
      setPromotionPolicy(
        "org-1",
        { policy: { taskSuccessMin: 0.95 } },
        adminAuth,
      ),
    ).resolves.toMatchObject({ orgId: "org-1" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
