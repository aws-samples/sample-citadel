/**
 * Cost HTTP Shared — response helpers + org-scoping resolution shared by
 * cost-query-handler.ts (read-only: summary/series) and
 * cost-budget-handler.ts (budgets read+write).
 *
 * Extracted from cost-query-handler.ts's original inline implementations
 * (no-behavior refactor) as part of the query/budgets Lambda split — both
 * handlers must apply the IDENTICAL org-scoping discipline so splitting
 * them into separate IAM roles doesn't accidentally diverge the security
 * boundary between the two.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  extractOrgFromHttpEvent,
  isAdminFromHttpEvent,
} from "./auth-http-event";

export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export function json(statusCode: number, payload: unknown): HttpResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export function badRequest(message: string): HttpResponse {
  return json(400, { error: message });
}

export function forbidden(message = "Forbidden"): HttpResponse {
  return json(403, { error: message });
}

export function notFound(): HttpResponse {
  return json(404, { error: "Not found" });
}

/**
 * Resolves which org's key condition a request may use.
 * Returns `{ ok: false }` (→ caller responds 403) when a non-admin
 * requests an org other than their own claim. Never returns an org that
 * did not come from either the verified claim (non-admin) or an
 * explicit, admin-authorized `?orgId=` (admin).
 */
export function resolveScopedOrg(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  requestedOrgId: string | undefined,
): { ok: true; orgId: string } | { ok: false } {
  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return { ok: false };

  const isAdmin = isAdminFromHttpEvent(event);

  if (!requestedOrgId || requestedOrgId === claimOrg) {
    return { ok: true, orgId: claimOrg };
  }

  if (isAdmin) {
    return { ok: true, orgId: requestedOrgId };
  }

  // Non-admin requesting a different org: deny. Never forward requestedOrgId
  // to the key condition, and never silently fall back to the claim org for
  // this branch — the caller explicitly asked for something they cannot have.
  return { ok: false };
}
