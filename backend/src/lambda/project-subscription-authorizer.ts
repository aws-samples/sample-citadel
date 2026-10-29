import { AppSyncResolverEvent } from "aws-lambda";
import { getUserId } from "../utils/appsync";
import { assertProjectAccess } from "../utils/project-access";

/**
 * Shared subscription-connect authorization resolver for the four
 * project-keyed subscription fields that were previously ungated:
 *
 *   - onAgentStatusUpdate(projectId: ID!)
 *   - onConversationMessage(projectId: ID!)
 *   - onProjectProgress(projectId: ID!)
 *   - onAssessmentCompleted(projectId: ID!)
 *
 * All four share the identical `projectId: ID!` argument and the identical
 * gate — assertProjectAccess (admin bypass, else owner-or-same-org, else
 * deny). A single Lambda with a field-name switch handles all four so one
 * cold start serves any of them. Unknown field names fail closed.
 *
 * Mirrors the existing design-progress-subscription-authorizer.ts pattern
 * exactly (project-scoped via assertProjectAccess, not org-scoped).
 */
export class CrossProjectSubscriptionError extends Error {
  constructor(message = "Access denied: cross-project subscription") {
    super(message);
    this.name = "CrossProjectSubscriptionError";
  }
}

const ALLOWED_FIELDS = new Set([
  "onAgentStatusUpdate",
  "onConversationMessage",
  "onProjectProgress",
  "onAssessmentCompleted",
]);

interface SubscriptionArgs {
  projectId: string;
}

type SubscriptionAuthEvent = AppSyncResolverEvent<SubscriptionArgs>;

export const handler = async (event: SubscriptionAuthEvent): Promise<null> => {
  const fieldName = event.info?.fieldName;
  if (!fieldName || !ALLOWED_FIELDS.has(fieldName)) {
    throw new CrossProjectSubscriptionError();
  }

  const requestedProjectId = event.arguments?.projectId;
  if (!requestedProjectId) {
    throw new CrossProjectSubscriptionError();
  }

  const userId = getUserId(event.identity);

  try {
    await assertProjectAccess(requestedProjectId, userId, event);
  } catch {
    console.warn("Subscription refused: cross-project or unresolved access", {
      fieldName,
      requestedProjectId,
    });
    throw new CrossProjectSubscriptionError();
  }

  return null;
};
