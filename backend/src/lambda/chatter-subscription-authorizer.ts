import { AppSyncResolverEvent } from "aws-lambda";
import { extractOrgFromEvent, isAdminFromEvent } from "../utils/auth-event";

/**
 * Subscription-connect authorization resolver for `onChatter(orgId: ID!)`
 * and `onFabricationEvent(orgId: ID!)` (wave-2a tenancy fix, finding
 * 87a171ad section A).
 *
 * AppSync's enhanced/implicit subscription filtering (the `orgId`
 * argument matched against the mutation response's `orgId` field) gives
 * isolation ONLY if the connection-time `orgId` argument itself is
 * authorized against the caller's identity — otherwise a client can
 * simply subscribe with a victim org's id and the implicit filter will
 * happily match. This resolver is that authorization gate: it runs on the
 * `Subscription.onChatter` / `Subscription.onFabricationEvent` fields
 * themselves (a `subscribe` request), BEFORE AppSync registers the
 * connection's filter, and rejects the subscribe attempt outright when
 * the requested `orgId` does not belong to the caller.
 *
 * Rule: `event.arguments.orgId` must equal the caller's server-derived org
 * (`extractOrgFromEvent`), UNLESS the caller is an admin
 * (`isAdminFromEvent`), which bypasses the check entirely. Fails closed —
 * a caller with no resolvable org is refused, not waved through.
 *
 * Wired as the Lambda data source behind BOTH `Subscription.onChatter`
 * and `Subscription.onFabricationEvent` in the CDK (same handler, same
 * check — both fields declare the identical `orgId: ID!` tenancy
 * argument).
 */

export class CrossOrgSubscriptionError extends Error {
  constructor(message = "Access denied: cross-organization subscription") {
    super(message);
    this.name = "CrossOrgSubscriptionError";
  }
}

interface OnChatterArguments {
  orgId: string;
}

type SubscriptionAuthEvent = AppSyncResolverEvent<OnChatterArguments>;

export const handler = async (event: SubscriptionAuthEvent): Promise<null> => {
  const requestedOrgId = event.arguments?.orgId;

  if (isAdminFromEvent(event)) {
    return null;
  }

  const callerOrgId = await extractOrgFromEvent(event);

  if (!requestedOrgId || !callerOrgId || requestedOrgId !== callerOrgId) {
    console.warn("Subscription refused: cross-org or unresolved org", {
      fieldName: event.info?.fieldName,
      requestedOrgId,
      callerOrgResolved: Boolean(callerOrgId),
    });
    throw new CrossOrgSubscriptionError();
  }

  // Subscription resolvers return null on success — AppSync then applies
  // the implicit orgId filter registered from this same argument.
  return null;
};
