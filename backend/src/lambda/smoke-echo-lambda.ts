/**
 * Smoke Echo Lambda.
 *
 * Minimal `lambda`-binding target for the smoke-echo-tool registry record
 * (see `seed-smoke-echo-tool/index.ts`). Replaces the retired in-Lambda
 * `vm` sandbox (`tool-sandbox.ts`, board task 10c3bf48 Slice 2) as the
 * runnable implementation the deployed smoke test's `testTool` check
 * exercises — `testTool` now dispatches through the worker's governed
 * `invoke_binding("lambda", ...)` path (see `tool-run-resolver.ts`),
 * which `RequestResponse`-invokes exactly this function.
 *
 * Deliberately stateless and dependency-free: returns the caller's inputs
 * plus a diagnostic timestamp and the tool id, mirroring the retired vm
 * module's output shape so the smoke assertion needs no changes.
 */

export interface SmokeEchoLambdaInput {
  message?: string;
  [key: string]: unknown;
}

export interface SmokeEchoLambdaOutput {
  tool: string;
  ts: string;
  [key: string]: unknown;
}

export const TOOL_ID = "smoke-echo-tool";

export const handler = async (
  inputs: SmokeEchoLambdaInput | null | undefined,
): Promise<SmokeEchoLambdaOutput> => ({
  ...(inputs ?? {}),
  tool: TOOL_ID,
  ts: new Date().toISOString(),
});
