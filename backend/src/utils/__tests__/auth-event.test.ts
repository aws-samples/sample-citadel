/**
 * Unit tests for the shared auth-event helper.
 *
 * Covers both code paths of `extractOrgFromEvent` (claim-first, Cognito
 * fallback) and the claim-only `isAdminFromEvent`. The Cognito fallback
 * path is asserted never to trigger when a claim is present — that
 * guarantee is the reason this helper exists.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  hasRoleFromEvent,
  assertRowOrg,
  CrossOrgAccessError,
} from "../auth-event";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe("auth-event", () => {
  beforeAll(() => {
    process.env.USER_POOL_ID = "us-east-1_test";
  });

  beforeEach(() => {
    cognitoMock.reset();
  });

  afterAll(() => {
    delete process.env.USER_POOL_ID;
  });

  describe("extractOrgFromEvent", () => {
    test('returns orgId from identity["custom:organization"] without calling Cognito', async () => {
      const event = {
        identity: {
          sub: "user-123",
          "custom:organization": "org-claim-a",
        },
      };

      const result = await extractOrgFromEvent(event);

      expect(result).toBe("org-claim-a");
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test('returns orgId from identity.claims["custom:organization"] without calling Cognito', async () => {
      const event = {
        identity: {
          sub: "user-123",
          claims: {
            "custom:organization": "org-claim-b",
          },
        },
      };

      const result = await extractOrgFromEvent(event);

      expect(result).toBe("org-claim-b");
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test("falls back to Cognito AdminGetUser and returns attribute value when no claim is present", async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: "user-123",
        UserAttributes: [
          { Name: "sub", Value: "user-123" },
          { Name: "custom:organization", Value: "org-cognito-c" },
        ],
      });

      const event = { identity: { sub: "user-123" } };

      const result = await extractOrgFromEvent(event);

      expect(result).toBe("org-cognito-c");
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(1);
    });

    test("returns null (without throwing) when Cognito fallback errors", async () => {
      cognitoMock.on(AdminGetUserCommand).rejects(new Error("boom"));

      const event = { identity: { sub: "user-123" } };

      const result = await extractOrgFromEvent(event);

      expect(result).toBeNull();
    });

    test("returns null when event has no identity", async () => {
      const result = await extractOrgFromEvent({});
      expect(result).toBeNull();
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test("returns null when USER_POOL_ID is unset (no Cognito call)", async () => {
      const originalPoolId = process.env.USER_POOL_ID;
      delete process.env.USER_POOL_ID;

      try {
        const event = { identity: { sub: "user-123" } };
        const result = await extractOrgFromEvent(event);
        expect(result).toBeNull();
        expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
      } finally {
        process.env.USER_POOL_ID = originalPoolId;
      }
    });

    test("falls back to Cognito using identity.username when sub is absent", async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: "name-only-user",
        UserAttributes: [
          { Name: "custom:organization", Value: "org-from-username" },
        ],
      });

      const event = { identity: { username: "name-only-user" } };

      const result = await extractOrgFromEvent(event);
      expect(result).toBe("org-from-username");
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(1);
    });
  });

  describe("isAdminFromEvent", () => {
    test('returns true when identity["custom:role"] is "admin"', () => {
      const event = { identity: { "custom:role": "admin" } };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns true when identity.claims["custom:role"] is "admin"', () => {
      const event = { identity: { claims: { "custom:role": "admin" } } };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns false when role is "project_manager"', () => {
      const event = { identity: { "custom:role": "project_manager" } };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test("returns false when role claim is absent", () => {
      const event = { identity: { sub: "user-123" } };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test("returns false when event has no identity", () => {
      expect(isAdminFromEvent({})).toBe(false);
    });

    test('returns true when cognito:groups is an array containing "admin"', () => {
      const event = {
        identity: { "cognito:groups": ["admin", "user"] },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test("returns false when cognito:groups array contains only non-admin groups", () => {
      const event = {
        identity: { "cognito:groups": ["user", "project_manager"] },
      };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('returns true when cognito:groups is the comma-separated string "admin,user"', () => {
      const event = {
        identity: { "cognito:groups": "admin,user" },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns false when cognito:groups is the string "user,project_manager"', () => {
      const event = {
        identity: { "cognito:groups": "user,project_manager" },
      };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test("returns false when both cognito:groups and custom:role are missing", () => {
      const event = { identity: { sub: "user-123" } };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('honours cognito:groups at identity["cognito:groups"] (Cognito user pool auth mode)', () => {
      const event = {
        identity: { "cognito:groups": ["admin"] },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('honours cognito:groups at identity.claims["cognito:groups"] (proxy/IAM mode)', () => {
      const event = {
        identity: { claims: { "cognito:groups": ["admin"] } },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('custom:role "admin" wins even when cognito:groups is empty/absent', () => {
      const event = {
        identity: { "custom:role": "admin", "cognito:groups": [] },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });
  });

  describe("hasRoleFromEvent", () => {
    test('returns true when identity["custom:role"] equals the requested role', () => {
      const event = { identity: { "custom:role": "architect" } };
      expect(hasRoleFromEvent(event, "architect")).toBe(true);
    });

    test('returns true when identity.claims["custom:role"] equals the requested role', () => {
      const event = { identity: { claims: { "custom:role": "architect" } } };
      expect(hasRoleFromEvent(event, "architect")).toBe(true);
    });

    test("returns false when custom:role is a different role", () => {
      const event = { identity: { "custom:role": "developer" } };
      expect(hasRoleFromEvent(event, "architect")).toBe(false);
    });

    test("returns true when cognito:groups array contains the requested role", () => {
      const event = { identity: { "cognito:groups": ["architect", "user"] } };
      expect(hasRoleFromEvent(event, "architect")).toBe(true);
    });

    test("returns true when cognito:groups is a comma-separated string containing the role", () => {
      const event = { identity: { "cognito:groups": "user,architect" } };
      expect(hasRoleFromEvent(event, "architect")).toBe(true);
    });

    test('honours cognito:groups at identity.claims["cognito:groups"] (proxy/IAM mode)', () => {
      const event = {
        identity: { claims: { "cognito:groups": ["architect"] } },
      };
      expect(hasRoleFromEvent(event, "architect")).toBe(true);
    });

    test("returns false when neither custom:role nor cognito:groups include the role", () => {
      const event = { identity: { "cognito:groups": ["user", "developer"] } };
      expect(hasRoleFromEvent(event, "architect")).toBe(false);
    });

    test("returns false when event has no identity", () => {
      expect(hasRoleFromEvent({}, "architect")).toBe(false);
    });

    test("does not treat an admin caller as holding other roles", () => {
      const event = { identity: { "custom:role": "admin" } };
      expect(hasRoleFromEvent(event, "architect")).toBe(false);
    });
  });

  describe("assertRowOrg", () => {
    test("resolves when the row orgId matches the caller server-derived org", async () => {
      const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
      await expect(
        assertRowOrg({ orgId: "org-a" }, event),
      ).resolves.toBeUndefined();
    });

    test("throws CrossOrgAccessError when the row orgId differs from the caller org", async () => {
      const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
      await expect(
        assertRowOrg({ orgId: "org-b" }, event),
      ).rejects.toBeInstanceOf(CrossOrgAccessError);
    });

    test("throws when the row has no orgId (fail closed, never silently allow)", async () => {
      const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
      await expect(assertRowOrg({}, event)).rejects.toBeInstanceOf(
        CrossOrgAccessError,
      );
    });

    test("throws when the row is null/undefined (fail closed)", async () => {
      const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
      await expect(assertRowOrg(undefined, event)).rejects.toBeInstanceOf(
        CrossOrgAccessError,
      );
      await expect(assertRowOrg(null, event)).rejects.toBeInstanceOf(
        CrossOrgAccessError,
      );
    });

    test("throws when the caller org is unresolvable, even if the row has an orgId (fail closed)", async () => {
      const event = { identity: { sub: "u1" } }; // no org claim, no USER_POOL_ID Cognito fallback match
      cognitoMock.rejects(new Error("user not found"));
      await expect(
        assertRowOrg({ orgId: "org-a" }, event),
      ).rejects.toBeInstanceOf(CrossOrgAccessError);
    });

    test("admin bypasses the org check entirely, even for a cross-org row", async () => {
      const event = { identity: { sub: "admin-1", "custom:role": "admin" } };
      await expect(
        assertRowOrg({ orgId: "org-completely-different" }, event),
      ).resolves.toBeUndefined();
    });

    test('CrossOrgAccessError carries the "Access denied" message used by resolvers', async () => {
      const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
      await expect(assertRowOrg({ orgId: "org-b" }, event)).rejects.toThrow(
        "Access denied",
      );
    });
  });
});
