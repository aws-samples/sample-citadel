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
    const registryResult = await upsertRegistryRecord();

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

// ---------------------------------------------------------------------------
// Registry record upsert + submit for approval
// ---------------------------------------------------------------------------
interface RegistryResult {
  recordId: string;
  status: string;
}

async function upsertRegistryRecord(): Promise<RegistryResult> {
  const svc = getRegistryService();

  // Check if a record already exists by listing with a name filter
  try {
    const existing = await svc.getResource("tool", TOOL_ID);
    if (existing) {
      console.log(
        `Registry record for ${TOOL_ID} already exists (recordId=${existing.recordId}, status=${existing.status}).`,
      );
      // If already APPROVED, nothing to do.
      if (existing.status === "APPROVED") {
        return { recordId: existing.recordId, status: existing.status };
      }
      // If DRAFT, submit for approval.
      if (existing.status === "DRAFT") {
        console.log("Submitting existing DRAFT record for approval...");
        const approved = await svc.submitForApproval(existing.recordId);
        return {
          recordId: approved.recordId,
          status: approved.status ?? "PENDING_APPROVAL",
        };
      }
      // PENDING_APPROVAL or other — leave as-is.
      return {
        recordId: existing.recordId,
        status: existing.status ?? "unknown",
      };
    }
  } catch (err) {
    console.warn(
      "Registry lookup for existing record failed (will try create):",
      err,
    );
  }

  // Create the record
  const metadata = JSON.stringify({
    toolId: TOOL_ID,
    orgId: ORG_ID,
    inputSchema: INPUT_SCHEMA,
    contentHash: CONTENT_HASH,
    createdBy: "SYSTEM_SEED",
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

  // Submit for approval — with autoApproval on the registry this lands
  // APPROVED immediately. Without autoApproval, it lands on
  // PENDING_APPROVAL and must be approved once via the Approvals UI.
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
      status: created.status ?? "DRAFT",
    };
  }
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
};
