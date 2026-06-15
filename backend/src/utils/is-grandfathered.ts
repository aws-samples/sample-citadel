/**
 * Grandfathering helper.
 *
 * Phase-1 rollout safety per QT2B-10: projects created before the
 * `effective_at` SSM cutoff bypass new governance gates (C3/C7/C10)
 * without altering data. Every bypass emits
 * `governance.grandfathered.bypass` for telemetry. No forced retrofit.
 *
 * The `effective_at` cutoff is auto-written by a CDK custom resource on
 * the first `permissive → shadow` flip (QT3-8). While it remains empty
 * (pre-flip), every project is grandfathered — which matches the C3/C7/C10
 * gates being in `permissive` (telemetry-only) mode anyway.
 */

import type { Project } from '../types';

/** Canonical gate identifiers used in the bypass event's `bypassedGate` field. */
export type GrandfatheredBypassedGate =
  | 'C3_assessment_required'
  | 'C7_adr_required'
  | 'C10_spec_required';

/**
 * Pure implementation of the grandfathering rule.
 *
 * Rule (QT2B-10):
 *   - `effectiveAt === null` or empty string ⇒ true (pre-shadow-flip; everyone grandfathered)
 *   - `project.createdAt < effectiveAt` (ISO-8601 lexicographic comparison) ⇒ true
 *   - project.createdAt === effectiveAt ⇒ false (exact cutoff is NOT grandfathered)
 *   - project.createdAt > effectiveAt ⇒ false
 *   - malformed `createdAt` (missing, non-string, empty) ⇒ true (conservative bypass)
 *
 * This function is pure — no I/O. Callers wire it with the live SSM value.
 */
export function isGrandfatheredPure(
  createdAt: string | null | undefined,
  effectiveAt: string | null,
): boolean {
  // Pre-shadow-flip (no cutoff set): everyone is grandfathered.
  if (effectiveAt === null || effectiveAt === '') return true;
  // Conservative fallback for malformed project data: bypass rather than
  // block. Matches the telemetry-only Phase-1 stance — a malformed record
  // in permissive mode must not become a hard failure in shadow/strict.
  if (typeof createdAt !== 'string' || createdAt === '') return true;
  // ISO-8601 strings compare correctly lexicographically when timezone-
  // normalized. Both getGovernanceEffectiveAt and Project.createdAt are
  // written in UTC ISO format elsewhere in the codebase.
  return createdAt < effectiveAt;
}

/**
 * I/O-bound convenience wrapper. Reads the current `effective_at` from SSM
 * via `getGovernanceEffectiveAt(env)` and applies the pure rule.
 *
 * Env resolution: callers either pass `env` explicitly (tests) or rely
 * on the default `process.env.ENVIRONMENT`. If neither is present, throws
 * so the caller is forced to make the choice explicit (matches
 * strict-allowlist discipline).
 */
export async function isGrandfathered(
  project: Pick<Project, 'createdAt'>,
  env?: string,
): Promise<boolean> {
  const resolvedEnv = env ?? process.env.ENVIRONMENT;
  if (!resolvedEnv) {
    throw new Error(
      'isGrandfathered: env argument or process.env.ENVIRONMENT must be set',
    );
  }
  const { getGovernanceEffectiveAt } = await import('./governance-flag');
  const effectiveAt = await getGovernanceEffectiveAt(resolvedEnv);
  return isGrandfatheredPure(project.createdAt, effectiveAt);
}

/**
 * Emit the `governance.grandfathered.bypass` telemetry event. Call this
 * from resolver gate sites (wiring) after the gate has been
 * skipped for a grandfathered project. Fire-and-forget semantics at the
 * call-site — a failed emit must not fail the underlying transition, so
 * gate call-sites should wrap this in try/catch (we do not swallow here
 * because propagation lets notifier-base handle its own retry policy).
 */
export async function emitGrandfatheredBypass(
  projectId: string,
  bypassedGate: GrandfatheredBypassedGate,
  projectCreatedAt: string,
  effectiveAt: string,
  correlationId?: string,
): Promise<void> {
  const { emitGovernanceEvent } = await import('./notifier-base');
  await emitGovernanceEvent(
    'governance.grandfathered.bypass',
    { projectId, bypassedGate, projectCreatedAt, effectiveAt },
    correlationId,
  );
}
