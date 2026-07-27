/**
 * Unit tests for cost-http-shared.ts — shared HTTP response helpers +
 * resolveScopedOrg, extracted from cost-query-handler.ts so both the
 * query-only Lambda (cost-query-handler.ts) and the budgets Lambda
 * (cost-budget-handler.ts) apply the identical org-scoping discipline.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  json,
  badRequest,
  forbidden,
  notFound,
  resolveScopedOrg,
} from "../cost-http-shared";

function makeEvent(
  claims: Record<string, unknown>,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: { authorizer: { jwt: { claims, scopes: null } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe("response helpers", () => {
  test("json sets statusCode, Content-Type header, and JSON body", () => {
    const res = json(201, { ok: true });
    expect(res.statusCode).toBe(201);
    expect(res.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body!)).toEqual({ ok: true });
  });

  test("badRequest returns 400 with an error message", () => {
    const res = badRequest("bad input");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!)).toEqual({ error: "bad input" });
  });

  test("forbidden defaults to 403 with a generic message", () => {
    const res = forbidden();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!)).toEqual({ error: "Forbidden" });
  });

  test("notFound returns 404", () => {
    const res = notFound();
    expect(res.statusCode).toBe(404);
  });
});

describe("resolveScopedOrg", () => {
  test("no claim org -> not ok (caller responds 403)", () => {
    const event = makeEvent({});
    expect(resolveScopedOrg(event, undefined)).toEqual({ ok: false });
  });

  test("no requested org -> resolves to the claim org", () => {
    const event = makeEvent({ "custom:organization": "org-1" });
    expect(resolveScopedOrg(event, undefined)).toEqual({
      ok: true,
      orgId: "org-1",
    });
  });

  test("requested org equal to claim org -> resolves to that org", () => {
    const event = makeEvent({ "custom:organization": "org-1" });
    expect(resolveScopedOrg(event, "org-1")).toEqual({
      ok: true,
      orgId: "org-1",
    });
  });

  test("non-admin requesting a different org -> not ok", () => {
    const event = makeEvent({ "custom:organization": "org-1" });
    expect(resolveScopedOrg(event, "org-2")).toEqual({ ok: false });
  });

  test("admin requesting a different org -> resolves to the requested org", () => {
    const event = makeEvent({
      "custom:organization": "org-1",
      "custom:role": "admin",
    });
    expect(resolveScopedOrg(event, "org-2")).toEqual({
      ok: true,
      orgId: "org-2",
    });
  });

  test("admin group membership (cognito:groups array) also grants cross-org access", () => {
    const event = makeEvent({
      "custom:organization": "org-1",
      "cognito:groups": ["admin"],
    });
    expect(resolveScopedOrg(event, "org-2")).toEqual({
      ok: true,
      orgId: "org-2",
    });
  });
});
