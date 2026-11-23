/**
 * Seed Smoke Echo Tool — CloudFormation Custom Resource Lambda.
 *
 * When SMOKE_FIXTURES_ENABLED is set and ENVIRONMENT !== 'prod': creates a
 * registry record for the smoke echo tool with a `lambda` integration
 * binding pointed at `SmokeEchoLambdaFunction` (see
 * `smoke-echo-lambda.ts`), and submits it for approval. With autoApproval
 * configured, the record lands APPROVED immediately. Without autoApproval,
 * it lands on PENDING_APPROVAL (documented below).
 *
 * Replaces the retired vm-sandbox fixture (board task 10c3bf48 Slice 2):
 * `deployed-smoke.mjs`'s `test-tool` check runs `testTool` against this
 * tool, so a runnable fixture is still required — it is now a real
 * Lambda invoked through the worker's governed `invoke_binding("lambda")`
 * path instead of JS uploaded to an S3 bucket and run in-process.
 *
 * Idempotent: re-runs are detected by a content hash of the binding
 * descriptor (toolId + function ARN) compared against the existing
 * registry record's stored hash — if unchanged, the registry write is
 * skipped.
 */

import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  Context,
} from "aws-lambda";
import { createHash } from "crypto";
import * as https from "https";
import * as url from "url";
import { RegistryService } from "../../services/registry-service";

const TOOL_ID = "smoke-echo-tool";
const ORG_ID = "Default";

const INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    message: { type: "string", description: "Echo payload" },
  },
  required: ["message"],
});

function contentHashFor(functionArn: string): string {
  return createHash("sha256").update(`${TOOL_ID}:${functionArn}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------
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
    const echoFunctionArn = process.env.SMOKE_ECHO_FUNCTION_ARN;

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

    if (!echoFunctionArn) {
      throw new Error(
        "SMOKE_ECHO_FUNCTION_ARN environment variable is required",
      );
    }

    const contentHash = contentHashFor(echoFunctionArn);
    const registryResult = await upsertRegistryRecord(
      context,
      echoFunctionArn,
      contentHash,
    );

    await sendCfnResponse(event, context, "SUCCESS", {
      toolId: TOOL_ID,
      contentHash,
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
// Registry record upsert + submit for approval
// ---------------------------------------------------------------------------
interface RegistryResult {
  recordId: string;
  status: string;
}

async function upsertRegistryRecord(
  context: Context,
  functionArn: string,
  contentHash: string,
): Promise<RegistryResult> {
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

  // Create the record with a `lambda` integration binding pointed at the
  // echo function — this is what the worker's `invoke_binding("lambda")`
  // dispatches on (`resolve_binding_type` reads `integrationType`,
  // `_invoke_lambda_binding` reads `functionArn`).
  const metadata = JSON.stringify({
    citadelKind: "tool" as const,
    toolId: TOOL_ID,
    orgId: ORG_ID,
    inputSchema: INPUT_SCHEMA,
    contentHash,
    createdBy: "SYSTEM_SEED",
    integrationBindings: [
      {
        integrationId: "smoke-echo-lambda",
        integrationType: "lambda",
        functionArn,
      },
    ],
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
  registryService = null;
}

export { TOOL_ID, ORG_ID, INPUT_SCHEMA, SAFETY_MARGIN_MS, MAX_POLL_BUDGET_MS };
