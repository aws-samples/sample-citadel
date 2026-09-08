/**
 * Cognito pre-token-generation trigger.
 *
 * Promotes `custom:organization` and `custom:role` attributes from the user
 * pool into JWT claims so downstream resolvers can read org/role identity
 * without an AdminGetUserCommand call per request.
 *
 * Admin-group overlay (finding 7aa877f8, revised): group membership is
 * ALWAYS authoritative for the synthesised admin claim. `custom:role` is a
 * client-writable attribute (absent an explicit Cognito client
 * WriteAttributes allow-list — since fixed separately — any authenticated
 * user could self-grant `custom:role=admin` via UpdateUserAttributes), so
 * it must never be allowed to assert 'admin' independently of group
 * membership. Concretely:
 *   - If the user IS in the `admin` group, the promoted `custom:role` claim
 *     is forced to 'admin' regardless of what the stored attribute says.
 *   - If the user is NOT in the `admin` group, any stored
 *     `custom:role=admin` attribute value is downgraded/dropped rather than
 *     promoted verbatim — an explicit attribute must never assert admin on
 *     its own.
 *   - Non-admin custom:role values (e.g. 'architect') are promoted as-is
 *     when the user holds no admin group membership, preserving existing
 *     non-admin role-claim behaviour.
 *
 * The runtime `isAdminFromEvent`/`deriveRoles` helpers (this finding) have
 * independently stopped trusting `custom:role` for admin-ness at read time,
 * so this trigger-side change is defense-in-depth, not the sole control.
 *
 * Part of the Phase 1 org-scoping foundation.
 */
import type { PreTokenGenerationTriggerEvent } from "aws-lambda";

export const handler = async (
  event: PreTokenGenerationTriggerEvent,
): Promise<PreTokenGenerationTriggerEvent> => {
  const userAttributes = event.request.userAttributes || {};
  const claimsToAddOrOverride: Record<string, string> = {};

  const org = userAttributes["custom:organization"];
  if (org) claimsToAddOrOverride["custom:organization"] = org;

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const isGroupAdmin = groups.includes("admin");

  let role: string | undefined = userAttributes["custom:role"];
  if (isGroupAdmin) {
    // Group membership is authoritative: force the promoted claim to
    // 'admin' regardless of the stored attribute value.
    role = "admin";
  } else if (role === "admin") {
    // The stored attribute claims admin but group membership disagrees.
    // Never promote an unearned admin claim — drop it rather than trust
    // the client-writable attribute on its own.
    role = undefined;
  }
  if (role) claimsToAddOrOverride["custom:role"] = role;

  event.response = event.response || {};
  event.response.claimsOverrideDetails = {
    ...(event.response.claimsOverrideDetails || {}),
    claimsToAddOrOverride,
  };

  return event;
};
