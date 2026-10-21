/**
 * Seed Smoke Echo Tool — CloudFormation Custom Resource Lambda.
 *
 * When SMOKE_FIXTURES_ENABLED is set and ENVIRONMENT !== 'prod':
 *   (a) Uploads tools/smoke-echo-tool/index.js to TOOLS_BUCKET
 *   (b) Creates a registry record via RegistryService and submits it for
 *       approval. With autoApproval configured, the record lands APPROVED
 *       immediately. Without autoApproval, it lands on PENDING_APPROVAL
 *       (documented below).
 *
 * Idempotent: content hash of the tool module is compared to the existing
 * S3 object's metadata tag — if unchanged, both S3 and registry writes
 * are skipped.
 */

import * as https from "https";
import * as url from "url";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  Context,
} from "aws-lambda";
import { createHash } from "crypto";
import { RegistryService } from "../../services/registry-service";

const TOOL_ID = "smoke-echo-tool";
const ORG_ID = "Default";
const S3_KEY = `tools/${TOOL_ID}/index.js`;

// ---------------------------------------------------------------------------
// Tool module source — a minimal echo tool for the Node VM sandbox.
// ---------------------------------------------------------------------------
const TOOL_MODULE_SOURCE = `/**
 * Smoke Echo Tool — returns its inputs plus a diagnostic timestamp.
 * Loaded by tool-sandbox as tools/smoke-echo-tool/index.js from TOOLS_BUCKET.
 */
module.exports = (inputs, credentials) => ({
  ...inputs,
  tool: '${TOOL_ID}',
  ts: new Date().toISOString(),
});
`;

const CONTENT_HASH = createHash("sha256")
  .update(TOOL_MODULE_SOURCE)
  .digest("hex");

const INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    message: { type: "string", description: "Echo payload" },
  },
  required: ["message"],
});

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------
let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) s3Client = new S3Client({});
  return s3Client;
}

let registryService: RegistryService | null = null;
function getRegistryService(): RegistryService {
  if (!registryService) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) throw new Error("REGISTRY_ID is required");
    registryService = new RegistryService({
      registryId,
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return registryService;
}

// ---------------------------------------------------------------------------
// Poll budget helper — derive the maximum time we can spend polling from the
// Lambda's remaining execution time so a CFN response is ALWAYS sent before
// the function dies.  Subtracts a 10 s safety margin and caps at 60 s.
// ---------------------------------------------------------------------------
const SAFETY_MARGIN_MS = 10_000;
const MAX_POLL_BUDGET_MS = 60_000;

export function pollBudgetMs(
  context: Pick<Context, "getRemainingTimeInMillis">,
): number {
  const remaining = context.getRemainingTimeInMillis() - SAFETY_MARGIN_MS;
  return Math.max(0, Math.min(remaining, MAX_POLL_BUDGET_MS));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler: CloudFormationCustomResourceHandler = async (
  event: CloudFormationCustomResourceEvent,
  context: Context,
) => {
  console.log("Event:", JSON.stringify(event));
  try {
    if (event.RequestType === "Delete") {
      // Nothing to clean up — smoke fixtures are left in place.
      await sendCfnResponse(event, context, "SUCCESS", {
        message: "Delete: no-op",
      });
      return;
    }

    const environment = process.env.ENVIRONMENT ?? "";
    const smokeEnabled = process.env.SMOKE_FIXTURES_ENABLED === "true";
    const toolsBucket = process.env.TOOLS_BUCKET;

    if (environment === "prod") {
      console.log("Production environment — skipping smoke tool seed.");
      await sendCfnResponse(event, context, "SUCCESS", {
        message: "Skipped: production environment",
      });
      return;
    }

    if (!smokeEnabled) {
      console.log("SMOKE_FIXTURES_ENABLED is not true — skipping.");
      await sendCfnResponse(event, context, "SUCCESS", {
        message: "Skipped: smoke fixtures disabled",
      });
      return;
    }

    if (!toolsBucket) {
      throw new Error("TOOLS_BUCKET environment variable is required");
    }

    // --- (a) Upload tool module to S3 (idempotent via content hash) --------
    const uploaded = await uploadToolModule(toolsBucket);

    // --- (b) Upsert registry record ----------------------------------------
    const registryResult = await upsertRegistryRecord(context);

    await sendCfnResponse(event, context, "SUCCESS", {
      toolId: TOOL_ID,
      contentHash: CONTENT_HASH,
      s3Uploaded: String(uploaded),
      registryStatus: registryResult.status,
      registryRecordId: registryResult.recordId,
    });
  } catch (err) {
    console.error("Seed smoke echo tool failed:", err);
    await sendCfnResponse(event, context, "FAILED", {
      error: String(err),
    });
  }
};

// ---------------------------------------------------------------------------
// S3 upload with content-hash idempotency
// ---------------------------------------------------------------------------
async function uploadToolModule(bucket: string): Promise<boolean> {
  // Check existing object's content hash tag
  try {
    const head = await getS3().send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: S3_KEY,
      }),
    );
    if (head.Metadata?.["content-hash"] === CONTENT_HASH) {
      console.log(`S3 ${S3_KEY}: content hash unchanged — skipping upload.`);
      return false;
    }
  } catch (err: unknown) {
    // Object doesn't exist yet — proceed with upload.
    const code = (err as { name?: string })?.name;
    if (code !== "NotFound" && code !== "NoSuchKey") {
      console.warn("HeadObject check failed (proceeding with upload):", err);
    }
  }

  await getS3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: S3_KEY,
      Body: TOOL_MODULE_SOURCE,
      ContentType: "application/javascript",
      Metadata: { "content-hash": CONTENT_HASH },
    }),
  );
  console.log(`S3 ${S3_KEY}: uploaded (hash=${CONTENT_HASH}).`);
  return true;
}

/**
 * Upload a copy of the tool module under `tools/<recordId>/index.js` so the
 * sandbox fallback (`tools/${toolId}/index.js` where toolId = recordId) also
 * resolves.
 */
async function uploadToolModuleByRecordId(
  bucket: string,
  recordId: string,
): Promise<void> {
  const key = `tools/${recordId}/index.js`;
  // Skip when recordId matches the friendly name (no copy needed).
  if (key === S3_KEY) return;
  try {
    const head = await getS3().send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (head.Metadata?.["content-hash"] === CONTENT_HASH) {
      console.log(`S3 ${key}: content hash unchanged — skipping copy.`);
      return;
    }
  } catch {
    // Object doesn't exist yet — proceed.
  }
  await getS3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: TOOL_MODULE_SOURCE,
      ContentType: "application/javascript",
      Metadata: { "content-hash": CONTENT_HASH },
    }),
  );
  console.log(`S3 ${key}: uploaded recordId copy (hash=${CONTENT_HASH}).`);
}

// ---------------------------------------------------------------------------
// Registry record upsert + submit for approval
// ---------------------------------------------------------------------------
interface RegistryResult {
  recordId: string;
  status: string;
}

async function upsertRegistryRecord(context: Context): Promise<RegistryResult> {
  const svc = getRegistryService();

  // Idempotent: find existing record by name so re-runs don't create
  // duplicates. listResourceSummaries returns all CUSTOM records with
  // recordId/name/status — sufficient for the name filter.
  let existing: { recordId: string; status: string } | undefined;
  try {
    const summaries = await svc.listResourceSummaries();
    const match = summaries.find((s: { name?: string }) => s.name === TOOL_ID);
    if (match?.recordId) {
      existing = { recordId: match.recordId, status: match.status ?? "" };
    }
  } catch (err) {
    console.warn(
      "Registry list lookup failed (will try getResource fallback):",
      err,
    );
  }

  // Fallback: try direct getResource (works when the recordId IS the name).
  if (!existing) {
    try {
      const record = await svc.getResource("tool", TOOL_ID);
      if (record) {
        existing = { recordId: record.recordId, status: record.status };
      }
    } catch (err) {
      console.warn(
        "Registry getResource fallback failed (will try create):",
        err,
      );
    }
  }

  if (existing) {
    console.log(
      `Registry record for ${TOOL_ID} already exists (recordId=${existing.recordId}, status=${existing.status}).`,
    );
    // Upload the recordId copy so the sandbox fallback works.
    const toolsBucket = process.env.TOOLS_BUCKET;
    if (toolsBucket) {
      await uploadToolModuleByRecordId(toolsBucket, existing.recordId);
    }
    if (existing.status === "APPROVED") {
      return { recordId: existing.recordId, status: existing.status };
    }
    if (existing.status === "DRAFT") {
      console.log("Submitting existing DRAFT record for approval...");
      try {
        const approved = await svc.submitForApproval(existing.recordId);
        return {
          recordId: approved.recordId,
          status: approved.status ?? "PENDING_APPROVAL",
        };
      } catch (err) {
        console.warn("submitForApproval on existing DRAFT failed:", err);
        return { recordId: existing.recordId, status: existing.status };
      }
    }
    // PENDING_APPROVAL, CREATING, or other — leave as-is.
    return {
      recordId: existing.recordId,
      status: existing.status ?? "unknown",
    };
  }

  // Create the record — include codeKey so the sandbox can resolve code by
  // the original upload key rather than the registry-assigned recordId.
  const metadata = JSON.stringify({
    citadelKind: "tool" as const,
    toolId: TOOL_ID,
    orgId: ORG_ID,
    inputSchema: INPUT_SCHEMA,
    contentHash: CONTENT_HASH,
    createdBy: "SYSTEM_SEED",
    codeKey: `tools/${TOOL_ID}`,
  });

  const created = await svc.createResource("tool", TOOL_ID, {
    name: TOOL_ID,
    description:
      "Smoke echo tool — returns inputs with a timestamp for non-prod testing.",
    customMetadata: metadata,
  });

  console.log(
    `Registry record created: recordId=${created.recordId}, status=${created.status}`,
  );

  // Upload a copy under tools/<recordId>/index.js so the sandbox fallback
  // (`tools/${toolId}/index.js` where toolId = recordId) also resolves.
  const toolsBucket = process.env.TOOLS_BUCKET;
  if (toolsBucket) {
    await uploadToolModuleByRecordId(toolsBucket, created.recordId);
  }

  // Poll until the record leaves CREATING — submitForApproval on a
  // CREATING record throws ConflictException.
  const stableStatus = await waitForRecordReady(
    svc,
    created.recordId,
    pollBudgetMs(context),
  );
  if (stableStatus === "CREATING") {
    console.warn(
      `Registry record ${created.recordId} still CREATING after timeout — leaving as DRAFT.`,
    );
    return { recordId: created.recordId, status: "CREATING" };
  }

  try {
    const approved = await svc.submitForApproval(created.recordId);
    console.log(
      `Registry record submitted for approval: status=${approved.status}`,
    );
    return {
      recordId: approved.recordId,
      status: approved.status ?? "PENDING_APPROVAL",
    };
  } catch (err) {
    console.warn("submitForApproval failed (non-fatal):", err);
    return {
      recordId: created.recordId,
      status: stableStatus ?? created.status ?? "DRAFT",
    };
  }
}

/**
 * Poll the registry record until it leaves CREATING state (bounded with
 * exponential backoff). Returns the settled status or "CREATING" on timeout.
 */
async function waitForRecordReady(
  svc: RegistryService,
  recordId: string,
  maxWaitMs: number,
): Promise<string> {
  const start = Date.now();
  let delayMs = 1000;
  while (Date.now() - start < maxWaitMs) {
    try {
      const record = await svc.getResource("tool", recordId);
      if (record && record.status !== "CREATING") {
        return record.status;
      }
    } catch (err) {
      console.warn("waitForRecordReady: poll error (retrying):", err);
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 8000);
  }
  return "CREATING";
}

// ---------------------------------------------------------------------------
// CloudFormation Custom Resource response helper
// ---------------------------------------------------------------------------
async function sendCfnResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: "SUCCESS" | "FAILED",
  data: Record<string, string>,
): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason: data.error ?? `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId:
      event.RequestType === "Create" ? TOOL_ID : event.PhysicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const parsedUrl = url.parse(event.ResponseURL);
  const options: https.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: "PUT",
    headers: {
      "Content-Type": "",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, () => resolve());
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------
export function _resetSeedSmokeEchoTool(): void {
  s3Client = null;
  registryService = null;
}

export {
  TOOL_ID,
  ORG_ID,
  CONTENT_HASH,
  TOOL_MODULE_SOURCE,
  INPUT_SCHEMA,
  S3_KEY,
  SAFETY_MARGIN_MS,
  MAX_POLL_BUDGET_MS,
};
