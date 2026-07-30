/**
 * Shared correlation identity — runId (decision f1cbd5ef, architect design
 * "runId — Shared Correlation Identity Design", Pass 1).
 *
 * runId is SERVER-MINTED ONLY. This module is the sole TypeScript producer.
 * No code path may read a runId off an external/client request body — any
 * inbound client-supplied value must be stripped/ignored, mirroring how the
 * client-minted `orchestrationId` is already discarded in
 * `task-runner-resolver.ts` (submitTask mints its own via `randomUUID()`
 * and never reads one from `SubmitTaskInput`).
 *
 * Format: opaque string `run-<uuidv4>` (lowercase, hyphenated). The `run-`
 * prefix makes it greppable in logs/DDB and impossible to confuse with the
 * bare-uuid orchestrationId/executionId/projectId already in use.
 *
 * `DispatchContext` + `buildDispatchContext()` are the BUILD-TIME durability
 * guard: `runId` is a REQUIRED field on the type and a required parameter
 * on the builder, so a future entry point that omits it fails `tsc`
 * (compile-time), not merely a runtime check. Every Pass-1 entry point
 * routes its outbound envelope through this builder.
 */
import { randomUUID } from "crypto";

/** Sole producer: mints a fresh, server-side runId. Never derived from external input. */
export function mintRunId(): string {
  return `run-${randomUUID()}`;
}

/**
 * Shared outbound dispatch/event envelope. `runId` is REQUIRED — omitting
 * it at a call site is a compile-time (`tsc`) failure, which is the
 * build-time half of the silent-regression guard (design §3, layer 1).
 * Additional fields are intentionally open (`[key: string]: unknown`) so
 * this type can wrap the varied per-entry-point detail shapes without
 * forcing a single rigid schema.
 */
export interface DispatchContext {
  runId: string;
  [key: string]: unknown;
}

/**
 * Construct a `DispatchContext`. `runId` has no default — every caller must
 * supply one explicitly (typically via `mintRunId()`), so omission is a
 * compile error rather than a silently-undefined field.
 */
export function buildDispatchContext(
  context: DispatchContext,
): DispatchContext {
  return { ...context };
}
