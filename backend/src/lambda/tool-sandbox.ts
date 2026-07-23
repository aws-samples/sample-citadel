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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as vm from 'vm';

// --- Clients ---

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TOOLS_CONFIG_TABLE = process.env.TOOLS_CONFIG_TABLE!;
const TOOLS_BUCKET = process.env.TOOLS_BUCKET!;

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
}

/**
 * Shape of the module.exports a sandboxed tool may provide: either a
 * callable handler, or an object exposing a `.handler` function.
 */
type SandboxToolFn = (
  inputs: unknown,
  credentials: Record<string, unknown>
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
    credentials: Record<string, unknown>
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
  maxSize: number
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
 * @param toolId - The tool to execute
 * @param inputs - Sample inputs for the tool
 * @param orgId - Organization ID
 * @param deps - Injectable dependencies for testing
 * @param timeoutMs - Execution timeout in milliseconds (default 30000)
 */
export async function executeTool(
  toolId: string,
  inputs: unknown,
  orgId: string,
  deps: ExecuteToolDeps,
  timeoutMs: number = 30000
): Promise<ToolTestResult> {
  const startTime = Date.now();

  try {
    // 1. Load tool config from DynamoDB
    const toolConfig = await deps.loadToolConfig(toolId);
    if (!toolConfig) {
      return {
        success: false,
        error: 'Tool not found',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 2. Load tool code from S3
    let code: string;
    try {
      code = await deps.loadToolCode(toolId);
    } catch {
      return {
        success: false,
        error: 'Tool code not found',
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
        () => reject(new Error('Execution timed out after 30 seconds')),
        timeoutMs
      )
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
    if (err instanceof Error && err.message.includes('timed out')) {
      return {
        success: false,
        error: 'Execution timed out after 30 seconds',
        executionTimeMs: Math.min(elapsed, timeoutMs + 500),
      };
    }

    // Runtime error in tool code
    return {
      success: false,
      error: (err instanceof Error ? err.message : '') || 'Unknown runtime error',
      executionTimeMs: elapsed,
    };
  }
}

// --- Default dependency implementations ---

function defaultDeps(): ExecuteToolDeps {
  return {
    loadToolConfig: async (toolId: string) => {
      const result = await dynamodb.send(
        new GetCommand({
          TableName: TOOLS_CONFIG_TABLE,
          Key: { toolId },
        })
      );
      return result.Item || null;
    },

    loadToolCode: async (toolId: string) => {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: TOOLS_BUCKET,
          Key: `tools/${toolId}/index.js`,
        })
      );
      return (await result.Body?.transformToString()) || '';
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

    executeCode: async (code: string, inputs: unknown, credentials: Record<string, unknown>) => {
      // Execute tool code in an isolated VM context
      const sandbox = {
        module: { exports: {} as SandboxToolExports },
        exports: {} as SandboxToolExports,
        require: () => {
          throw new Error('require is not allowed in sandbox');
        },
        console: { log: () => {}, error: () => {}, warn: () => {} },
      };

      const script = new vm.Script(code);
      const context = vm.createContext(sandbox);
      script.runInContext(context);

      const handler = sandbox.module.exports;
      if (typeof handler === 'function') {
        const output = await handler(inputs, credentials);
        return { output };
      } else if (typeof handler.handler === 'function') {
        const output = await handler.handler(inputs, credentials);
        return { output };
      }

      throw new Error('Tool code does not export a valid handler function');
    },
  };
}

// --- Structured logging ---

function logToolExecution(
  toolId: string,
  orgId: string,
  result: ToolTestResult
): void {
  console.log(
    JSON.stringify({
      level: result.success ? 'INFO' : 'WARN',
      component: 'ToolSandbox',
      toolId,
      orgId,
      success: result.success,
      executionTimeMs: result.executionTimeMs,
      error: result.error || null,
      timestamp: new Date().toISOString(),
    })
  );
}

// --- Lambda handler ---

export async function handler(event: {
  arguments: {
    toolId: string;
    inputs: string;
    orgId: string;
  };
}): Promise<ToolTestResult> {
  const { toolId, inputs: inputsJson, orgId } = event.arguments;

  // Validate inputs
  let inputs: unknown;
  try {
    inputs = JSON.parse(inputsJson);
  } catch {
    return {
      success: false,
      error: 'Invalid inputs: must be valid JSON',
      executionTimeMs: 0,
    };
  }

  const result = await executeTool(toolId, inputs, orgId, defaultDeps(), 30000);

  logToolExecution(toolId, orgId, result);

  return result;
}
