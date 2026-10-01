/**
 * Unit tests for pre-token-generation Lambda.
 *
 * `custom:organization` claim (decision 00d40a31, option A): the claim is
 * minted SERVER-SIDE from the UserOrgMembership DynamoDB table, keyed by
 * the caller's Cognito `sub`. The stored `custom:organization` user-pool
 * attribute is display/back-compat only and is NEVER read by this trigger.
 * Row absent or DynamoDB error → the claim is OMITTED (fail closed).
 *
 * The promoted `custom:role` claim is DISPLAY/LEGACY ONLY and, since
 * CIT-213, is derived exclusively from Cognito group membership
 * (`groupConfiguration.groupsToOverride`) — the stored, client-writable
 * `custom:role` attribute is never read (finding 7aa877f8).
 */
process.env.USER_ORG_MEMBERSHIP_TABLE = "test-user-org-membership";

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const dynamoMock = mockClient(DynamoDBDocumentClient);

import {
  handler,
  deriveOrgClaim,
  deriveDisplayRole,
} from "../pre-token-generation";

type HandlerEvent = Parameters<typeof handler>[0];

/** Loose overrides: request.userAttributes merges, everything else replaces. */
interface EventOverrides extends Record<string, unknown> {
  userName?: string;
  request?: {
    userAttributes?: Record<string, string>;
    groupConfiguration?: {
      groupsToOverride: string[];
      iamRolesToOverride: string[];
      preferredRole: string | null;
    };
  };
  response?: unknown;
}

function makeEvent(overrides: EventOverrides = {}): HandlerEvent {
  return {
    version: "1",
    triggerSource: "TokenGeneration_HostedAuth",
    region: "us-east-1",
    userPoolId: "us-east-1_test",
    userName: overrides.userName ?? "user-123",
    callerContext: { awsSdkVersion: "1", clientId: "client-1" },
    request: {
      userAttributes: {
        sub: "user-123",
        email: "u@example.com",
        ...(overrides.request?.userAttributes || {}),
      },
      groupConfiguration: overrides.request?.groupConfiguration ?? {
        groupsToOverride: [],
        iamRolesToOverride: [],
        preferredRole: null,
      },
    },
    response: overrides.response ?? {},
  } as unknown as HandlerEvent;
}

function groups(groupsToOverride: string[]) {
  return { groupsToOverride, iamRolesToOverride: [], preferredRole: null };
}

function claims(result: HandlerEvent) {
  return result.response?.claimsOverrideDetails?.claimsToAddOrOverride;
}

/** Stub a membership row for the given sub. */
function withMembership(sub: string, orgName: string) {
  dynamoMock
    .on(GetCommand, { TableName: "test-user-org-membership", Key: { sub } })
    .resolves({ Item: { sub, orgName, updatedAt: "2026-01-01T00:00:00Z" } });
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  dynamoMock.reset();
  // Default: no membership row for anyone.
  dynamoMock.on(GetCommand).resolves({ Item: undefined });
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("pre-token-generation", () => {
  // -------------------------------------------------------------------
  // custom:organization — derived from the membership table ONLY
  // (decision 00d40a31, option A)
  // -------------------------------------------------------------------
  describe("custom:organization claim (server-derived from membership table)", () => {
    test("row present → claim custom:organization = row.orgName", async () => {
      withMembership("user-123", "org-a");
      const event = makeEvent();

      const result = await handler(event);

      expect(claims(result)).toEqual({ "custom:organization": "org-a" });
    });

    test("looks the row up by userAttributes.sub in the configured table", async () => {
      withMembership("user-123", "org-a");

      await handler(makeEvent());

      const calls = dynamoMock.commandCalls(GetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        TableName: "test-user-org-membership",
        Key: { sub: "user-123" },
      });
    });

    test("falls back to event.userName as the lookup key when userAttributes.sub is absent", async () => {
      withMembership("name-only-user", "org-from-username");
      const event = makeEvent({ userName: "name-only-user" });
      delete event.request.userAttributes.sub;

      const result = await handler(event);

      expect(claims(result)).toEqual({
        "custom:organization": "org-from-username",
      });
      expect(
        dynamoMock.commandCalls(GetCommand)[0].args[0].input,
      ).toMatchObject({ Key: { sub: "name-only-user" } });
    });

    test("row absent → claim OMITTED and a warning is logged (fail closed)", async () => {
      const event = makeEvent();

      const result = await handler(event);

      expect(claims(result)).toEqual({});
      expect(claims(result)).not.toHaveProperty("custom:organization");
      expect(warnSpy).toHaveBeenCalled();
    });

    test("DynamoDB error → claim OMITTED, handler does not throw, warning logged (fail closed)", async () => {
      dynamoMock
        .on(GetCommand)
        .rejects(new Error("ProvisionedThroughputExceeded"));
      const event = makeEvent();

      const result = await handler(event);

      expect(claims(result)).toEqual({});
      expect(warnSpy).toHaveBeenCalled();
    });

    test("KEY ESCALATION TEST: the stored custom:organization attribute is NEVER promoted when no membership row exists", async () => {
      const event = makeEvent({
        request: { userAttributes: { "custom:organization": "forged-org" } },
      });

      const result = await handler(event);

      expect(claims(result)).toEqual({});
    });

    test("KEY ESCALATION TEST: the membership row wins over a conflicting stored custom:organization attribute", async () => {
      withMembership("user-123", "real-org");
      const event = makeEvent({
        request: { userAttributes: { "custom:organization": "forged-org" } },
      });

      const result = await handler(event);

      expect(claims(result)).toEqual({ "custom:organization": "real-org" });
    });

    test("KEY ESCALATION TEST: a DynamoDB error never falls back to the stored attribute", async () => {
      dynamoMock.on(GetCommand).rejects(new Error("boom"));
      const event = makeEvent({
        request: { userAttributes: { "custom:organization": "forged-org" } },
      });

      const result = await handler(event);

      expect(claims(result)).toEqual({});
    });

    test("a membership row whose orgName is empty/non-string yields no claim", async () => {
      dynamoMock
        .on(GetCommand)
        .resolves({ Item: { sub: "user-123", orgName: "" } });

      const result = await handler(makeEvent());

      expect(claims(result)).toEqual({});
    });

    test("USER_ORG_MEMBERSHIP_TABLE unset → claim OMITTED, no DynamoDB call, warning logged", async () => {
      const saved = process.env.USER_ORG_MEMBERSHIP_TABLE;
      delete process.env.USER_ORG_MEMBERSHIP_TABLE;
      try {
        const result = await handler(makeEvent());
        expect(claims(result)).toEqual({});
        expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        process.env.USER_ORG_MEMBERSHIP_TABLE = saved;
      }
    });

    // Cognito's default ID-token mapping emits every client-READABLE user
    // attribute as a claim, and the user pool client's readAttributes
    // includes custom:organization. Omitting the claim from
    // claimsToAddOrOverride is therefore NOT enough: the stored attribute
    // would still surface as `custom:organization` in the ID token, which
    // AppSync accepts and extractOrgFromEvent reads. Every omission path
    // must actively SUPPRESS the claim.
    describe("claim suppression on every omission path (fail closed against the readable attribute)", () => {
      function suppressed(result: HandlerEvent) {
        return result.response?.claimsOverrideDetails?.claimsToSuppress;
      }

      test("row absent → claimsToSuppress includes custom:organization even when the stored attribute is set", async () => {
        const event = makeEvent({
          request: {
            userAttributes: { "custom:organization": "forged-org" },
          },
        });

        const result = await handler(event);

        expect(claims(result)).not.toHaveProperty("custom:organization");
        expect(suppressed(result)).toEqual(["custom:organization"]);
      });

      test("DynamoDB error → claimsToSuppress includes custom:organization", async () => {
        dynamoMock.on(GetCommand).rejects(new Error("boom"));
        const event = makeEvent({
          request: {
            userAttributes: { "custom:organization": "forged-org" },
          },
        });

        const result = await handler(event);

        expect(suppressed(result)).toEqual(["custom:organization"]);
      });

      test("USER_ORG_MEMBERSHIP_TABLE unset → claimsToSuppress includes custom:organization", async () => {
        const saved = process.env.USER_ORG_MEMBERSHIP_TABLE;
        delete process.env.USER_ORG_MEMBERSHIP_TABLE;
        try {
          const result = await handler(
            makeEvent({
              request: {
                userAttributes: { "custom:organization": "forged-org" },
              },
            }),
          );
          expect(suppressed(result)).toEqual(["custom:organization"]);
        } finally {
          process.env.USER_ORG_MEMBERSHIP_TABLE = saved;
        }
      });

      test("membership row with empty orgName → claimsToSuppress includes custom:organization", async () => {
        dynamoMock
          .on(GetCommand)
          .resolves({ Item: { sub: "user-123", orgName: "" } });

        const result = await handler(makeEvent());

        expect(suppressed(result)).toEqual(["custom:organization"]);
      });

      test("row present → the claim is minted and NOT suppressed", async () => {
        withMembership("user-123", "org-a");

        const result = await handler(makeEvent());

        expect(claims(result)).toEqual({ "custom:organization": "org-a" });
        expect(suppressed(result)).toBeUndefined();
      });

      test("merges with an existing claimsToSuppress list without duplicating", async () => {
        const event = makeEvent({
          response: {
            claimsOverrideDetails: {
              claimsToSuppress: ["email_verified", "custom:organization"],
            },
          },
        });

        const result = await handler(event);

        expect(suppressed(result)).toEqual([
          "email_verified",
          "custom:organization",
        ]);
      });

      test("row present leaves a pre-existing unrelated claimsToSuppress untouched", async () => {
        withMembership("user-123", "org-a");
        const event = makeEvent({
          response: {
            claimsOverrideDetails: { claimsToSuppress: ["email_verified"] },
          },
        });

        const result = await handler(event);

        expect(suppressed(result)).toEqual(["email_verified"]);
        expect(claims(result)).toEqual({ "custom:organization": "org-a" });
      });
    });

    test("preserves existing claimsOverrideDetails keys (e.g. groupOverrideDetails)", async () => {
      withMembership("user-123", "org-a");
      const existingGroupOverride = groups(["admin"]);

      const event = makeEvent({
        response: {
          claimsOverrideDetails: {
            groupOverrideDetails: existingGroupOverride,
          },
        },
      });

      const result = await handler(event);

      expect(result.response?.claimsOverrideDetails).toEqual({
        groupOverrideDetails: existingGroupOverride,
        claimsToAddOrOverride: { "custom:organization": "org-a" },
      });
    });
  });

  describe("deriveOrgClaim (pure)", () => {
    test("returns orgName for a well-formed row", () => {
      expect(deriveOrgClaim({ sub: "u", orgName: "Acme" })).toBe("Acme");
    });

    test("returns undefined for a missing row", () => {
      expect(deriveOrgClaim(undefined)).toBeUndefined();
      expect(deriveOrgClaim(null)).toBeUndefined();
    });

    test("returns undefined for an empty or non-string orgName", () => {
      expect(deriveOrgClaim({ sub: "u", orgName: "" })).toBeUndefined();
      expect(deriveOrgClaim({ sub: "u", orgName: 42 })).toBeUndefined();
      expect(deriveOrgClaim({ sub: "u" })).toBeUndefined();
    });
  });

  describe("deriveDisplayRole (pure, unchanged)", () => {
    test("admin wins; otherwise precedence order; otherwise undefined", () => {
      expect(deriveDisplayRole(["developer", "admin"])).toBe("admin");
      expect(deriveDisplayRole(["developer", "architect"])).toBe("architect");
      expect(deriveDisplayRole(["analyst"])).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // custom:role claim — derived from groupsToOverride ONLY (CIT-213)
  // -------------------------------------------------------------------

  // finding 7aa877f8 / CIT-213: the stored custom:role attribute is
  // client-writable. It must never be read — neither to promote 'admin'
  // nor to promote a non-admin role. These are the KEY ESCALATION TESTS
  // for the trigger side.
  test("KEY ESCALATION TEST: a stored custom:role=admin attribute WITHOUT admin group membership is NOT promoted to the admin claim", async () => {
    withMembership("user-123", "org-a");
    const event = makeEvent({
      request: {
        userAttributes: { "custom:role": "admin" },
        groupConfiguration: groups(["project_manager"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({
      "custom:organization": "org-a",
      "custom:role": "project_manager",
    });
  });

  test("KEY ESCALATION TEST (CIT-213): a stored non-admin custom:role attribute with NO group membership is NOT promoted", async () => {
    withMembership("user-123", "org-a");
    const event = makeEvent({
      request: {
        userAttributes: { "custom:role": "project_manager" },
        groupConfiguration: groups([]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:organization": "org-a" });
  });

  test("KEY ESCALATION TEST (CIT-213): stored custom:role=architect with only the developer group promotes 'developer', not 'architect'", async () => {
    const event = makeEvent({
      request: {
        userAttributes: { "custom:role": "architect" },
        groupConfiguration: groups(["developer"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "developer" });
  });

  test("admin group membership yields custom:role=admin regardless of the stored attribute", async () => {
    const event = makeEvent({
      request: {
        userAttributes: { "custom:role": "project_manager" },
        groupConfiguration: groups(["admin"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "admin" });
  });

  test("admin group with no custom:role attribute → custom:role=admin", async () => {
    const event = makeEvent({
      request: { userAttributes: {}, groupConfiguration: groups(["admin"]) },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "admin" });
  });

  test("admin wins over every other group, whatever the array order", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["developer", "architect", "admin"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "admin" });
  });

  test("a single non-admin group is promoted as the display role", async () => {
    withMembership("user-123", "org-a");
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["architect"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({
      "custom:organization": "org-a",
      "custom:role": "architect",
    });
  });

  test("multiple non-admin groups → the first in precedence order (project_manager > architect > developer), not array order", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["developer", "architect"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "architect" });
  });

  test("project_manager outranks architect and developer", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups([
          "developer",
          "project_manager",
          "architect",
        ]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "project_manager" });
  });

  test("unknown groups are ignored — no custom:role claim is emitted", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["analyst", "viewer"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({});
  });

  test("unknown groups are skipped in favour of a known lower-precedence group", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["analyst", "developer"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "developer" });
  });

  test("groupConfiguration entirely missing → no crash and no custom:role claim", async () => {
    const event = makeEvent({
      request: { userAttributes: { "custom:role": "architect" } },
    });
    // makeEvent seeds groupConfiguration by default; strip it.
    delete event.request.groupConfiguration;

    const result = await handler(event);

    expect(claims(result)).toEqual({});
  });
});
