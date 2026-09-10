/**
 * adminCreateUser — wires the organisation claim at user creation
 * (decision 228b3cc8 piece 5 / finding cbbc3be1).
 *
 * Defect: adminCreateUser set only email, email_verified, given_name and
 * family_name on AdminCreateUserCommand. The organisation was applied
 * SOLELY by a separate, OPTIONAL assignUserRole call the frontend happened
 * to make afterwards (Team.tsx's handleAddUser only calls assignUserRole
 * if a role was also selected — organisation-only, no-role creation left
 * the user with NO custom:organization claim at all). A user with no claim
 * fails closed across every org-scoped resolver (by design — see
 * user-management-resolver-org-scoping.test.ts and the no-caller-org-
 * fallback-idiom guard) but that "fails closed" only helps once the user
 * already has SOME resolvable identity; a user who can never pass ANY
 * org-scoped check is a support burden, not a security feature, and the
 * root cause is that organisation assignment was optional at the one
 * point (admin-only creation) it could have been enforced.
 *
 * DECISION: `organization` is now a REQUIRED field on
 * `AdminCreateUserInput` (both the GraphQL schema and the resolver code
 * enforce this) rather than defaulting to some organisation if omitted.
 * Team.tsx's Add User dialog already collects an organisation from
 * `organizations` (name-valued, per the ratified NAME-is-canonical
 * convention) — inventing a silent default (e.g. "Default") would let a
 * caller who forgets to pick one create a user in the wrong tenant without
 * any signal, which is a worse failure mode than a clear upfront
 * validation error. This keeps `adminCreateUser` an admin-only write (PR
 * 146: custom:organization stays non-user-writable) — the value comes from
 * the input, not from any self-service path.
 */
process.env.USER_POOL_ID = "us-east-1_testpool";
process.env.ORGANISATION_TABLE = "test-orgs";

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

import { handler } from "../user-management-resolver";

type ResolverEvent = Parameters<typeof handler>[0];

function buildEvent(
  fieldName: string,
  identity: ResolverEvent["identity"],
  args: Partial<ResolverEvent["arguments"]> = {},
): ResolverEvent {
  return {
    info: { fieldName },
    identity,
    arguments: args as ResolverEvent["arguments"],
  };
}

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: "admin-user" })
    .resolves({ Groups: [{ GroupName: "admin" }] });
});

describe("adminCreateUser — organization is required and wired into custom:organization", () => {
  test("sets custom:organization on AdminCreateUserCommand from a supplied organization", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Engineering",
        },
      },
    );

    const result = (await handler(event)) as { success: boolean };
    expect(result.success).toBe(true);

    const calls = cognitoMock.commandCalls(AdminCreateUserCommand);
    expect(calls).toHaveLength(1);
    const attrs = calls[0].args[0].input.UserAttributes ?? [];
    const orgAttr = attrs.find((a) => a.Name === "custom:organization");
    expect(orgAttr?.Value).toBe("Engineering");
  });

  test("still sets email, email_verified, given_name and family_name (pre-existing behaviour preserved)", async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({});

    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Engineering",
        },
      },
    );

    await handler(event);

    const attrs =
      cognitoMock.commandCalls(AdminCreateUserCommand)[0].args[0].input
        .UserAttributes ?? [];
    const byName = (n: string) => attrs.find((a) => a.Name === n)?.Value;
    expect(byName("email")).toBe("new.user@example.com");
    expect(byName("email_verified")).toBe("true");
    expect(byName("given_name")).toBe("New");
    expect(byName("family_name")).toBe("User");
  });

  test("rejects a create with NO organization, with a clear message, and does NOT call AdminCreateUserCommand (fail clearly, no silent default)", async () => {
    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "no-org@example.com",
          givenName: "No",
          familyName: "Org",
        },
      },
    );

    const result = (await handler(event)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/organization/i);

    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  test("rejects a create with an EMPTY-STRING organization the same way as a missing one", async () => {
    const event = buildEvent(
      "adminCreateUser",
      { username: "admin-user" },
      {
        input: {
          email: "blank-org@example.com",
          givenName: "Blank",
          familyName: "Org",
          organization: "",
        },
      },
    );

    const result = (await handler(event)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/organization/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  test("still requires admin (non-admin caller refused, no Cognito call)", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "adminCreateUser",
      { username: "alice" },
      {
        input: {
          email: "new.user@example.com",
          givenName: "New",
          familyName: "User",
          organization: "Engineering",
        },
      },
    );

    await expect(handler(event)).rejects.toThrow(/administrators/i);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});
