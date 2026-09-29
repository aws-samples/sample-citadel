/**
 * Shared record-approval dispatch gate for the publish/attach TS call sites
 * (app-publish-handler.ts's validatePublishPreconditions and
 * registry-agent-record-resolver.ts's updateAgentBinding).
 *
 * Mirrors the Python dispatch-time gate (arbiter/governance/record_approval.py)
 * conceptually, but is independently implemented here for the two TS call
 * sites that mutate app state (publish an app; bind/attach an agent to an
 * app) rather than dispatching an agent invocation.
 *
 * Mode is read via the existing SSM-backed governance-flag reader
 * (backend/src/utils/governance-flag.ts::getGovernanceEnforce), the SAME
 * cached client already used by agent-import-resolver.ts and others for
 * `/citadel/governance/enforce/<env>`. That reader's three-value contract
 * ('permissive' | 'shadow' | 'strict') collapses to this gate's two-value
 * mode: 'permissive' and 'shadow' both behave as shadow (warn + proceed)
 * here — only 'strict' throws. This mirrors the reader's own fallback
 * rationale (a degraded/defaulted read must never silently escalate to the
 * most restrictive behavior).
 *
 * Grandfathering: deliberately NOT applied. Publishing an app and attaching
 * (binding) an agent to an app are being gated for the first time by this
 * change — they are NEW governance checkpoints, not pre-existing in-flight
 * work that predates the gate. Every publish/attach call, past or present,
 * is evaluated against the current registry status.
 */

import { REGISTRY_STATUS_FIELD } from "./approval-cache-fields";

export type ApprovalAction = "publish" | "attach";

/** Minimal shape of a Registry record's approval-relevant field. */
export interface RegistryRecordLike {
  status?: string;
}

/** Minimal shape of an agents-cache item's denormalized approval field. */
export interface ApprovalCacheItemLike {
  [REGISTRY_STATUS_FIELD]?: string;
}

/** Raw registry status values that are considered "approved" for dispatch. */
const APPROVED_STATUS = "APPROVED";

/**
 * Thrown in strict mode when the record backing a publish/attach action is
 * not approved. `message` is always `approval_absent:<status>`, or
 * `approval_absent_missing_status` when no status signal is available at
 * all (record fetched with no `.status`, or cache item with no
 * registryStatus field).
 */
export class RecordNotApprovedError extends Error {
  constructor(
    public readonly action: ApprovalAction,
    public readonly status: string | undefined,
  ) {
    super(
      status !== undefined
        ? `approval_absent:${status}`
        : "approval_absent_missing_status",
    );
    this.name = "RecordNotApprovedError";
  }
}

function resolveRawStatus(
  source: RegistryRecordLike | ApprovalCacheItemLike,
): string | undefined {
  if (source && typeof (source as RegistryRecordLike).status === "string") {
    return (source as RegistryRecordLike).status;
  }
  return (source as ApprovalCacheItemLike)?.[REGISTRY_STATUS_FIELD];
}

/**
 * Asserts that the registry record (or denormalized cache item) backing a
 * publish/attach action is approved.
 *
 * - `source` is EITHER a Registry record (read via
 *   `RegistryService.getResource`'s `.status` field, when the caller
 *   already has one fetched) OR an agents-cache item carrying the
 *   denormalized `registryStatus` field (see approval-cache-fields.ts).
 *   The Registry record's raw `.status` takes precedence when present.
 * - `action` is used only for the thrown error's context and log line.
 * - `mode` is the resolved governance enforcement mode for the current
 *   environment (see `getGovernanceEnforce`).
 *   - 'strict': throws `RecordNotApprovedError` when the resolved status is
 *     not 'APPROVED' (including when no status signal is present at all).
 *   - 'shadow' / 'permissive': logs `console.warn` with `would_block=true`
 *     when the status is not 'APPROVED', then proceeds without throwing.
 */
export function assertRecordApprovedForAction(
  source: RegistryRecordLike | ApprovalCacheItemLike,
  action: ApprovalAction,
  mode: "permissive" | "shadow" | "strict",
): void {
  const rawStatus = resolveRawStatus(source);
  const approved = rawStatus === APPROVED_STATUS;
  if (approved) return;

  if (mode === "strict") {
    throw new RecordNotApprovedError(action, rawStatus);
  }

  console.warn(
    JSON.stringify({
      level: "warn",
      message: "record-approval-check: would_block",
      action,
      mode,
      status: rawStatus ?? null,
    }),
  );
}
