import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * CANONICAL TENANCY RULE (ratified decision 228b3cc8): the organisation
 * NAME — never the generated `orgId` — is canonical for the
 * `custom:organization` Cognito claim and for EVERY tenancy comparison in
 * this codebase (this file's `extractOrgFromEvent`/`lookupUserOrganization`,
 * `assignUserRole`'s Cognito attribute write, `user-management-resolver.ts`'s
 * org-scoping filters, the governance ledger, and the projects family).
 * `assignUserRole` writes the organisation's NAME (never its orgId) into
 * `custom:organization`; every reader of that claim MUST compare it against
 * a row's `name` field, never against `orgId`. Organisation names are
 * IMMUTABLE by design (no update/rename mutation exists — see
 * org-name-canonical-guard.test.ts) precisely so this claim never needs to
 * be re-synced after creation. Do NOT reintroduce a `row.orgId ===
 * callerOrgClaim` comparison — that comparison is always false for a real
 * row and was the root cause of a prior bug (a non-admin caller of
 * `listOrganizations` always got an empty list). If you are about to write
 * `something.orgId === <claim variable>`, you are almost certainly holding
 * a NAME on one side and a UUID on the other.
 */
const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * Thrown by {@link assertRowOrg} when a loaded row's org does not match the
 * caller's server-derived org. Callers should let this propagate (fail
 * closed) rather than catching and continuing.
 */
export class CrossOrgAccessError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "CrossOrgAccessError";
  }
}

/**
 * Reads a claim from the AppSync identity, tolerating both shapes:
 *  - `identity['custom:organization']` (Cognito user pool auth mode)
 *  - `identity.claims['custom:organization']` (some proxy/IAM modes)
 */
type IdentityBag = Record<string, unknown> & {
  claims?: Record<string, unknown> | null;
};
type EventWithIdentity = { identity?: IdentityBag | null } | null | undefined;

function readClaim(event: unknown, name: string): string | undefined {
  const identity: IdentityBag = (event as EventWithIdentity)?.identity || {};
  return (identity[name] ?? identity.claims?.[name]) as string | undefined;
}

/**
 * Looks up a user's `custom:organization` attribute via Cognito
 * AdminGetUser. `username` accepts the Cognito sub or username (both are
 * valid AdminGetUser lookups). Returns null when USER_POOL_ID is not
 * configured, the user cannot be found, or the attribute is absent —
 * callers decide what null means.
 *
 * Shared by {@link extractOrgFromEvent} (caller-identity fallback) and the
 * intake-orchestration resolver (project-owner fallback for org-less
 * project rows created before the pre-token-generation trigger existed).
 */
export async function lookupUserOrganization(
  username: string,
): Promise<string | null> {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) return null;

  try {
    const response = await cognitoClient.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
    );
    const attr = response.UserAttributes?.find(
      (a) => a.Name === "custom:organization",
    );
    return attr?.Value || null;
  } catch (err) {
    console.warn("lookupUserOrganization: Cognito lookup failed", {
      userId: username,
      err: String(err),
    });
    return null;
  }
}

/**
 * Extracts the caller's organization.
 *
 * Preferred path: JWT claim `custom:organization` (populated by the pre-token
 * generation trigger). Fallback path: AdminGetUserCommand against Cognito.
 * The fallback exists for the transition window after this deploys but
 * before every active token has been refreshed.
 *
 * Returns null if neither source yields an orgId (e.g. anonymous or
 * api-key auth). Callers are responsible for deciding whether null means
 * "deny" or "allow through".
 */
export async function extractOrgFromEvent(
  event: unknown,
): Promise<string | null> {
  const claimOrg = readClaim(event, "custom:organization");
  if (claimOrg) return claimOrg;

  const identity: IdentityBag = (event as EventWithIdentity)?.identity || {};
  const userId = (identity.sub || identity.username) as string | undefined;
  if (!userId) return null;

  return lookupUserOrganization(userId);
}

/**
 * True when the caller is an admin, determined SOLELY by Cognito group
 * membership (`cognito:groups` claim includes `admin`).
 *
 * Prior to finding 7aa877f8 this also honoured an explicit
 * `custom:role === 'admin'` claim. That was an escalation vector: absent
 * an explicit Cognito client WriteAttributes allow-list, `custom:role` is
 * a client-writable attribute — ANY authenticated user could call
 * UpdateUserAttributes and self-grant `custom:role=admin`, which this
 * function (and the ~16 resolvers gating on it) then treated as real
 * admin. Group membership can only be changed via the Admin* Cognito API
 * (server-side, e.g. `assignUserRole`), so it is the only signal a caller
 * cannot forge with their own token.
 *
 * The pre-token-generation trigger still promotes group membership into
 * `custom:role` for legacy/display purposes, but that promoted claim MUST
 * NOT be read back here as an authorization signal — doing so would just
 * reintroduce the same trust-the-writable-attribute problem one hop away.
 *
 * The groups claim arrives in different shapes depending on AppSync auth
 * mode: a JS array under standard JWT decoding, but some proxies/auth modes
 * flatten it to a comma-separated string. Both shapes are tolerated.
 */
export function isAdminFromEvent(event: unknown): boolean {
  const groups = readClaim(event, "cognito:groups");
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

/**
 * Derives the `AuthContext.roles` array for permission checks
 * (`hasPermission`, every resolver-local `requireAdmin`), folding Cognito
 * group membership into the returned roles so `roles.includes('admin')` is
 * group-authoritative rather than trusting the client-writable
 * `custom:role` attribute alone (finding 7aa877f8).
 *
 * This is the ONE shared derivation every `authContextFromEvent` copy
 * across the governance resolvers (ADR, ExecutionSpecification,
 * InterrogationRound, AgentDesignAssessment, ProgramReview, Release,
 * EvalRun, EvalComparison, Eval, EvalSamplingConfig, PromotionPolicy,
 * Organization, ToolApproval, ToolSandbox, EnvironmentReleasePointer) and
 * auth.ts's `createAuthContext`/`validateCognitoToken` now delegate to,
 * instead of each re-deriving `roles` from `custom:role` in isolation.
 *
 * Behaviour:
 *  - `cognito:groups` membership in `admin` is ALWAYS included in the
 *    result — this is the sole authoritative admin signal (group
 *    membership can only be changed server-side via the Admin* Cognito
 *    API, e.g. `assignUserRole`).
 *  - The `custom:role` claim is preserved verbatim for non-admin role
 *    checks (e.g. `architect`, `project_manager`, `developer`) so
 *    existing non-admin permission behaviour is unchanged — only the
 *    ADMIN signal is stripped of its trust in the writable attribute.
 *  - No duplicate `'admin'` entry when both sources agree.
 */
export function deriveRoles(event: unknown): string[] {
  const roles: string[] = [];

  const claimRole = readClaim(event, "custom:role");
  if (typeof claimRole === "string" && claimRole && claimRole !== "admin") {
    roles.push(claimRole);
  }

  if (isAdminFromEvent(event)) {
    roles.push("admin");
  }

  return roles;
}

/**
 * True when the caller holds the given (non-admin) role. Mirrors
 * {@link isAdminFromEvent}'s claim-reading so role checks stay consistent
 * across AppSync auth modes:
 *  1. JWT claim `custom:role === <role>`.
 *  2. Cognito group membership `<role>` via the `cognito:groups` claim.
 *
 * As with {@link isAdminFromEvent}, the `cognito:groups` claim is tolerated
 * both as a JS array and as a comma-separated string, and both the direct
 * (`identity[...]`) and nested (`identity.claims[...]`) shapes are honoured.
 *
 * This intentionally does NOT treat 'admin' as a super-role. Callers wanting
 * "admin OR <role>" semantics should compose
 * `isAdminFromEvent(event) || hasRoleFromEvent(event, role)`.
 */
export function hasRoleFromEvent(event: unknown, role: string): boolean {
  // Path 1: explicit custom:role claim equals the requested role.
  if (readClaim(event, "custom:role") === role) return true;

  // Path 2: cognito:groups membership includes the requested role. Tolerate
  // both the array and comma-separated-string shapes (see isAdminFromEvent).
  const groups = readClaim(event, "cognito:groups");
  if (Array.isArray(groups)) {
    return groups.some((g) => typeof g === "string" && g === role);
  }
  if (typeof groups === "string") {
    return groups
      .split(",")
      .map((s) => s.trim())
      .includes(role);
  }

  return false;
}

/**
 * Fetch-then-verify row-org reconciliation gate. Shared by every resolver
 * that loads a client-supplied-ID row and must refuse a cross-org caller
 * BEFORE any mutation/side-effect (finding ca76d041). Mirrors the
 * already-correct `getExecution` gate in execution-resolver.ts and the
 * `assertRowOrg`/`CrossOrgRowError` pattern duplicated in
 * eval-comparison-resolver.ts and replay-package-builder.ts — this is the
 * ONE shared version new callers should use instead of inlining another
 * copy.
 *
 * Admins bypass (mirrors isAdminFromEvent usage elsewhere in this file).
 * Otherwise: the caller's server-derived org (extractOrgFromEvent) must
 * equal the row's `orgId`. Fail closed — a row with no orgId, or a caller
 * with no resolvable org, is denied rather than silently allowed.
 *
 * Throws {@link CrossOrgAccessError} on denial.
 */
export async function assertRowOrg(
  row: { orgId?: unknown } | null | undefined,
  event: unknown,
): Promise<void> {
  if (isAdminFromEvent(event)) return;

  const rowOrgId = typeof row?.orgId === "string" ? row.orgId : undefined;
  const callerOrgId = await extractOrgFromEvent(event);

  if (!rowOrgId || !callerOrgId || rowOrgId !== callerOrgId) {
    throw new CrossOrgAccessError();
  }
}

/**
 * AppSync-identity twin of `resolveScopedOrg` (cost-http-shared.ts), used
 * by list-by-org reads that must resolve which org's key/filter condition
 * to use (Wave-3A, board task a6ff10ff, "Helpers"):
 *
 *  - Admin: an explicit `requestedOrgId` is honoured verbatim; absent one,
 *    falls back to the admin's own server-derived org.
 *  - Non-admin: ALWAYS the caller's server-derived org
 *    (`extractOrgFromEvent`) — `requestedOrgId` is read from the CLIENT and
 *    is never trusted, so it is intentionally ignored rather than
 *    verified-then-rejected.
 *  - Returns null when no org can be resolved (unresolvable caller org, or
 *    an admin with neither an explicit org nor a resolvable own org).
 *
 * Deliberate divergence from `resolveScopedOrg`: that HTTP helper returns
 * `{ok:false}` (→ 403) on a non-admin/mismatch request, which is correct
 * for a single-resource fetch but would turn a LIST read into an authz
 * oracle ("that org exists / you're not in it"). This helper instead
 * silently coerces to the caller's own org, matching the existing
 * `listApps` (registry-agent-record-resolver.ts) coercion convention. Do
 * not "harmonise" this back into a reject.
 */
export async function resolveScopedOrgFromEvent(
  event: unknown,
  requestedOrgId?: string,
): Promise<{ orgId: string } | null> {
  if (isAdminFromEvent(event)) {
    if (requestedOrgId) return { orgId: requestedOrgId };
    const ownOrgId = await extractOrgFromEvent(event);
    return ownOrgId ? { orgId: ownOrgId } : null;
  }

  const callerOrgId = await extractOrgFromEvent(event);
  return callerOrgId ? { orgId: callerOrgId } : null;
}

/**
 * Return-null-friendly twin of {@link assertRowOrg}, mirroring
 * governance-ui-resolver.ts's `callerCanSeeRow` (Wave-3A, board task
 * a6ff10ff, "Helpers"). For BY-ID reads that must return `null`/`false`
 * instead of throwing, so a cross-org id is indistinguishable from a
 * missing one (no existence oracle).
 *
 * Admins always see the row (cross-org + un-stamped). Non-admins need a
 * resolvable caller org AND a matching, present `orgId` on the row — fails
 * closed (false) when either is missing. Never throws.
 */
export async function canCallerSeeRow(
  row: { orgId?: unknown } | null | undefined,
  event: unknown,
): Promise<boolean> {
  if (isAdminFromEvent(event)) return true;

  const rowOrgId = typeof row?.orgId === "string" ? row.orgId : undefined;
  if (!rowOrgId) return false;

  const callerOrgId = await extractOrgFromEvent(event);
  return callerOrgId === rowOrgId;
}
