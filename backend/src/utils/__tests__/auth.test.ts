/**
 * Unit tests for auth.ts's AuthContext builders.
 *
 * finding 7aa877f8 made ADMIN group-only; CIT-213 extends that to every
 * role: `AuthContext.roles` is derived exclusively from the token's
 * `cognito:groups` claim. The client-writable `custom:role` attribute /
 * claim is never read. Where no groups claim exists (the GetUser
 * attributes-only path) the result is NO roles — fail closed.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createAuthContext, validateCognitoToken } from "../auth";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe("createAuthContext (CIT-213 — roles are cognito:groups only)", () => {
  test("roles mirror the cognito:groups array claim", () => {
    const ctx = createAuthContext({
      identity: { sub: "u1", "cognito:groups": ["architect", "developer"] },
    });
    expect(ctx.roles).toEqual(["architect", "developer"]);
    expect(ctx.groups).toEqual(["architect", "developer"]);
  });

  test("KEY ESCALATION TEST: custom:role='architect' with no groups yields NO roles", () => {
    const ctx = createAuthContext({
      identity: { sub: "u1", "custom:role": "architect" },
    });
    expect(ctx.roles).toEqual([]);
  });

  test("KEY ESCALATION TEST: custom:role='admin' with no groups yields NO roles", () => {
    const ctx = createAuthContext({
      identity: { sub: "u1", "custom:role": "admin" },
    });
    expect(ctx.roles).toEqual([]);
  });

  test("KEY ESCALATION TEST: custom:role='architect' with only the developer group yields exactly ['developer']", () => {
    const ctx = createAuthContext({
      identity: {
        sub: "u1",
        "custom:role": "architect",
        "cognito:groups": ["developer"],
      },
    });
    expect(ctx.roles).toEqual(["developer"]);
  });

  test("admin group membership yields 'admin' in roles exactly once", () => {
    const ctx = createAuthContext({
      identity: {
        sub: "u1",
        "custom:role": "admin",
        "cognito:groups": ["admin"],
      },
    });
    expect(ctx.roles).toEqual(["admin"]);
  });

  test("comma-separated string groups claim is split into roles", () => {
    const ctx = createAuthContext({
      identity: { sub: "u1", "cognito:groups": "project_manager, developer" },
    });
    expect(ctx.roles).toEqual(["project_manager", "developer"]);
  });

  test('honours identity.claims["cognito:groups"] (proxy/IAM mode)', () => {
    const ctx = createAuthContext({
      identity: { sub: "u1", claims: { "cognito:groups": ["architect"] } },
    });
    expect(ctx.roles).toEqual(["architect"]);
  });

  test("userId falls back sub → username → 'anonymous'", () => {
    expect(
      createAuthContext({ identity: { sub: "s", username: "n" } }).userId,
    ).toBe("s");
    expect(createAuthContext({ identity: { username: "n" } }).userId).toBe("n");
    expect(createAuthContext({}).userId).toBe("anonymous");
  });
});

describe("validateCognitoToken (CIT-213 — attributes-only path fails closed)", () => {
  beforeEach(() => {
    cognitoMock.reset();
  });

  test("KEY ESCALATION TEST: a custom:role=architect user attribute yields NO roles (GetUser carries no group membership)", async () => {
    cognitoMock.on(GetUserCommand).resolves({
      Username: "user-1",
      UserAttributes: [
        { Name: "sub", Value: "user-1" },
        { Name: "custom:role", Value: "architect" },
      ],
    });

    const ctx = await validateCognitoToken("token");

    expect(ctx).toEqual({
      userId: "user-1",
      username: "user-1",
      groups: [],
      roles: [],
    });
  });

  test("KEY ESCALATION TEST: a custom:role=admin user attribute yields NO roles", async () => {
    cognitoMock.on(GetUserCommand).resolves({
      Username: "user-1",
      UserAttributes: [{ Name: "custom:role", Value: "admin" }],
    });

    const ctx = await validateCognitoToken("token");

    expect(ctx?.roles).toEqual([]);
  });

  test("returns null when GetUser rejects", async () => {
    cognitoMock.on(GetUserCommand).rejects(new Error("NotAuthorized"));
    const ctx = await validateCognitoToken("bad");
    expect(ctx).toBeNull();
  });
});
