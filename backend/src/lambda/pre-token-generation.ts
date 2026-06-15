/**
 * Cognito pre-token-generation trigger.
 *
 * Promotes `custom:organization` and `custom:role` attributes from the user
 * pool into JWT claims so downstream resolvers can read org/role identity
 * without an AdminGetUserCommand call per request.
 *
 * Admin-group overlay: when a user is in the Cognito `admin` group but has
 * no `custom:role` attribute, we synthesise `custom:role: 'admin'` here so
 * downstream code that only inspects the role claim sees a consistent view.
 * The runtime `isAdminFromEvent` helper (commit b279257) already covers the
 * read-time case via `cognito:groups`, so deploying this overlay is purely
 * additive — existing tokens keep working until they expire and refresh.
 *
 * Part of the Phase 1 org-scoping foundation.
 */
import type { PreTokenGenerationTriggerEvent } from 'aws-lambda';

export const handler = async (
  event: PreTokenGenerationTriggerEvent,
): Promise<PreTokenGenerationTriggerEvent> => {
  const userAttributes = event.request.userAttributes || {};
  const claimsToAddOrOverride: Record<string, string> = {};

  const org = userAttributes['custom:organization'];
  if (org) claimsToAddOrOverride['custom:organization'] = org;

  let role = userAttributes['custom:role'];
  if (!role) {
    // Promote admin group membership to custom:role for downstream code
    // that only checks the role claim. An explicit attribute always wins
    // over the group-derived value.
    const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
    if (groups.includes('admin')) {
      role = 'admin';
    }
  }
  if (role) claimsToAddOrOverride['custom:role'] = role;

  event.response = event.response || {};
  event.response.claimsOverrideDetails = {
    ...(event.response.claimsOverrideDetails || {}),
    claimsToAddOrOverride,
  };

  return event;
};
