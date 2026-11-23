/**
 * Tool Run Resolver
 *
 * Backs Mutation.testTool(toolId, inputs): ToolTestResult by a synchronous
 * RequestResponse `lambda:InvokeFunction` on the worker wrapper Lambda with
 * a `{kind: 'tool-run'}` request, replacing the ungoverned in-Lambda `vm`
 * sandbox (`tool-sandbox.ts`, retired — see board task 10c3bf48 Slice 2).
 *
 * The mutation's signature and ToolTestResult shape are UNCHANGED — this
 * is a signature-stable cutover of the backing implementation only.
 *
 * Authorization is unchanged from the former sandbox handler: `tool:execute`
 * (architect/admin via the `hasPermission` bypass), server-derived caller
 * org (never a client-supplied value), and a cross-org/missing tool both
 * report the identical "Tool not found" string (no existence disclosure
 * across tenants — mirrors `getToolConfigRegistry`'s guard).
 *
 * `runId` is always minted HERE, server-side, and sent to the worker —
 * never accepted from the client argument, even if present. The worker
 * re-checks the caller org against the tool's own org row as a second,
 * independent layer (`tool_run_handler.process_tool_run` ->
 * `tenant_guard.require_same_org`) — this resolver's check is the primary
 * gate but is not the only one.
 */

import { randomUUID } from "crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { resolveToolConfig } from "./utils/resolve-tool-config";
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  requireCallerOrg,
  deriveRoles,
} from "../utils/auth-event";
import { hasPermission } from "../utils/auth";
import type { AuthContext } from "../types";

const lambda = new LambdaClient({});

/** Sentinel org value for system-seeded / shared tool records. */
const ALL_ORGANIZATIONS = "All Organizations";

/** Per-binding worker budget (~20s) leaves headroom inside this. Matches
 * the architect design's documented risk mitigation — NOT a Lambda
 * reserved-concurrency change in this slice. */
const DEFAULT_CLIENT_TIMEOUT_MS = 25_000;

/** Caps the serialized `inputs` payload sent to the worker. */
const MAX_INPUTS_BYTES = 256 * 1024;

export interface ToolTestResult {
  success: boolean;
  output?: unknown;
  error?: string;
  executionTimeMs: number;
}

interface WorkerToolRunResult {
  runId: string;
  status: "success" | "error";
  output?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
}

interface ToolRunEventIdentity {
  sub?: string;
  username?: string;
  ["custom:role"]?: string;
  ["cognito:groups"]?: string[];
  claims?: Record<string, unknown> | null;
}

function authContextFromEvent(
  identity: ToolRunEventIdentity | undefined,
): AuthContext {
  return {
    userId: identity?.sub || identity?.username || "anonymous",
    username: identity?.username,
    groups: identity?.["cognito:groups"] || [],
    roles: deriveRoles({ identity }),
  };
}

function parseInputs(
  inputsJson: string | Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false } {
  if (typeof inputsJson === "string") {
    if (Buffer.byteLength(inputsJson, "utf8") > MAX_INPUTS_BYTES) {
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(inputsJson) };
    } catch {
      return { ok: false };
    }
  }
  if (
    typeof inputsJson === "object" &&
    inputsJson !== null &&
    !Array.isArray(inputsJson)
  ) {
    if (
      Buffer.byteLength(JSON.stringify(inputsJson), "utf8") > MAX_INPUTS_BYTES
    ) {
      return { ok: false };
    }
    return { ok: true, value: inputsJson };
  }
  return { ok: false };
}

/** Invoke the worker wrapper Lambda with a bounded client-side timeout.
 * The worker ARN is read from `WORKER_WRAPPER_FUNCTION_ARN` (wired via
 * CDK env, scoped `lambda:InvokeFunction` grant — see services-stack.ts). */
async function invokeWorkerToolRun(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<WorkerToolRunResult> {
  const functionArn = process.env.WORKER_WRAPPER_FUNCTION_ARN;
  if (!functionArn) {
    throw new Error("WORKER_WRAPPER_FUNCTION_ARN is not configured");
  }

  const invokePromise = lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`TIMEOUT: tool run exceeded ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  const response = await Promise.race([invokePromise, timeoutPromise]);
  const rawPayload = response.Payload
    ? Buffer.from(response.Payload as Uint8Array).toString("utf8")
    : "";
  if (!rawPayload) {
    throw new Error("BINDING_ERROR: worker returned an empty response");
  }
  return JSON.parse(rawPayload) as WorkerToolRunResult;
}

export async function handler(
  event: {
    identity?: ToolRunEventIdentity;
    arguments: {
      toolId: string;
      inputs: string | Record<string, unknown>;
    };
  },
  options?: { timeoutMs?: number },
): Promise<ToolTestResult> {
  const startTime = Date.now();
  const { toolId, inputs: inputsJson } = event.arguments;
  const authContext = authContextFromEvent(event.identity);

  if (!hasPermission(authContext, "tool:execute")) {
    return {
      success: false,
      error:
        "UnauthorizedError: tool:execute permission required to run a tool",
      executionTimeMs: Date.now() - startTime,
    };
  }

  const admin = isAdminFromEvent(event);
  let effectiveOrgId: string;
  if (admin) {
    const callerOrgId = await extractOrgFromEvent(event);
    if (!callerOrgId) {
      return {
        success: false,
        error: "UnauthorizedError: caller organization could not be determined",
        executionTimeMs: Date.now() - startTime,
      };
    }
    effectiveOrgId = callerOrgId;
  } else {
    try {
      effectiveOrgId = await requireCallerOrg(event, "ToolRunResolver");
    } catch {
      return {
        success: false,
        error: "UnauthorizedError: caller organization could not be determined",
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  const parsedInputs = parseInputs(inputsJson);
  if (!parsedInputs.ok) {
    return {
      success: false,
      error: "Invalid inputs: must be valid JSON",
      executionTimeMs: Date.now() - startTime,
    };
  }

  // Load + org-gate the tool BEFORE ever invoking the worker — fail-closed,
  // not-found-shaped on mismatch (no cross-tenant enumeration).
  const toolConfig = await resolveToolConfig(toolId);
  if (
    !toolConfig ||
    !toolConfig.orgId ||
    (toolConfig.orgId !== effectiveOrgId &&
      toolConfig.orgId !== ALL_ORGANIZATIONS)
  ) {
    return {
      success: false,
      error: "Tool not found",
      executionTimeMs: Date.now() - startTime,
    };
  }

  // Server-minted runId — never the client's. A client-supplied `runId`
  // argument (if the schema ever grows one) is intentionally never read
  // here.
  const runId = randomUUID();

  try {
    const workerResult = await invokeWorkerToolRun(
      {
        kind: "tool-run",
        toolId,
        inputs: parsedInputs.value,
        orgId: effectiveOrgId,
        runId,
        caller: { userId: authContext.userId, roles: authContext.roles },
      },
      options?.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS,
    );

    if (workerResult.status === "error") {
      const err = workerResult.error;
      return {
        success: false,
        error: err ? `${err.code}: ${err.message}` : "Unknown worker error",
        executionTimeMs: workerResult.durationMs,
      };
    }

    return {
      success: true,
      output: workerResult.output,
      executionTimeMs: workerResult.durationMs,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      executionTimeMs: Date.now() - startTime,
    };
  }
}
