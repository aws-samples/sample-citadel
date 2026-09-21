/**
 * Design Progress Publish Resolver
 *
 * Security fix (finding 195b2a58): Mutation.publishDesignProgress was a
 * bare pass-through echo reachable with ANY authenticated Cognito
 * identity (the schema carried both @aws_iam and @aws_cognito_user_pools),
 * letting any end user broadcast a spoofed projectId/sectionId/
 * completionPercentage to that project's onDesignProgress subscribers.
 * The only legitimate publisher is design-progress-notifier.ts (an
 * EventBridge consumer that SigV4/IAM-signs its AppSync mutation call) —
 * confirmed by grep: no frontend code calls publishDesignProgress
 * (frontend/src only subscribes to onDesignProgress).
 *
 * Fix mirrors intake-orchestration-resolver.ts's isIamIdentity guard and
 * the schema-level @aws_iam-only directive already used by publishChatter
 * / publishConversationMessage: the schema directive is the primary
 * control, this fail-closed identity check is defence in depth in case a
 * future schema edit reintroduces @aws_cognito_user_pools.
 */
import { AppSyncResolverEvent } from "aws-lambda";

export interface DesignProgressInput {
  projectId: string;
  sectionId: string;
  completionPercentage: number;
  timestamp: string;
}

/**
 * Defence-in-depth IAM identity check (mirrors intake-orchestration-resolver.ts
 * / chatter-resolver.ts's equivalent guards). An IAM-authed AppSync
 * invocation surfaces `accountId` and lacks the Cognito/OIDC `sub`/`claims`
 * shape; anything else is rejected even though the `@aws_iam`-only schema
 * directive should already have kept it out.
 */
function isIamIdentity(identity: unknown): boolean {
  if (!identity || typeof identity !== "object") return false;
  const id = identity as Record<string, unknown>;
  if (id.claims !== undefined) return false;
  if (typeof id.sub === "string") return false;
  return typeof id.accountId === "string" && id.accountId.length > 0;
}

export const handler = async (
  event: AppSyncResolverEvent<{ input: DesignProgressInput }>,
) => {
  if (!isIamIdentity(event.identity)) {
    throw new Error("Forbidden: publishDesignProgress is IAM-only");
  }

  return event.arguments.input;
};
