/**
 * promotion-policy-resolver.ts — admin-only GraphQL resolver for
 * PromotionPolicyConfig storage/reads. Mirrors
 * eval-sampling-config-resolver.ts's structure and admin-gate doctrine
 * exactly: `authContext.roles.includes("admin")` directly, deliberately
 * stricter than any eval:author/eval:approve/release:promote permission
 * — this toggle controls the FLOOR every promotion quality gate in the
 * org evaluates against (decision ada70113: promotion policy becomes
 * per-org config), a platform-wide governance-policy decision, not a
 * per-release action.
 *
 * updatedBy is SERVER-DERIVED from authContext.userId, never accepted
 * from caller input — same doctrine as
 * eval-sampling-config-resolver.ts's setEvalSamplingConfig.
 *
 * This resolver only ever issues GetCommand/PutCommand against
 * PROMOTION_POLICY_CONFIG_TABLE (by orgId) — the read side used by the
 * promotion gate itself (promotion-policy-store.ts's
 * resolvePromotionPolicy) is a SEPARATE, dependency-light module; this
 * resolver is not on that read path and never imports it, so a change
 * here cannot alter the gate's fail-closed contract.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PromotionPolicy } from "./utils/release-gate";
import type { AuthContext } from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PROMOTION_POLICY_CONFIG_TABLE =
  process.env.PROMOTION_POLICY_CONFIG_TABLE!;

function requireAdmin(authContext: AuthContext, action: string): void {
  if (!authContext.roles?.includes("admin")) {
    throw new Error(`UnauthorizedError: admin role required to ${action}`);
  }
}

export interface PromotionPolicyConfig {
  orgId: string;
  policy: Partial<PromotionPolicy>;
  perAgentPolicyOverrides: Record<string, Partial<PromotionPolicy>>;
  updatedAt?: string;
  updatedBy?: string;
}

export interface PromotionPolicyConfigInput {
  policy?: Partial<PromotionPolicy>;
  perAgentPolicyOverrides?: Record<string, Partial<PromotionPolicy>>;
}

export async function setPromotionPolicy(
  orgId: string,
  input: PromotionPolicyConfigInput,
  authContext: AuthContext,
): Promise<PromotionPolicyConfig> {
  requireAdmin(authContext, "modify promotion policy configuration");

  const config: PromotionPolicyConfig = {
    orgId,
    policy: input.policy ?? {},
    perAgentPolicyOverrides: input.perAgentPolicyOverrides ?? {},
    updatedAt: new Date().toISOString(),
    updatedBy: authContext.userId,
  };

  await docClient.send(
    new PutCommand({ TableName: PROMOTION_POLICY_CONFIG_TABLE, Item: config }),
  );

  return config;
}

export async function getPromotionPolicy(
  orgId: string,
  authContext: AuthContext,
): Promise<PromotionPolicyConfig | undefined> {
  requireAdmin(authContext, "read promotion policy configuration");

  const res = await docClient.send(
    new GetCommand({
      TableName: PROMOTION_POLICY_CONFIG_TABLE,
      Key: { orgId },
    }),
  );
  return res.Item as PromotionPolicyConfig | undefined;
}

interface PromotionPolicyResolverArguments {
  orgId: string;
  input: PromotionPolicyConfigInput;
}

interface PromotionPolicyResolverEvent {
  info?: { fieldName?: string };
  identity?: {
    sub?: string;
    username?: string;
    ["cognito:groups"]?: string[];
    claims?: Record<string, string>;
    ["custom:role"]?: string;
  };
  arguments: PromotionPolicyResolverArguments;
}

function authContextFromEvent(
  event: PromotionPolicyResolverEvent,
): AuthContext {
  const identity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole] : [],
  };
}

export const handler = async (
  event: PromotionPolicyResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  switch (fieldName) {
    case "setPromotionPolicy":
      return await setPromotionPolicy(
        event.arguments.orgId,
        event.arguments.input,
        authContext,
      );
    case "getPromotionPolicy":
      return await getPromotionPolicy(event.arguments.orgId, authContext);
    default:
      throw new Error(`Unknown field: ${fieldName}`);
  }
};
