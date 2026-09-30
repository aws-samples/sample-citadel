/**
 * Cognito pre-token-generation trigger.
 *
 * Promotes the `custom:organization` attribute from the user pool into a
 * JWT claim so downstream resolvers can read org identity without an
 * AdminGetUserCommand call per request, and synthesises a DISPLAY/LEGACY
 * `custom:role` claim from Cognito group membership.
 *
 * `custom:role` claim (finding 7aa877f8, then CIT-213): the stored
 * `custom:role` attribute is client-writable (absent an explicit Cognito
 * client WriteAttributes allow-list — since fixed separately — any
 * authenticated user could set it via UpdateUserAttributes), so it is a
 * forgeable input and this trigger NEVER READS IT. History:
 *   - finding 7aa877f8: group membership became authoritative for the
 *     admin value only — `admin` group forced the claim to 'admin', a
 *     stored `custom:role=admin` without the group was dropped, and
 *     non-admin stored values were still promoted verbatim.
 *   - CIT-213 (escalation 2026-09-30): a stored non-admin value (e.g.
 *     `architect`) was still a forgeable role assertion, so the attribute
 *     read was removed entirely. The claim is now derived from
 *     `groupConfiguration.groupsToOverride` ONLY:
 *       - 'admin' if the user is in the `admin` group;
 *       - otherwise the first KNOWN non-admin group in precedence order
 *         (`project_manager` > `architect` > `developer`);
 *       - otherwise the claim is omitted.
 *     Precedence: the CDK (backend-stack.ts) declares the four groups
 *     without a numeric Cognito `Precedence`, so Cognito supplies no
 *     ordering of its own; the order above is the CDK declaration order and
 *     the vocabulary is the group set pinned by
 *     single-global-admin-tier-tripwire.test.ts P1.
 *
 * The promoted `custom:role` claim is for DISPLAY/LEGACY consumers only. No
 * backend authorization path reads it — `cognito:groups` is the sole
 * authorization signal for every role (see backend/src/utils/auth-event.ts
 * `readGroups`/`deriveRoles`, pinned by
 * backend/test/cognito-claim-trust-tripwire.test.ts).
 *
 * `custom:organization` handling is unchanged here (CIT-214 scope).
 *
 * Part of the Phase 1 org-scoping foundation.
 */
import type { PreTokenGenerationTriggerEvent } from "aws-lambda";

/**
 * Non-admin groups whose membership may be surfaced as the display
 * `custom:role` claim, highest precedence first. Must stay a subset of the
 * CDK-declared Cognito group set.
 */
const NON_ADMIN_ROLE_PRECEDENCE = [
  "project_manager",
  "architect",
  "developer",
] as const;

/**
 * Pure derivation of the display `custom:role` claim from group membership.
 * Exported for direct unit testing; the handler is the only production
 * caller.
 */
export function deriveDisplayRole(
  groups: readonly string[],
): string | undefined {
  if (groups.includes("admin")) return "admin";
  return NON_ADMIN_ROLE_PRECEDENCE.find((g) => groups.includes(g));
}

export const handler = async (
  event: PreTokenGenerationTriggerEvent,
): Promise<PreTokenGenerationTriggerEvent> => {
  const userAttributes = event.request.userAttributes || {};
  const claimsToAddOrOverride: Record<string, string> = {};

  const org = userAttributes["custom:organization"];
  if (org) claimsToAddOrOverride["custom:organization"] = org;

  // Group membership is the ONLY input to the role claim. The stored
  // `custom:role` attribute is deliberately not consulted (see header).
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const role = deriveDisplayRole(groups);
  if (role) claimsToAddOrOverride["custom:role"] = role;

  event.response = event.response || {};
  event.response.claimsOverrideDetails = {
    ...(event.response.claimsOverrideDetails || {}),
    claimsToAddOrOverride,
  };

  return event;
};
