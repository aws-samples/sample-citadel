/**
 * environment-release-pointer-resolver.ts — promoteEnvironmentReleasePointer
 * mutation, plus the two read queries (current pointer for one
 * agent+environment; every environment's pointer for one agent).
 *
 * Unlike release-resolver.ts's cutAgentRelease, the record this resolver
 * writes is deliberately MUTABLE. The write itself, and its optimistic
 * lock, live one layer down in environment-release-pointer-store.ts (the
 * SOLE writer for EnvironmentReleasePointersTable) — this module never
 * issues a raw DDB command against that table, only against
 * AgentReleasesTable for the target-release existence/org check.
 *
 * Validation order — permission check FIRST (matches release-resolver.ts
 * / execspec-resolver.ts's "permission check before any DDB access"
 * convention), then target-release existence, then target-release
 * org-ownership, ALL before the store's conditional write. Cross-org
 * pointer promotion is a distinct SecurityError, not folded into the
 * generic ValidationError bucket, mirroring release-resolver.ts's
 * "malformed input" vs "attempted to pin/point at another tenant's data"
 * distinction.
 *
 * QUALITY GATING SEAM: validateReleaseGate() is exported here (not
 * imported from release-resolver.ts) and is an intentional no-op. It is
 * the explicit, named place a later story attaches release-quality gating
 * (test pass rate, eval score thresholds, etc.) before a promotion is
 * allowed to proceed. It is NOT called from promoteEnvironmentReleasePointer
 * — this slice ships an existence + org + permission gate only, never an
 * ungated promotion path that silently skips a check a caller might
 * assume is already enforced.
 *
 * The caller's org is derived from the AppSync identity's
 * `custom:organization` claim (extractOrgFromEvent), never from
 * caller-supplied input — the same doctrine as release-resolver.ts.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { hasPermission } from "../utils/auth";
import { extractOrgFromEvent } from "../utils/auth-event";
import {
  getEnvironmentReleasePointer,
  listEnvironmentReleasePointersForAgent,
  setEnvironmentReleasePointer,
} from "./environment-release-pointer-store";
import type {
  AgentRelease,
  AuthContext,
  EnvironmentReleasePointer,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
  SetEnvironmentReleasePointerInput,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function agentReleasesTable(): string {
  return process.env.AGENT_RELEASES_TABLE!;
}

function requireReleasePromotePermission(authContext: AuthContext): void {
  if (!hasPermission(authContext, "release:promote")) {
    throw new Error(
      "UnauthorizedError: release:promote permission required to move an environment release pointer",
    );
  }
}

/**
 * Deferred quality-gating seam (mirrors release-resolver.ts's
 * validateReleaseGate — same pattern, separate seam because promotion
 * gating and cut-time gating are different concerns). Intentionally a
 * no-op and NOT called from promoteEnvironmentReleasePointer. Quality
 * gating (test pass rate, eval score thresholds, canary results) is a
 * later story; this exists purely so that story has a named place to hang
 * gate logic without an interface-shape migration.
 */
export function validateReleaseGate(): void {
  // Intentionally empty — see doc comment above.
}

async function getAgentRelease(
  releaseId: string,
): Promise<AgentRelease | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: agentReleasesTable(), Key: { releaseId } }),
  );
  return (res.Item as AgentRelease | undefined) ?? null;
}

/**
 * promoteEnvironmentReleasePointer — validates the target release EXISTS
 * and belongs to the caller's org, then moves the (org, agentTargetId,
 * environment) pointer to it via the version-gated write boundary in
 * environment-release-pointer-store.ts. Permission-gated by
 * release:promote (do not ship an ungated promotion path).
 *
 * Reads the current pointer first only to derive expectedVersion and
 * currentReleaseId for the store's optimistic-lock write — the actual
 * lock enforcement happens in the store's ConditionExpression, not by
 * this function re-checking the read after the fact. If another
 * promotion wins the race between this read and the store's write, the
 * store throws ConcurrentPromotionError, which propagates unchanged.
 */
export async function promoteEnvironmentReleasePointer(
  input: SetEnvironmentReleasePointerInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<EnvironmentReleasePointer> {
  requireReleasePromotePermission(authContext);

  const targetRelease = await getAgentRelease(input.releaseId);
  if (!targetRelease) {
    throw new Error(
      `ValidationError: target release not found: ${input.releaseId}`,
    );
  }
  if (targetRelease.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: release ${input.releaseId} belongs to a different org — an environment pointer must never point at another org's release`,
    );
  }

  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );

  return setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: input.releaseId,
    expectedVersion: currentPointer?.version ?? null,
    currentReleaseId: currentPointer?.releaseId ?? null,
    promotedBy: authContext.userId,
  });
}

/** Read: the current pointer for one agent+environment. Returns null when
 * nothing has ever been promoted for that pair. */
export async function getCurrentEnvironmentReleasePointer(
  orgId: string,
  agentTargetId: string,
  environment: SetEnvironmentReleasePointerInput["environment"],
): Promise<EnvironmentReleasePointer | null> {
  return getEnvironmentReleasePointer(orgId, agentTargetId, environment);
}

/** Read: every environment's pointer for one agent. */
export async function listEnvironmentReleasePointers(
  orgId: string,
  agentTargetId: string,
): Promise<EnvironmentReleasePointer[]> {
  return listEnvironmentReleasePointersForAgent(orgId, agentTargetId);
}

/** Merged view of every argument this resolver's fields receive. */
interface EnvironmentReleasePointerResolverArguments {
  input: SetEnvironmentReleasePointerInput;
  agentTargetId: string;
  environment: SetEnvironmentReleasePointerInput["environment"];
}

type EnvironmentReleasePointerResolverEvent =
  GovernanceResolverEvent<EnvironmentReleasePointerResolverArguments>;

function authContextFromEvent(
  event: EnvironmentReleasePointerResolverEvent,
): AuthContext {
  const identity: GovernanceEventIdentity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole as string] : [],
  };
}

/** Truncate long string values in event.arguments for safe error logging
 * (mirrors release-resolver.ts's sanitizeForLog convention). */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  return out;
}

export const handler = async (
  event: EnvironmentReleasePointerResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "promoteEnvironmentReleasePointer": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await promoteEnvironmentReleasePointer(
          event.arguments.input,
          authContext,
          callerOrgId,
        );
      }
      case "getCurrentEnvironmentReleasePointer": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await getCurrentEnvironmentReleasePointer(
          callerOrgId,
          event.arguments.agentTargetId,
          event.arguments.environment,
        );
      }
      case "listEnvironmentReleasePointers": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await listEnvironmentReleasePointers(
          callerOrgId,
          event.arguments.agentTargetId,
        );
      }
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("environment-release-pointer-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
