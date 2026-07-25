/**
 * Tests for auth-http-event.ts — HTTP API (payload format 2.0) JWT-claims
 * org/admin extraction. Mirrors backend/src/utils/auth-event.ts's claim
 * reading discipline but targets the HttpUserPoolAuthorizer claims shape
 * (`event.requestContext.authorizer.jwt.claims`), with NO Cognito
 * AdminGetUser fallback — the JWT authorizer guarantees a validated token.
 */
import {
  extractOrgFromHttpEvent,
  isAdminFromHttpEvent,
} from "../auth-http-event";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

function makeEvent(
  claims: Record<string, unknown>,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims,
          scopes: null,
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe("extractOrgFromHttpEvent", () => {
  test("returns the custom:organization claim when present", () => {
    const event = makeEvent({ "custom:organization": "org-123" });
    expect(extractOrgFromHttpEvent(event)).toBe("org-123");
  });

  test("returns null when the claim is absent", () => {
    const event = makeEvent({});
    expect(extractOrgFromHttpEvent(event)).toBeNull();
  });

  test("returns null when the claim is an empty string", () => {
    const event = makeEvent({ "custom:organization": "" });
    expect(extractOrgFromHttpEvent(event)).toBeNull();
  });

  test("returns null when authorizer/jwt/claims is entirely missing", () => {
    const event = {} as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    expect(extractOrgFromHttpEvent(event)).toBeNull();
  });
});

describe("isAdminFromHttpEvent", () => {
  test("true when custom:role === 'admin'", () => {
    const event = makeEvent({ "custom:role": "admin" });
    expect(isAdminFromHttpEvent(event)).toBe(true);
  });

  test("false when custom:role is a non-admin role", () => {
    const event = makeEvent({ "custom:role": "developer" });
    expect(isAdminFromHttpEvent(event)).toBe(false);
  });

  test("true when cognito:groups is a JS array containing 'admin'", () => {
    const event = makeEvent({ "cognito:groups": ["viewer", "admin"] });
    expect(isAdminFromHttpEvent(event)).toBe(true);
  });

  test("true when cognito:groups is a comma-separated string containing 'admin'", () => {
    const event = makeEvent({ "cognito:groups": "viewer, admin, editor" });
    expect(isAdminFromHttpEvent(event)).toBe(true);
  });

  test("false when cognito:groups does not contain 'admin' (array)", () => {
    const event = makeEvent({ "cognito:groups": ["viewer", "editor"] });
    expect(isAdminFromHttpEvent(event)).toBe(false);
  });

  test("false when cognito:groups does not contain 'admin' (string)", () => {
    const event = makeEvent({ "cognito:groups": "viewer,editor" });
    expect(isAdminFromHttpEvent(event)).toBe(false);
  });

  test("false when neither claim is present", () => {
    const event = makeEvent({});
    expect(isAdminFromHttpEvent(event)).toBe(false);
  });

  test("false when authorizer/jwt/claims is entirely missing", () => {
    const event = {} as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    expect(isAdminFromHttpEvent(event)).toBe(false);
  });
});
