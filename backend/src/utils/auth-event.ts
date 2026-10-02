/**
 * CANONICAL TENANCY RULE (ratified decision 228b3cc8): the organisation
 * NAME — never the generated `orgId` — is canonical for the
 * `custom:organization` Cognito claim, for the UserOrgMembership table's
 * `orgName` attribute, and for EVERY tenancy comparison in this codebase
 * (this file's `extractOrgFromEvent`, `utils/org-membership.ts`'s
 * `lookupOwnerOrganization`,
 * `assignUserRole`'s membership-table + Cognito attribute writes,
 * `user-management-resolver.ts`'s org-scoping filters, the governance
 * ledger, and the projects family). `assignUserRole` writes the
 * organisation's NAME (never its orgId) into the membership row's `orgName`
 * and mirrors it onto `custom:organization`; every reader of that claim
 * MUST compare it against a row's `name` field, never against `orgId`. Organisation names are
 * IMMUTABLE by design (no update/rename mutation exists — see
 * org-name-canonical-guard.test.ts) precisely so this claim never needs to
 * be re-synced after creation. Do NOT reintroduce a `row.orgId ===
 * callerOrgClaim` comparison — that comparison is always false for a real
 * row and was the root cause of a prior bug (a non-admin caller of
 * `listOrganizations` always got an empty list). If you are about to write
 * `something.orgId === <claim variable>`, you are almost certainly holding
 * a NAME on one side and a UUID on the other.
 *
 * This module intentionally has NO Cognito client: decision 00d40a31
 * removed the AdminGetUser `custom:organization` attribute-lookup helper
 * entirely. Project-owner org resolution now lives in
 * utils/org-membership.ts and reads the UserOrgMembership table.
 */

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
 * Extracts the caller's organization from the `custom:organization` JWT
 * CLAIM — and ONLY the claim.
 *
 * The claim is minted server-side by the pre-token-generation trigger
 * (backend/src/lambda/pre-token-generation.ts) from the UserOrgMembership
 * DynamoDB table, keyed by the caller's Cognito `sub`. It is therefore the
 * one org signal a caller cannot forge with their own token.
 *
 * Decision 00d40a31 (option A) REMOVED the former Cognito AdminGetUser
 * fallback that read the stored `custom:organization` user attribute when
 * the claim was absent (the helper itself has since been deleted from this
 * module). That attribute is display/back-compat only; a
 * caller whose token carries no claim (no membership row, stale token,
 * access token instead of ID token, anonymous/api-key auth) now resolves
 * to null. Callers are responsible for deciding whether null means "deny"
 * or "allow through" — every row-access gate in this file fails closed.
 *
 * Remains `async` so the ~40 existing call sites (`await
 * extractOrgFromEvent(event)`) are unaffected.
 */
export async function extractOrgFromEvent(
  event: unknown,
): Promise<string | null> {
  const claimOrg = readClaim(event, "custom:organization");
  return claimOrg ? claimOrg : null;
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
 * CIT-213 (escalation 2026-09-30): the same rule now applies to EVERY role
 * — see {@link readGroups}, {@link deriveRoles}, {@link hasRoleFromEvent}.
 * This function is `readGroups(event).includes('admin')`.
 */
export function isAdminFromEvent(event: unknown): boolean {
  return readGroups(event).includes("admin");
}

/**
 * The ONE shared reader of the `cognito:groups` claim (CIT-213). Every role
 * derivation in this file — and `auth.ts`'s `createAuthContext` — goes
 * through it, so the tolerated claim shapes are defined in exactly one
 * place:
 *  - a JS array of group names (standard JWT decoding), non-string entries
 *    dropped;
 *  - a comma-separated string (some proxies/auth modes flatten the array),
 *    split and trimmed, empty segments dropped;
 *  - located at either `identity['cognito:groups']` (Cognito user pool auth
 *    mode) or `identity.claims['cognito:groups']` (proxy/IAM modes).
 *
 * Returns `[]` for any other value, a missing claim, or a missing identity
 * — callers fail closed. The `custom:role` claim is deliberately NOT a
 * fallback (finding 7aa877f8): group membership is the only signal a
 * caller cannot forge with their own token.
 */
export function readGroups(event: unknown): string[] {
  const groups = readClaim(event, "cognito:groups") as unknown;
  if (Array.isArray(groups)) {
    return groups.filter((g): g is string => typeof g === "string");
  }
  if (typeof groups === "string") {
    return groups
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Derives the `AuthContext.roles` array for permission checks
 * (`hasPermission`, every resolver-local `requireAdmin`) from Cognito group
 * membership ONLY.
 *
 * History:
 *  - finding 7aa877f8 made the ADMIN entry group-authoritative (the
 *    client-writable `custom:role` attribute could no longer assert
 *    'admin'), but non-admin `custom:role` values were still preserved
 *    verbatim so existing non-admin permission behaviour was unchanged.
 *  - CIT-213 (escalation 2026-09-30) closed the remaining gap: a caller who
 *    could write `custom:role=architect` gained spec:approve,
 *    release:promote, tool:execute, ... through this function. The claim is
 *    no longer read AT ALL; `roles` is exactly the deduplicated
 *    `cognito:groups` claim (via {@link readGroups}).
 *
 * This is the ONE shared derivation every `authContextFromEvent` copy
 * across the governance resolvers (ADR, ExecutionSpecification,
 * InterrogationRound, AgentDesignAssessment, ProgramReview, Release,
 * EvalRun, EvalComparison, Eval, EvalSamplingConfig, PromotionPolicy,
 * Organization, ToolApproval, ToolSandbox, EnvironmentReleasePointer) and
 * auth.ts's `createAuthContext` delegate to, instead of each re-deriving
 * `roles` in isolation.
 *
 * Group names are returned verbatim — the role vocabulary consumed by
 * `hasPermission` ({admin, project_manager, architect, developer}) is the
 * CDK-declared Cognito group set (backend-stack.ts), pinned by
 * single-global-admin-tier-tripwire.test.ts P1/P4.
 */
export function deriveRoles(event: unknown): string[] {
  return Array.from(new Set(readGroups(event)));
}

/**
 * True when the caller holds the given (non-admin) role, determined SOLELY
 * by `cognito:groups` membership (via {@link readGroups}, so both the
 * array and comma-separated-string shapes and both the direct
 * `identity[...]` and nested `identity.claims[...]` locations are honoured).
 *
 * Before CIT-213 this had a "Path 1" that returned true when the
 * `custom:role` claim equalled the requested role. That path was deleted
 * (escalation 2026-09-30): it let anyone who could write the attribute
 * grant themselves `architect`. See {@link isAdminFromEvent} for the
 * finding 7aa877f8 history that first established groups as the only
 * trustworthy signal.
 *
 * This intentionally does NOT treat 'admin' as a super-role. Callers wanting
 * "admin OR <role>" semantics should compose
 * `isAdminFromEvent(event) || hasRoleFromEvent(event, role)`.
 */
export function hasRoleFromEvent(event: unknown, role: string): boolean {
  return readGroups(event).includes(role);
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
