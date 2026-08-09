/**
 * environment-release-pointer-resolver.ts — promoteEnvironmentReleasePointer
 * mutation, plus the two read queries (current pointer for one
 * agent+environment; every environment's pointer for one agent).
 *
 * Unlike release-resolver.ts's cutAgentRelease, the record this resolver
 * writes is deliberately MUTABLE. The write itself, and its optimistic
 * lock, live one layer down in environment-release-pointer-store.ts (the
 * SOLE writer for EnvironmentReleasePointersTable) — this module never
 * issues a raw DDB command against that table, only against
 * AgentReleasesTable for the target-release existence/org check.
 *
 * Validation order — permission check FIRST (matches release-resolver.ts
 * / execspec-resolver.ts's "permission check before any DDB access"
 * convention), then target-release existence, then target-release
 * org-ownership, THEN the quality gate (validateReleaseGate), ALL before
 * the store's conditional write. Cross-org pointer promotion is a
 * distinct SecurityError, not folded into the generic ValidationError
 * bucket, mirroring release-resolver.ts's "malformed input" vs
 * "attempted to pin/point at another tenant's data" distinction.
 *
 * QUALITY GATING SEAM (Slice 3 — wired): validateReleaseGate() now has a
 * real async signature and IS called from
 * promoteEnvironmentReleasePointer, positioned after the
 * permission/existence/org checks and BEFORE setEnvironmentReleasePointer
 * (the store's conditional write, and the last statement in this
 * function). Because the write is the LAST statement, a gate that throws
 * before it runs leaves the pointer PROVABLY untouched — no compensating
 * rollback is needed, and tests assert zero store-write calls, not merely
 * an unchanged value (see environment-release-pointer-resolver.test.ts's
 * "gate wiring position" describe block).
 *
 * ORDERING AND FAILURE (design item 5 — read this before changing the
 * gate call): validateReleaseGate ALWAYS computes the full
 * ReleaseGateVerdict first, via resolveReleaseGateEvidence +
 * evaluateReleaseGate — identically in every mode, so permissive-mode
 * rollout telemetry is never silently skipped. Mode only selects what
 * happens NEXT, via the shared governanceDisposition(mode) mapper:
 *
 *   - The decision to BLOCK (throw a ReleaseGateError) is derived from
 *     `disposition.block && verdict.status is a fail state` ALONE — it
 *     does not depend on whether the ledger-finding write succeeds or
 *     even runs. In strict mode, the finding write is attempted and
 *     AWAITED before the throw, but its outcome (success OR failure) is
 *     never consulted to decide whether to throw: the write is wrapped
 *     so a write failure cannot suppress or replace the refusal — see
 *     the try/finally-shaped control flow below. A promotion must never
 *     slip through because a telemetry write happened to fail.
 *   - In shadow mode, the ledger finding IS the sole durable record of a
 *     would-block decision (shadow never throws to the caller). A failed
 *     write there is NOT swallowed — it is allowed to propagate out of
 *     validateReleaseGate as a real error, because silently dropping it
 *     would erase the only evidence shadow mode exists to produce. This
 *     is a deliberate asymmetry: strict's write failure never overrides
 *     the block decision; shadow's write failure IS surfaced because
 *     shadow has no other decision to fall back on.
 *   - In permissive mode, no finding write is attempted at all
 *     (governanceDisposition("permissive").recordFinding === false), so
 *     a ledger outage can never affect a permissive-mode promotion.
 *
 * MODE SOURCE (design item 2 — do not add a second reader): mode comes
 * exclusively from the existing `getGovernanceEnforce(env)`
 * (backend/src/utils/governance-flag.ts), the SAME reader
 * agent-import-resolver.ts already consults. No new TS mode reader is
 * introduced here.
 *
 * MODE-LOOKUP FAILURE FALLBACK (design item 6 — investigated; runtimes now
 * match): `getGovernanceEnforce` falls back to 'shadow' on any SSM read
 * error or an out-of-allowlist value (see governance-flag.ts's
 * `DEFAULT_ENFORCEMENT_MODE` / `refresh`/`isValidEnforce`). The Python
 * dispatch path's equivalent resolver,
 * `arbiter/governance/hierarchy.py::_resolve_enforcement_mode`, falls
 * back to the SAME literal, 'shadow' (`_DEFAULT_ENFORCEMENT_MODE`), on
 * the identical failure class, and both `arbiter/stepRunner/executor.py`
 * and `arbiter/supervisor/index.py` consume that value via
 * `getattr(state, 'enforcement_mode', 'shadow')` before gating dispatch.
 * This was previously a documented DIVERGENCE (TS fell back to
 * 'permissive', which is telemetry-and-record-silent per
 * governanceDisposition('permissive')) — that divergence has been fixed
 * by moving the TS default to 'shadow' to match Python, deliberately,
 * per the enforcement-lookup fallback assessment: 'shadow' evaluates and
 * records (a ledger finding IS written, per this file's own gate below)
 * without introducing any new blocking versus the old 'permissive'
 * default (both are `block: false`). See governance-flag.ts's module doc
 * for the full rationale and the cross-runtime contract test pinning
 * both sides to the same literal.
 *
 * The twin `validateReleaseGate` in `release-resolver.ts:197` (cut-time
 * seam) is a DIFFERENT concern and stays a no-op — this file does not
 * touch it. Promotion-gating != cut-gating.
 *
 * The caller's org is derived from the AppSync identity's
 * `custom:organization` claim (extractOrgFromEvent), never from
 * caller-supplied input — the same doctrine as release-resolver.ts.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { hasPermission } from "../utils/auth";
import { extractOrgFromEvent } from "../utils/auth-event";
import { getGovernanceEnforce } from "../utils/governance-flag";
import { getActiveTraceContext } from "../utils/trace-context";
import { governanceDisposition } from "./utils/governance-disposition";
import {
  evaluateReleaseGate,
  DEFAULT_PROMOTION_POLICY,
} from "./utils/release-gate";
import { resolveReleaseGateEvidence } from "./utils/release-gate-evidence";
import { writeReleaseGateFinding } from "./utils/release-gate-finding-writer";
import {
  getEnvironmentReleasePointer,
  listEnvironmentReleasePointersForAgent,
  setEnvironmentReleasePointer,
} from "./environment-release-pointer-store";
import type {
  AgentRelease,
  AuthContext,
  EnvironmentLiteral,
  EnvironmentReleasePointer,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
  SetEnvironmentReleasePointerInput,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function agentReleasesTable(): string {
  return process.env.AGENT_RELEASES_TABLE!;
}

function requireReleasePromotePermission(authContext: AuthContext): void {
  if (!hasPermission(authContext, "release:promote")) {
    throw new Error(
      "UnauthorizedError: release:promote permission required to move an environment release pointer",
    );
  }
}

/** Thrown when the quality gate blocks a promotion (strict mode, FAIL
 * verdict). Distinct from ValidationError/SecurityError so callers can
 * react specifically — e.g. surface the gate's reasons in a UI — rather
 * than string-matching a generic Error. */
export class ReleaseGateError extends Error {
  constructor(
    public readonly releaseId: string,
    public readonly reasons: string[],
  ) {
    super(
      `ReleaseGateError: release quality gate refused promotion of ${releaseId} — reasons=[${reasons.join(", ")}]`,
    );
    this.name = "ReleaseGateError";
  }
}

/** A ReleaseGateVerdict.status that represents a FAIL disposition for
 * promotion purposes. NO_BASELINE is treated as a fail state here (no
 * baseline to compare against and absolute-floor bootstrap is disabled
 * by policy) — only PASS and NO_BASELINE_PASS are non-blocking. */
function isFailStatus(status: string): boolean {
  return status === "FAIL" || status === "NO_BASELINE";
}

/**
 * Quality-gating seam. Gives the release-promotion path a single place
 * to enforce eval-based promotion criteria before the pointer moves.
 *
 * ALWAYS resolves evidence and evaluates the gate, in every mode — mode
 * only changes what happens with the resulting verdict (see the module
 * doc comment above for the full ordering-and-failure contract). Never
 * called from release-resolver.ts's cut-time seam (a different,
 * unrelated no-op of the same name).
 *
 * Throws `ReleaseGateError` when, and only when, the resolved mode's
 * disposition blocks AND the verdict is a fail state. Never throws for a
 * PASS/NO_BASELINE_PASS verdict, regardless of mode.
 */
export async function validateReleaseGate(
  release: AgentRelease,
  environment: EnvironmentLiteral,
  callerOrgId: string,
  authContext: AuthContext,
): Promise<void> {
  const policy = DEFAULT_PROMOTION_POLICY;
  const now = new Date().toISOString();

  const evidence = await resolveReleaseGateEvidence(
    release,
    environment,
    callerOrgId,
    policy,
    now,
  );

  const verdict = evidence.ok
    ? evaluateReleaseGate(evidence.inputs)
    : {
        status: "FAIL" as const,
        reasons: [evidence.reason] as unknown as string[],
        failedThresholds: [],
        scoreVector: [],
        staleness: { stale: true, reasons: [] },
        requiredPacksSatisfied: false,
      };

  // Mode is resolved per-environment (matching getGovernanceEnforce's own
  // parameter — every other caller, e.g. agent-import-resolver.ts, keys
  // it the same way), not per-org — the SSM parameter path is
  // `/citadel/governance/enforce/{env}`.
  const mode = await getGovernanceEnforce(environment);
  const disposition = governanceDisposition(mode);

  const failed = isFailStatus(verdict.status);
  const decision: "permit" | "deny" = failed ? "deny" : "permit";

  // The block decision is derived from disposition+verdict ALONE, before
  // any finding-write is attempted — see module doc "ORDERING AND
  // FAILURE". Capturing it now means a write failure below can never
  // change what `shouldBlock` already is.
  const shouldBlock = disposition.block && failed;

  // Sourced ONCE at the call site (same convention as
  // events.ts::publishEvent) rather than read from ambient state deep
  // inside the writer — keeps writeReleaseGateFinding a pure function of
  // its input. undefined outside an active X-Ray segment (e.g. Jest) —
  // the writer omits both fields entirely in that case.
  const traceContext = getActiveTraceContext();

  if (disposition.recordFinding) {
    // strict: write, then (independent of write outcome) enforce
    // shouldBlock below — a write failure here must not suppress the
    // block, so we swallow ONLY in strict mode, where the block decision
    // was already fixed above and does not read this write's result.
    // shadow: NEVER swallow — this finding is the sole record of a
    // would-block, so a write failure must propagate to the caller.
    if (mode === "strict") {
      try {
        await writeReleaseGateFinding({
          orgId: callerOrgId,
          agentTargetId: release.agentTargetId,
          environment,
          releaseId: release.releaseId,
          decidedBy: authContext.userId,
          decision,
          reasons: verdict.reasons as never,
          scoreVector: verdict.scoreVector,
          mode,
          ...(traceContext?.traceId ? { traceId: traceContext.traceId } : {}),
        });
      } catch (writeErr) {
        // Logged, not rethrown: strict's refusal below must not depend
        // on this write succeeding. The failure is still visible in
        // logs/observability even though it cannot change the outcome.
        console.error(
          "environment-release-pointer-resolver: strict-mode gate finding write failed — refusal proceeds regardless",
          {
            releaseId: release.releaseId,
            environment,
            error:
              writeErr instanceof Error ? writeErr.message : String(writeErr),
          },
        );
      }
    } else {
      // shadow — propagate any write failure; it is the ONLY record of
      // this would-block decision.
      await writeReleaseGateFinding({
        orgId: callerOrgId,
        agentTargetId: release.agentTargetId,
        environment,
        releaseId: release.releaseId,
        decidedBy: authContext.userId,
        decision,
        reasons: verdict.reasons as never,
        scoreVector: verdict.scoreVector,
        mode,
        ...(traceContext?.traceId ? { traceId: traceContext.traceId } : {}),
      });
    }
  }

  if (shouldBlock) {
    throw new ReleaseGateError(
      release.releaseId,
      verdict.reasons as unknown as string[],
    );
  }
}

async function getAgentRelease(
  releaseId: string,
): Promise<AgentRelease | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: agentReleasesTable(), Key: { releaseId } }),
  );
  return (res.Item as AgentRelease | undefined) ?? null;
}

/**
 * promoteEnvironmentReleasePointer — validates the target release EXISTS
 * and belongs to the caller's org, runs the quality gate
 * (validateReleaseGate), then moves the (org, agentTargetId,
 * environment) pointer to it via the version-gated write boundary in
 * environment-release-pointer-store.ts. Permission-gated by
 * release:promote (do not ship an ungated promotion path).
 *
 * Reads the current pointer first only to derive expectedVersion and
 * currentReleaseId for the store's optimistic-lock write — the actual
 * lock enforcement happens in the store's ConditionExpression, not by
 * this function re-checking the read after the fact. If another
 * promotion wins the race between this read and the store's write, the
 * store throws ConcurrentPromotionError, which propagates unchanged.
 */
export async function promoteEnvironmentReleasePointer(
  input: SetEnvironmentReleasePointerInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<EnvironmentReleasePointer> {
  requireReleasePromotePermission(authContext);

  const targetRelease = await getAgentRelease(input.releaseId);
  if (!targetRelease) {
    throw new Error(
      `ValidationError: target release not found: ${input.releaseId}`,
    );
  }
  if (targetRelease.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: release ${input.releaseId} belongs to a different org — an environment pointer must never point at another org's release`,
    );
  }

  await validateReleaseGate(
    targetRelease,
    input.environment,
    callerOrgId,
    authContext,
  );

  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );

  return setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: input.releaseId,
    expectedVersion: currentPointer?.version ?? null,
    currentReleaseId: currentPointer?.releaseId ?? null,
    promotedBy: authContext.userId,
  });
}

/** Read: the current pointer for one agent+environment. Returns null when
 * nothing has ever been promoted for that pair. */
export async function getCurrentEnvironmentReleasePointer(
  orgId: string,
  agentTargetId: string,
  environment: SetEnvironmentReleasePointerInput["environment"],
): Promise<EnvironmentReleasePointer | null> {
  return getEnvironmentReleasePointer(orgId, agentTargetId, environment);
}

/** Read: every environment's pointer for one agent. */
export async function listEnvironmentReleasePointers(
  orgId: string,
  agentTargetId: string,
): Promise<EnvironmentReleasePointer[]> {
  return listEnvironmentReleasePointersForAgent(orgId, agentTargetId);
}

/** Merged view of every argument this resolver's fields receive. */
interface EnvironmentReleasePointerResolverArguments {
  input: SetEnvironmentReleasePointerInput;
  agentTargetId: string;
  environment: SetEnvironmentReleasePointerInput["environment"];
}

type EnvironmentReleasePointerResolverEvent =
  GovernanceResolverEvent<EnvironmentReleasePointerResolverArguments>;

function authContextFromEvent(
  event: EnvironmentReleasePointerResolverEvent,
): AuthContext {
  const identity: GovernanceEventIdentity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole as string] : [],
  };
}

/** Truncate long string values in event.arguments for safe error logging
 * (mirrors release-resolver.ts's sanitizeForLog convention). */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  return out;
}

export const handler = async (
  event: EnvironmentReleasePointerResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case "promoteEnvironmentReleasePointer": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await promoteEnvironmentReleasePointer(
          event.arguments.input,
          authContext,
          callerOrgId,
        );
      }
      case "getCurrentEnvironmentReleasePointer": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await getCurrentEnvironmentReleasePointer(
          callerOrgId,
          event.arguments.agentTargetId,
          event.arguments.environment,
        );
      }
      case "listEnvironmentReleasePointers": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await listEnvironmentReleasePointers(
          callerOrgId,
          event.arguments.agentTargetId,
        );
      }
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error("environment-release-pointer-resolver error", {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
