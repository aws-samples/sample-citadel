/**
 * eval-artifact-store (CIT-102 Pass A, F4) — per-case replay-package
 * materialization to the shared replay bucket, RUNTIME-resolved via SSM.
 *
 * DECISION d36fbbf7 (binding): the replay-package bucket name is published
 * by TelemetryStack to an SSM parameter (`/citadel/eval-replay-bucket-${env}`,
 * naming mirrors the existing convention — see e.g.
 * `/citadel/session-bucket-${env}` in services-stack.ts) rather than passed
 * as a synth-time CDK construct prop. This is required because
 * TelemetryStack (owner of `replayPackageBucket`) instantiates AFTER
 * GovernanceStack (owner of every eval Lambda) in bin/app.ts — a direct
 * cross-stack construct reference would require reordering stack
 * instantiation, an architectural change out of scope for this pass.
 *
 * Resolution is lazy (first call only) and cached for the remainder of the
 * Lambda execution environment's lifetime (module-level singleton, the same
 * pattern already used for connection/client reuse across warm invocations
 * elsewhere in this codebase) — one `ssm:GetParameter` call per cold start,
 * not per case.
 *
 * Graceful degradation (fresh-account bootstrap): if the parameter does not
 * exist yet (`ParameterNotFound`), this module NEVER throws. It logs an
 * explicit WARN naming the parameter and returns `null`; callers must treat
 * a `null` bucket name as "skip materialization, leave artifactRef unset"
 * — never fail the eval case over a missing artifact.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  assembleReplayPackage,
  type ReplayKind,
} from "./replay-package-builder";

const ssmClient = new SSMClient({});
const s3Client = new S3Client({});

function replayBucketParamName(): string {
  const environment = process.env.ENVIRONMENT || "dev";
  return `/citadel/eval-replay-bucket-${environment}`;
}

// Module-level cache: resolved once per warm Lambda execution environment.
// `undefined` = not yet attempted; `null` = attempted and the parameter was
// absent (fresh-account bootstrap — cached as a negative result so a
// persistently-missing parameter does not retry ssm:GetParameter on every
// case in the same warm container); a string = the resolved bucket name.
let cachedBucketName: string | null | undefined;

function isParameterNotFound(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ParameterNotFound"
  );
}

/**
 * Resolve the replay-package bucket name via SSM, cached for the lifetime
 * of the execution environment. Never throws: returns `null` on any
 * resolution failure (missing parameter, or any other SSM error), logging
 * an explicit WARN naming the parameter so an operator can find the gap
 * (e.g. a fresh account that has not yet deployed TelemetryStack).
 */
export async function resolveReplayBucketName(): Promise<string | null> {
  if (cachedBucketName !== undefined) {
    return cachedBucketName;
  }

  const paramName = replayBucketParamName();

  try {
    const resp = await ssmClient.send(
      new GetParameterCommand({ Name: paramName }),
    );
    const value = resp.Parameter?.Value;
    if (!value) {
      console.warn(
        `eval-artifact-store: SSM parameter ${paramName} resolved with no value — artifact materialization degraded (artifactRef will be left unset)`,
      );
      cachedBucketName = null;
      return null;
    }
    cachedBucketName = value;
    return value;
  } catch (err: unknown) {
    if (isParameterNotFound(err)) {
      console.warn(
        `eval-artifact-store: SSM parameter ${paramName} not found — fresh-account bootstrap or TelemetryStack not yet deployed. Artifact materialization degraded (artifactRef will be left unset).`,
      );
    } else {
      console.warn(
        `eval-artifact-store: failed to resolve SSM parameter ${paramName} — artifact materialization degraded (artifactRef will be left unset)`,
        err,
      );
    }
    cachedBucketName = null;
    return null;
  }
}

/** Test-only escape hatch — resets the module-level cache between tests. */
export function __resetReplayBucketCacheForTests(): void {
  cachedBucketName = undefined;
}

export interface MaterializeArtifactResult {
  artifactRef: string | null;
  artifactKind: ReplayKind | null;
}

/**
 * Build the replay package for one completed eval case (via the UNCHANGED
 * `assembleReplayPackage` — design §6) and write it to the replay bucket
 * under the exact prefix `eval-runs/{evalRunId}/{caseId}.json`.
 *
 * Never throws: any failure (bucket unresolved, assembleReplayPackage
 * error, S3 write error) is caught, logged, and results in
 * `{artifactRef: null, artifactKind: null}` so a single case's artifact
 * failure can never fail the case's own completion recording.
 */
export async function materializeEvalCaseArtifact(
  evalRunId: string,
  caseId: string,
  orgId: string,
  kind: ReplayKind,
  sourceId: string,
): Promise<MaterializeArtifactResult> {
  const bucketName = await resolveReplayBucketName();
  if (!bucketName) {
    // Graceful degradation already logged by resolveReplayBucketName.
    return { artifactRef: null, artifactKind: null };
  }

  try {
    const envelope = await assembleReplayPackage(orgId, kind, sourceId);
    const key = `eval-runs/${evalRunId}/${caseId}.json`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: JSON.stringify(envelope),
        ContentType: "application/json",
      }),
    );

    return { artifactRef: key, artifactKind: kind };
  } catch (err: unknown) {
    console.error(
      "eval-artifact-store: materializeEvalCaseArtifact failed — leaving artifactRef unset",
      {
        evalRunId,
        caseId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { artifactRef: null, artifactKind: null };
  }
}
