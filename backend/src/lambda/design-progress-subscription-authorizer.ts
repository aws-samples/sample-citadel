import { AppSyncResolverEvent } from "aws-lambda";
import { getUserId } from "../utils/appsync";
import { assertProjectAccess } from "../utils/project-access";

/**
 * Subscription-connect authorization resolver for `onDesignProgress(projectId: ID!)`
 * (finding 195b2a58 item b, mirroring chatter-subscription-authorizer.ts's
 * onChatter/onFabricationEvent gate).
 *
 * AppSync's enhanced/implicit subscription filtering (the `projectId`
 * argument matched against the mutation response's `projectId` field)
 * gives isolation ONLY if the connection-time `projectId` argument itself
 * is authorized against the caller's identity — otherwise a client can
 * simply subscribe with a victim project's id and the implicit filter will
 * happily match. This resolver is that authorization gate: it runs on the
 * `Subscription.onDesignProgress` field itself (a `subscribe` request),
 * BEFORE AppSync registers the connection's filter, and rejects the
 * subscribe attempt outright when the caller is not entitled to the
 * requested projectId.
 *
 * Reuses the SAME project-access gate the resolver siblings use
 * (assertProjectAccess: admin bypass, else owner-or-same-org, else deny)
 * rather than re-deriving org-only tenancy — onDesignProgress is scoped by
 * project, not by org, so the project-level gate is the correct one here
 * (chatter's onChatter/onFabricationEvent are org-scoped and use
 * extractOrgFromEvent directly; this is a deliberate divergence, not an
 * oversight). Fails closed — a caller with no resolvable identity/project
 * is refused, not waved through.
 */
export class CrossOrgDesignProgressSubscriptionError extends Error {
  constructor(message = "Access denied: cross-project subscription") {
    super(message);
    this.name = "CrossOrgDesignProgressSubscriptionError";
  }
}

interface OnDesignProgressArguments {
  projectId: string;
}

type SubscriptionAuthEvent = AppSyncResolverEvent<OnDesignProgressArguments>;

export const handler = async (event: SubscriptionAuthEvent): Promise<null> => {
  const requestedProjectId = event.arguments?.projectId;
  const userId = getUserId(event.identity);

  try {
    await assertProjectAccess(requestedProjectId, userId, event);
  } catch {
    console.warn(
      "onDesignProgress subscription refused: cross-project or unresolved access",
      {
        fieldName: event.info?.fieldName,
        requestedProjectId,
      },
    );
    throw new CrossOrgDesignProgressSubscriptionError();
  }

  // Subscription resolvers return null on success — AppSync then applies
  // the implicit projectId filter registered from this same argument.
  return null;
};
