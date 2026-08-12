/**
 * promotion-policy-resolver.test.ts — decision ada70113 (promotion
 * policy becomes per-org config). Admin-only gate:
 * `roles.includes("admin")` directly, mirroring
 * eval-sampling-config-resolver.test.ts's structure.
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

import {
  getPromotionPolicy,
  setPromotionPolicy,
  handler,
} from "../promotion-policy-resolver";

beforeEach(() => {
  ddbMock.reset();
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
      },
      arguments: args,
    };
  }

  test("routes setPromotionPolicy for an admin", async () => {
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
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await handler(
      eventFor("getPromotionPolicy", { orgId: "org-1" }) as never,
    );

    expect(result).toBeUndefined();
  });

  test("rejects setPromotionPolicy for a non-admin caller via the handler", async () => {
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
});
