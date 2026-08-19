/**
 * release-diff-resolver.ts — releaseDiff(releaseIdA, releaseIdB) query.
 *
 * Read-only. Resolves both AgentRelease rows (release-store.ts's
 * getRelease — the SOLE reader for AgentReleasesTable, same as
 * release-resolver.ts / environment-release-pointer-resolver.ts already
 * do for their own release reads), enforces org-scoped access identical
 * to every other release read in this codebase (compare
 * release.orgId === callerOrgId, reject cross-org — see
 * environment-release-pointer-resolver.ts's promoteEnvironmentReleasePointer
 * "belongs to a different org" checks), then delegates the actual
 * semantic diff to the pure release-diff.ts module.
 *
 * PERMISSION SCOPE (grounded in existing precedent): there is no
 * `release:read` permission anywhere in this codebase (auth.ts) — every
 * existing release READ (getCurrentEnvironmentReleasePointer,
 * listEnvironmentReleasePointers, environmentReleasePointerHistory in
 * environment-release-pointer-resolver.ts) is gated by org-membership
 * ALONE, with no additional permission check. releaseDiff follows that
 * exact precedent rather than inventing a new permission that nothing
 * else in the schema requires for a read.
 *
 * SCORE-VECTOR RESOLUTION: AgentReleaseConstituents.evalEvidence is a
 * pointer (evalRunId/evalSuiteId/evalSuiteVersion), not the score
 * vector itself (see release-diff.ts's module doc). This resolver reads
 * each side's EvalRun row and parses its `scoreAggregates` (AWSJSON —
 * serialized DimensionAggregate[], CIT-103) to get the actual vectors,
 * then calls the pure `releaseDiffWithScoreVectors`. A side whose
 * EvalRun is missing, or has not yet been scored (scoreAggregates
 * absent), contributes an EMPTY vector for that side — never a thrown
 * error and never a fabricated aggregate — so the query still returns
 * the constituent-level diff even when eval evidence isn't (yet)
 * scored on one or both sides.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { extractOrgFromEvent } from "../utils/auth-event";
import { getRelease } from "./release-store";
import { releaseDiffWithScoreVectors } from "./utils/release-diff";
import type { DimensionAggregate } from "./utils/eval-score-aggregate";
import type { AgentRelease, EvalRun, GovernanceResolverEvent } from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function evalRunsTable(): string {
  return process.env.EVAL_RUNS_TABLE!;
}

async function getEvalRun(evalRunId: string): Promise<EvalRun | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: evalRunsTable(), Key: { evalRunId } }),
  );
  return (res.Item as EvalRun | undefined) ?? null;
}

/** Resolves a release's score vector for diffing. Never throws: missing
 * run, or a run not yet scored, both resolve to an empty vector — the
 * diff then reports every dimension present on the OTHER side as
 * "added"/"removed" rather than failing the whole query. A malformed
 * (non-JSON) scoreAggregates string is treated the same way (empty),
 * consistent with this codebase's "absent until scored" doctrine for
 * that field (see ../types.ts EvalRun.scoreAggregates doc). */
async function resolveScoreVector(
  release: AgentRelease,
): Promise<DimensionAggregate[]> {
  const run = await getEvalRun(release.evalEvidence.evalRunId);
  if (!run?.scoreAggregates) {
    return [];
  }
  try {
    const parsed = JSON.parse(run.scoreAggregates);
    return Array.isArray(parsed) ? (parsed as DimensionAggregate[]) : [];
  } catch {
    return [];
  }
}

export class ReleaseNotFoundError extends Error {
  constructor(public readonly releaseId: string) {
    super(`ValidationError: release not found: ${releaseId}`);
    this.name = "ReleaseNotFoundError";
  }
}

/** Distinct from the generic ValidationError bucket — mirrors this
 * codebase's "malformed input" vs "attempted to read another tenant's
 * data" distinction (release-resolver.ts / environment-release-pointer-
 * resolver.ts module docs). */
export class CrossOrgReleaseDiffError extends Error {
  constructor(public readonly releaseId: string) {
    super(
      `SecurityError: release ${releaseId} belongs to a different org — releaseDiff must never compare across tenants`,
    );
    this.name = "CrossOrgReleaseDiffError";
  }
}

async function getOwnReleaseOrThrow(
  releaseId: string,
  callerOrgId: string,
): Promise<AgentRelease> {
  const release = await getRelease(releaseId);
  if (!release) {
    throw new ReleaseNotFoundError(releaseId);
  }
  if (release.orgId !== callerOrgId) {
    throw new CrossOrgReleaseDiffError(releaseId);
  }
  return release;
}

export interface ReleaseDiffQueryResult {
  releaseIdA: string;
  releaseIdB: string;
  changes: ReturnType<typeof releaseDiffWithScoreVectors>["changes"];
}

/**
 * releaseDiff(releaseIdA, releaseIdB) — read-only, org-scoped semantic
 * diff between two immutable AgentRelease bundles. Both releases must
 * belong to the caller's org (CrossOrgReleaseDiffError otherwise); both
 * must exist (ReleaseNotFoundError otherwise). Delegates constituent
 * diffing to the pure release-diff.ts module; resolves each side's
 * score vector from its EvalRun row (see resolveScoreVector doc) before
 * calling releaseDiffWithScoreVectors, so score-vector movement is
 * included as one additional "scoreVector" entry alongside every other
 * changed constituent.
 */
export async function releaseDiff(
  releaseIdA: string,
  releaseIdB: string,
  callerOrgId: string,
): Promise<ReleaseDiffQueryResult> {
  const [releaseA, releaseB] = await Promise.all([
    getOwnReleaseOrThrow(releaseIdA, callerOrgId),
    getOwnReleaseOrThrow(releaseIdB, callerOrgId),
  ]);

  const [scoreVectorA, scoreVectorB] = await Promise.all([
    resolveScoreVector(releaseA),
    resolveScoreVector(releaseB),
  ]);

  const { changes } = releaseDiffWithScoreVectors(
    releaseA,
    releaseB,
    scoreVectorA,
    scoreVectorB,
  );

  return { releaseIdA, releaseIdB, changes };
}

/** Merged view of every argument this resolver's fields receive. */
interface ReleaseDiffResolverArguments {
  releaseIdA: string;
  releaseIdB: string;
}

type ReleaseDiffResolverEvent =
  GovernanceResolverEvent<ReleaseDiffResolverArguments>;

/** Truncate long string values in event.arguments for safe error logging
 * — mirrors release-resolver.ts's / environment-release-pointer-
 * resolver.ts's sanitizeForLog convention. */
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
  event: ReleaseDiffResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  try {
    switch (fieldName) {
      case "releaseDiff": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await releaseDiff(
          event.arguments.releaseIdA,
          event.arguments.releaseIdB,
          callerOrgId,
        );
      }
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("release-diff-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
