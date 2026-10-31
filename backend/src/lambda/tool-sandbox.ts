/**
 * Tool Testing Sandbox Lambda
 *
 * Executes a tool in an isolated context with scoped credentials,
 * enforcing a 30-second timeout and 512MB memory limit.
 *
 * Exports a testable `executeTool` function and a pure `addToHistory` helper.
 *
 * Requirement references: 7.3, 7.4, 7.5, 7.8, 10.9
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { resolveToolConfig } from "./utils/resolve-tool-config";
import * as vm from "vm";
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  deriveRoles,
} from "../utils/auth-event";
import { hasPermission } from "../utils/auth";
import type { AuthContext } from "../types";

// --- Clients ---

const s3 = new S3Client({});

const TOOLS_BUCKET = process.env.TOOLS_BUCKET!;

/**
 * Sentinel org value for system-seeded / shared tool records.
 * Matches TENANCY.md §Sentinels and CIT-252 backfill. Case-sensitive.
 */
const ALL_ORGANIZATIONS = "All Organizations";

// --- Types ---

export interface ToolTestResult {
  success: boolean;
  output?: unknown;
  error?: string;
  executionTimeMs: number;
}

export interface ToolTestHistoryEntry {
  success: boolean;
  output?: unknown;
  error?: string;
  executionTimeMs: number;
  timestamp: string;
}

/** Binding slice the sandbox reads when resolving scoped credentials. */
export interface SandboxBinding {
  integrationId?: string;
  dataStoreId?: string;
}

/** Tool-config slice the sandbox reads. Rows may carry more fields. */
export interface SandboxToolConfig {
  integrationBindings?: SandboxBinding[];
  dataStoreBindings?: SandboxBinding[];
  /** Owning org. Absent on legacy/shared configs, which are treated as
   * visible to every org-scoped caller — mirrors the
   * `mapped.orgId && mapped.orgId !== callerOrgId` guard in
   * tool-config-resolver.ts's getToolConfigRegistry. */
  orgId?: string;
  /** S3 key prefix for the tool's code. When present the sandbox loads
   *  `${codeKey}/index.js` instead of `tools/${toolId}/index.js`. */
  codeKey?: string;
}

/**
 * Shape of the module.exports a sandboxed tool may provide: either a
 * callable handler, or an object exposing a `.handler` function.
 */
type SandboxToolFn = (
  inputs: unknown,
  credentials: Record<string, unknown>,
) => unknown;
type SandboxToolExports = SandboxToolFn | { handler?: SandboxToolFn };

export interface ExecuteToolDeps {
  loadToolConfig: (toolId: string) => Promise<SandboxToolConfig | null>;
  loadToolCode: (toolId: string) => Promise<string>;
  resolveCredentials: (bindings: {
    integrationBindings?: SandboxBinding[];
    dataStoreBindings?: SandboxBinding[];
  }) => Promise<Record<string, unknown>>;
  executeCode: (
    code: string,
    inputs: unknown,
    credentials: Record<string, unknown>,
  ) => Promise<{ output: unknown }>;
}

// --- Pure helper: history management (Req 7.9) ---

/**
 * Add a new entry to the test run history, evicting the oldest entry
 * when the history exceeds `maxSize`.
 *
 * This is a pure function — it returns a new array without mutating the input.
 */
export function addToHistory<T>(
  history: T[],
  newEntry: T,
  maxSize: number,
): T[] {
  const updated = [...history, newEntry];
  if (updated.length > maxSize) {
    return updated.slice(updated.length - maxSize);
  }
  return updated;
}

// --- Testable core logic ---

/**
 * Execute a tool in an isolated context with scoped credentials.
 *
 * This function is extracted from the Lambda handler to enable property-based
 * testing with mock dependencies.
 *
 * Org scoping (finding 615aa5bb): `callerOrgId` MUST be derived server-side
 * from the caller's identity (see `handler` below, which calls
 * `extractOrgFromEvent`) — it is never the client-supplied `orgId` GraphQL
 * argument. `toolId` is looked up with no org filter (ToolsConfigTable has
 * no OrgIndex — see backend/lib/arbiter-stack.ts), so the org check runs
 * AFTER load, comparing the loaded config's own `orgId` to `callerOrgId`,
 * mirroring `getToolConfigRegistry`'s guard in tool-config-resolver.ts. A
 * mismatch is reported as "Tool not found" (same not-found-shaped response
 * as a missing tool) rather than a distinct 403, so a caller cannot use the
 * error shape to enumerate other orgs' tool IDs. A config with no `orgId`
 * (legacy/shared) is visible to every org-scoped caller.
 *
 * Additionally requires the `tool:execute` permission — this executes the
 * tool's own code with its resolved, scoped credentials, so it is gated at
 * the same trust tier as `tool:approve` (architect/admin only).
 *
 * @param toolId - The tool to execute
 * @param inputs - Sample inputs for the tool
 * @param authContext - Caller's auth context (roles), for the permission gate
 * @param callerOrgId - Server-derived caller org (never client-supplied)
 * @param deps - Injectable dependencies for testing
 * @param timeoutMs - Execution timeout in milliseconds (default 30000)
 */
export async function executeTool(
  toolId: string,
  inputs: unknown,
  authContext: AuthContext,
  callerOrgId: string,
  deps: ExecuteToolDeps,
  timeoutMs: number = 30000,
): Promise<ToolTestResult> {
  const startTime = Date.now();

  // PERMISSION gate — tool:execute (admin via bypass in hasPermission).
  if (!hasPermission(authContext, "tool:execute")) {
    return {
      success: false,
      error:
        "UnauthorizedError: tool:execute permission required to run a tool",
      executionTimeMs: Date.now() - startTime,
    };
  }

  try {
    // 1. Load tool config from DynamoDB
    const toolConfig = await deps.loadToolConfig(toolId);
    if (!toolConfig) {
      return {
        success: false,
        error: "Tool not found",
        executionTimeMs: Date.now() - startTime,
      };
    }

    // ORG MATCH — fail-closed (H19): absent/empty orgId → refuse. The
    // "All Organizations" sentinel (CIT-252) is explicitly allowed so
    // system-seeded tools remain accessible. Any other mismatch is
    // reported identically to a missing tool (no existence disclosure
    // across tenants).
    if (
      !toolConfig.orgId ||
      (toolConfig.orgId !== callerOrgId &&
        toolConfig.orgId !== ALL_ORGANIZATIONS)
    ) {
      // Best-effort CloudWatch metric so dashboards can track rejections
      // caused by the fail-closed flip (tools with absent orgId that were
      // previously silently allowed).
      try {
        const { CloudWatchClient, PutMetricDataCommand } = await import(
          "@aws-sdk/client-cloudwatch"
        );
        const cw = new CloudWatchClient({});
        await cw.send(
          new PutMetricDataCommand({
            Namespace: "Citadel/Sandbox",
            MetricData: [
              {
                MetricName: "OrgRefused",
                Value: 1,
                Unit: "Count",
                Dimensions: [{ Name: "toolId", Value: toolId }],
              },
            ],
          }),
        );
      } catch {
        // Best effort — metric failure must never block the deny path.
      }
      return {
        success: false,
        error: "Tool not found",
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 2. Load tool code from S3
    let code: string;
    try {
      // Prefer the config's codeKey (decouples code location from
      // registry-assigned recordId); fall back to toolId.
      code = await deps.loadToolCode(toolConfig.codeKey ?? toolId);
    } catch {
      return {
        success: false,
        error: "Tool code not found",
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 3. Resolve scoped credentials for the tool's bindings (Req 7.5)
    let credentials: Record<string, unknown>;
    try {
      credentials = await deps.resolveCredentials({
        integrationBindings: toolConfig.integrationBindings || [],
        dataStoreBindings: toolConfig.dataStoreBindings || [],
      });
    } catch (err: unknown) {
      return {
        success: false,
        error: `Credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 4. Execute tool with timeout enforcement (Req 7.8)
    const executionPromise = deps.executeCode(code, inputs, credentials);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Execution timed out after 30 seconds")),
        timeoutMs,
      ),
    );

    const result = await Promise.race([executionPromise, timeoutPromise]);

    return {
      success: true,
      output: result.output,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;

    // Timeout error (Req 7.8)
    if (err instanceof Error && err.message.includes("timed out")) {
      return {
        success: false,
        error: "Execution timed out after 30 seconds",
        executionTimeMs: Math.min(elapsed, timeoutMs + 500),
      };
    }

    // Runtime error in tool code
    return {
      success: false,
      error:
        (err instanceof Error ? err.message : "") || "Unknown runtime error",
      executionTimeMs: elapsed,
    };
  }
}

// --- Default dependency implementations ---

function defaultDeps(): ExecuteToolDeps {
  return {
    loadToolConfig: async (toolId: string) => {
      const resolved = await resolveToolConfig(toolId);
      return resolved
        ? {
            orgId: resolved.orgId,
            integrationBindings: resolved.integrationBindings ?? undefined,
            dataStoreBindings: resolved.dataStoreBindings ?? undefined,
            codeKey: resolved.codeKey,
          }
        : null;
    },

    loadToolCode: async (toolId: string) => {
      try {
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: TOOLS_BUCKET,
            Key: `tools/${toolId}/index.js`,
          }),
        );
        return (await result.Body?.transformToString()) || "";
      } catch (err: unknown) {
        const code =
          err && typeof err === "object" && "name" in err
            ? (err as { name: string }).name
            : "";
        if (code === "NoSuchKey" || code === "NoSuchBucket") {
          throw new Error(
            "Tool has no runnable implementation (no code uploaded for this tool)",
          );
        }
        throw err;
      }
    },

    resolveCredentials: async (bindings) => {
      // In production, this calls the Credential Vender to resolve
      // scoped credentials for each binding. Simplified here.
      const creds: Record<string, unknown> = {};
      const allBindings = [
        ...(bindings.integrationBindings || []),
        ...(bindings.dataStoreBindings || []),
      ];
      for (const binding of allBindings) {
        const id = (binding.integrationId || binding.dataStoreId) as string;
        creds[id] = { scopedAccess: true, bindingId: id };
      }
      return creds;
    },

    executeCode: sandboxExecuteCode,
  };
}

/**
 * Execute tool code in an isolated VM context with timeout enforcement.
 *
 * SECURITY NOTE: vm.createContext is an accident guard, not a security
 * boundary. The Node.js docs state: "The vm module is not a security
 * mechanism. Do not use it to run untrusted code." Untrusted tool code
 * requires process isolation (child_process / container / Lambda-in-
 * Lambda) — deferred as a follow-up backlog item. The hardening below
 * blocks the most common accidental escapes (direct process/require
 * references, prototype pollution) but does NOT defeat a deliberately
 * crafted escape (e.g. ({}).constructor.constructor('return this')()).
 *
 * Memory guard via --max-old-space-size is NOT applicable — it's a
 * process-level V8 flag, not per-context. The 512 MB Lambda memory
 * limit is the ceiling.
 *
 * Timeout strategy:
 * - The DEFINITION pass (module-level code) runs under vm timeout.
 * - The INVOCATION pass (calling the exported handler) runs under vm
 *   timeout with the remaining budget. This bounds synchronous
 *   spin-loops in the handler body.
 * - Async handlers: the vm timeout bounds the synchronous preamble;
 *   the async tail is bounded by executeTool's outer Promise.race.
 *
 * @param timeoutMs - VM timeout for the entire definition+invocation
 *   budget (default 30_000). Tests pass a short value.
 */
export async function sandboxExecuteCode(
  code: string,
  inputs: unknown,
  credentials: Record<string, unknown>,
  timeoutMs: number = 30_000,
): Promise<{ output: unknown }> {
  const sandbox: Record<string, unknown> = {
    module: { exports: {} as SandboxToolExports },
    exports: {} as SandboxToolExports,
    // Explicitly undefined — blocks trivial escape paths:
    process: undefined,
    require: (() => {
      const fn = () => {
        throw new Error("require is not allowed in sandbox");
      };
      return fn;
    })(),
    globalThis: undefined,
    global: undefined,
    // Stubbed console (existing)
    console: { log: () => {}, error: () => {}, warn: () => {} },
  };

  const context = vm.createContext(sandbox);

  // Freeze the context's prototype chain to block property injection
  // via prototype pollution (e.g. Object.prototype.process = ...).
  // This is best-effort — some paths may still reach the real
  // prototype through constructor chains.
  try {
    const proto = Object.getPrototypeOf(sandbox);
    if (proto) Object.freeze(proto);
  } catch {
    // Freeze failure is non-fatal — proceed with unfrozen prototype.
  }

  const VM_TIMEOUT_MS = timeoutMs;
  const MAX_CODE_SIZE = 5 * 1024 * 1024; // 5 MB

  if (code.length > MAX_CODE_SIZE) {
    throw new Error(
      `Tool code exceeds maximum size (${MAX_CODE_SIZE} bytes)`,
    );
  }

  const script = new vm.Script(code);
  const defStart = Date.now();
  script.runInContext(context, { timeout: VM_TIMEOUT_MS });
  const defElapsed = Date.now() - defStart;

  const handler = sandbox.module as { exports: SandboxToolExports };
  const exp = handler.exports;
  if (typeof exp !== "function" && !(exp && typeof (exp as { handler?: SandboxToolFn }).handler === "function")) {
    throw new Error("Tool code does not export a valid handler function");
  }

  // Inject inputs/credentials into the sandbox so the invoker script
  // can reference them. These are host-provided values, not user code.
  context.__inputs = inputs;
  context.__creds = credentials;

  // Build an invoker script that calls the exported handler INSIDE
  // the VM context with a timeout. This bounds synchronous spin-loops
  // in the handler body (the definition-pass timeout above only
  // bounds the module-level code, not the exported function's body).
  //
  // For async handlers the invoker returns a Promise — the vm timeout
  // bounds the synchronous preamble; the async tail is bounded by the
  // outer Promise.race in executeTool. This is documented: vm timeout
  // bounds synchronous work; async work is bounded by the race.
  const invokerSrc = typeof exp === "function"
    ? "(function(){ return module.exports(__inputs, __creds); })()"
    : "(function(){ return module.exports.handler(__inputs, __creds); })()";

  const remainingMs = Math.max(
    100,
    VM_TIMEOUT_MS - defElapsed,
  );
  const invoker = new vm.Script(invokerSrc);
  const invokeResult = invoker.runInContext(context, {
    timeout: remainingMs,
    breakOnSigint: false,
  });

  // If the handler returned a promise (async handler), await it.
  // The vm timeout above bounded the synchronous portion; the async
  // tail is bounded by executeTool's Promise.race timeout.
  const output = await Promise.resolve(invokeResult);
  return { output };
}

// --- Structured logging ---

function logToolExecution(
  toolId: string,
  orgId: string,
  result: ToolTestResult,
): void {
  console.log(
    JSON.stringify({
      level: result.success ? "INFO" : "WARN",
      component: "ToolSandbox",
      toolId,
      orgId,
      success: result.success,
      executionTimeMs: result.executionTimeMs,
      error: result.error || null,
      timestamp: new Date().toISOString(),
    }),
  );
}

/** AppSync identity shape this handler reads (mirrors auth-event.ts). */
interface ToolSandboxEventIdentity {
  sub?: string;
  username?: string;
  ["custom:role"]?: string;
  ["cognito:groups"]?: string[];
  claims?: Record<string, unknown> | null;
}

function authContextFromEvent(
  identity: ToolSandboxEventIdentity | undefined,
): AuthContext {
  return {
    userId: identity?.sub || identity?.username || "anonymous",
    username: identity?.username,
    groups: identity?.["cognito:groups"] || [],
    roles: deriveRoles({ identity }),
  };
}

// --- Lambda handler ---

export async function handler(event: {
  identity?: ToolSandboxEventIdentity;
  arguments: {
    toolId: string;
    inputs: string | Record<string, unknown>;
    /** Client-supplied org — advisory only. The caller's ACTUAL org is
     * always re-derived server-side via extractOrgFromEvent (finding
     * 615aa5bb); a value here that disagrees with the derived org is
     * rejected as a cross-org attempt rather than silently ignored, so a
     * caller gets clear feedback instead of a confusing implicit
     * substitution (mirrors decideToolApproval's cross-org-input guard in
     * tool-approval-resolver.ts). */
    orgId: string;
  };
}): Promise<ToolTestResult> {
  const { toolId, inputs: inputsJson, orgId: suppliedOrgId } = event.arguments;
  const authContext = authContextFromEvent(event.identity);

  const admin = isAdminFromEvent(event);
  const callerOrgId = await extractOrgFromEvent(event);

  if (!admin) {
    if (!callerOrgId) {
      return {
        success: false,
        error: "UnauthorizedError: caller organization could not be determined",
        executionTimeMs: 0,
      };
    }
    if (suppliedOrgId && suppliedOrgId !== callerOrgId) {
      return {
        success: false,
        error:
          "UnauthorizedError: orgId argument does not match caller's organization",
        executionTimeMs: 0,
      };
    }
  }

  // Server-derived org always wins; admins without a resolvable org fall
  // back to the (still permission-gated, still config-orgId-checked)
  // supplied value so admin tooling isn't blocked.
  const effectiveOrgId = callerOrgId || suppliedOrgId;

  // Validate inputs — AWSJSON! may arrive as an already-parsed object
  // (AppSync resolves the scalar before invoking the Lambda) or as a raw
  // JSON string (direct invocation / test harness).
  let inputs: unknown;
  if (typeof inputsJson === "string") {
    try {
      inputs = JSON.parse(inputsJson);
    } catch {
      return {
        success: false,
        error: "Invalid inputs: must be valid JSON",
        executionTimeMs: 0,
      };
    }
  } else if (
    typeof inputsJson === "object" &&
    inputsJson !== null &&
    !Array.isArray(inputsJson)
  ) {
    inputs = inputsJson;
  } else {
    return {
      success: false,
      error: "Invalid inputs: must be valid JSON",
      executionTimeMs: 0,
    };
  }

  // Audit: this path bypasses the governed tool handler (tool-config-resolver's
  // approval/governance pipeline). Log explicitly so the ungoverned execution
  // is traceable in CloudWatch and audit tooling.
  console.log(
    JSON.stringify({
      level: "WARN",
      component: "ToolSandbox",
      governance: "ungoverned_test_run",
      toolId,
      orgId: effectiveOrgId,
      callerUserId: authContext.userId,
      timestamp: new Date().toISOString(),
    }),
  );

  const result = await executeTool(
    toolId,
    inputs,
    authContext,
    effectiveOrgId,
    defaultDeps(),
    30000,
  );

  logToolExecution(toolId, effectiveOrgId, result);

  return result;
}
