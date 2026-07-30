/**
 * Replay Package Handler — read-only Lambda (HTTP API payload format 2.0)
 * branching on `routeKey` for the 2 replay-package routes (CIT-026 design
 * §2/§4):
 *   GET /replay/by-execution/{executionId}       # ownership-gated
 *   GET /replay/by-conversation/{conversationId} # ownership-gated
 *
 * BINDING INVARIANTS (design §"Invariants", enforced in this file):
 *   1. Fail-closed gate: a secret hit -> no S3 write, no URL, structured
 *      error with pattern IDs only. Enforced structurally: the S3
 *      PutObjectCommand is only ever constructed AFTER
 *      assembleReplayPackage resolves successfully (which itself runs
 *      assertBundleSecretFree before returning) — see handleEntryKeyRoute.
 *      A gate throw (ReplaySecretLeakError) or a cross-org row throw
 *      (CrossOrgRowError) is caught below and turned into a 5xx/404 with
 *      NO PutObjectCommand ever constructed.
 *   2. No source table is ever written; this handler's IAM role
 *      (telemetry-stack.ts) has zero write + zero xray:Put — S3 write is
 *      scoped ONLY to the new replay bucket.
 *   3. Cross-org impossible: ownership check (this file) + per-row orgId
 *      filter (replay-package-builder.ts) + gate refusal.
 *   4. Presigned TTL <= 5 min (REPLAY_PRESIGN_TTL_SECONDS, default 300).
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import {
  badRequest,
  forbidden,
  json,
  notFound,
  extractOrgFromHttpEvent,
  resolveExecutionOwnership,
  resolveConversationOwnership,
  type HttpResponse,
} from "./utils/trace-http-shared";
import {
  assembleReplayPackage,
  CrossOrgRowError,
  ReplayNotFoundError,
  type ReplayKind,
} from "./utils/replay-package-builder";
import { ReplaySecretLeakError } from "./utils/replay-sanitize";

const s3Client = new S3Client({});

/** Hard ceiling — even if REPLAY_PRESIGN_TTL_SECONDS is misconfigured
 * upward, the presigned URL TTL never exceeds 5 minutes (design invariant
 * 4). Env var may only ever LOWER this, never raise it. */
const MAX_PRESIGN_TTL_SECONDS = 300;

function resolvePresignTtlSeconds(): number {
  const configured = Number(process.env.REPLAY_PRESIGN_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0)
    return MAX_PRESIGN_TTL_SECONDS;
  return Math.min(configured, MAX_PRESIGN_TTL_SECONDS);
}

function replayObjectKey(
  orgId: string,
  kind: ReplayKind,
  id: string,
  packageId: string,
): string {
  return `ORG#${orgId}/${kind}-${id}/${packageId}.json`;
}

async function handleEntryKeyRoute(
  orgId: string,
  kind: ReplayKind,
  id: string,
): Promise<HttpResponse> {
  let bundle;
  try {
    bundle = await assembleReplayPackage(orgId, kind, id);
  } catch (err) {
    if (err instanceof ReplayNotFoundError) {
      return notFound();
    }
    if (err instanceof CrossOrgRowError) {
      // Defence-in-depth: the entry-key ownership check already passed,
      // but a sourced row disagreed on org — refuse rather than leak.
      console.error("replay-package-handler: cross-org row refused", {
        kind,
        id,
        message: err.message,
      });
      return forbidden();
    }
    if (err instanceof ReplaySecretLeakError) {
      // FAIL-CLOSED (invariant 1): no S3 write below this point, no URL.
      // Pattern IDs are log-safe (never the raw matched value) — safe to
      // surface to the caller, but the response never contains the
      // underlying secret text.
      console.error("replay-package-handler: secret gate refused publication", {
        kind,
        id,
        patternIds: err.patternIds,
      });
      return json(500, {
        error:
          "Replay package could not be produced: sanitisation gate refused publication.",
        patternIds: err.patternIds,
      });
    }
    console.error("replay-package-handler: unexpected build error", {
      kind,
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "Internal server error" });
  }

  const bucket = process.env.REPLAY_BUCKET!;
  const packageId = `${Date.now()}`;
  const key = replayObjectKey(orgId, kind, id, packageId);

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(bundle),
        ContentType: "application/json",
      }),
    );
  } catch (err) {
    console.error("replay-package-handler: S3 write failed", {
      kind,
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "Internal server error" });
  }

  // Design §2b: the client only ever DOWNLOADS the sanitized package —
  // presign a GET, never a PUT. A PUT-signed URL would (a) break the
  // browser's window.open GET, and (b) hand the client a write-capable URL
  // that could overwrite the gate-sanitized artifact post-publish.
  const ttlSeconds = resolvePresignTtlSeconds();
  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: ttlSeconds },
  );

  return json(200, {
    query: { kind, id, correlationId: bundle.correlationId },
    url,
    expiresInSeconds: ttlSeconds,
    schemaVersion: bundle.schemaVersion,
  });
}

async function handleByExecution(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const executionId = event.pathParameters?.executionId;
  if (!executionId) return badRequest("executionId is required");

  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return forbidden();

  // Ownership resolved BEFORE any build/S3 call — same discipline as
  // trace-query-handler.ts's invariant 1.
  const ownership = await resolveExecutionOwnership(executionId);
  if (!ownership.ok) return notFound();

  if (ownership.orgId !== claimOrg) {
    // Design §2a: ownership-gated for ALL org members, not admin-only —
    // there is no admin-bypass branch here (unlike the trace viewer's raw
    // /traces/{traceId} route, which has no entry-key at all). Not-found
    // posture on mismatch avoids existence disclosure, mirroring the trace
    // viewer's convention.
    return notFound();
  }

  return handleEntryKeyRoute(ownership.orgId, "execution", executionId);
}

async function handleByConversation(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const conversationId = event.pathParameters?.conversationId;
  if (!conversationId) return badRequest("conversationId is required");

  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return forbidden();

  const ownership = await resolveConversationOwnership(conversationId);
  if (!ownership.ok) return notFound();

  if (ownership.orgId !== claimOrg) {
    return notFound();
  }

  return handleEntryKeyRoute(ownership.orgId, "conversation", conversationId);
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> => {
  try {
    switch (event.routeKey) {
      case "GET /replay/by-execution/{executionId}":
        return await handleByExecution(event);
      case "GET /replay/by-conversation/{conversationId}":
        return await handleByConversation(event);
      default:
        return notFound();
    }
  } catch (err: unknown) {
    console.error("replay-package-handler: unhandled error", {
      routeKey: event.routeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "Internal server error" });
  }
};
