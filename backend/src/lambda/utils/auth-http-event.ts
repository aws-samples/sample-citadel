/**
 * Auth HTTP Event — HTTP API (payload format 2.0) JWT-claims org/admin
 * extraction for the cost query surface.
 *
 * Mirrors backend/src/utils/auth-event.ts's claim-reading discipline
 * (`custom:organization`, `custom:role`, `cognito:groups` tolerant of both
 * JS-array and comma-separated-string shapes) but targets the claims shape
 * the API Gateway HttpUserPoolAuthorizer injects for HTTP APIs:
 * `event.requestContext.authorizer.jwt.claims`.
 *
 * Deliberately has NO Cognito AdminGetUser fallback (unlike
 * extractOrgFromEvent's AppSync counterpart): the HttpUserPoolAuthorizer
 * validates iss/aud/signature before the Lambda ever runs, so a request
 * reaching this handler always carries a fully-formed, current token — the
 * fallback exists there only for the AppSync token-refresh transition
 * window, which cannot occur on this path.
 */

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

type JwtClaims = Record<string, unknown>;

function readClaims(
  event: APIGatewayProxyEventV2WithJWTAuthorizer | null | undefined,
): JwtClaims {
  return event?.requestContext?.authorizer?.jwt?.claims ?? {};
}

/**
 * Extracts the caller's organization from the verified JWT claim
 * `custom:organization`. Returns null when absent or empty — callers treat
 * null as "deny" (403), never as "fall through to admin-all-orgs".
 */
export function extractOrgFromHttpEvent(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): string | null {
  const claims = readClaims(event);
  const org = claims["custom:organization"];
  return typeof org === "string" && org.length > 0 ? org : null;
}

/**
 * True when the caller is an admin, via either:
 *  1. `custom:role === 'admin'`
 *  2. `cognito:groups` membership includes `'admin'` — tolerant of both the
 *     JS-array shape (standard JWT decoding) and a comma-separated-string
 *     shape (some proxy/authorizer configurations flatten it).
 */
export function isAdminFromHttpEvent(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): boolean {
  const claims = readClaims(event);

  if (claims["custom:role"] === "admin") return true;

  const groups = claims["cognito:groups"];
  if (Array.isArray(groups)) {
    return groups.some((g) => typeof g === "string" && g === "admin");
  }
  if (typeof groups === "string") {
    return groups
      .split(",")
      .map((s) => s.trim())
      .includes("admin");
  }

  return false;
}
