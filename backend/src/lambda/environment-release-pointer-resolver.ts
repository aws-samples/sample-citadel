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
 * gate call; UPDATED by finding 23971f32, USER DECISION: fail-closed in
 * BOTH modes): validateReleaseGate ALWAYS computes the full
 * ReleaseGateVerdict first, via resolveReleaseGateEvidence +
 * evaluateReleaseGate — identically in every mode, so permissive-mode
 * rollout telemetry is never silently skipped. Mode only selects what
 * happens NEXT, via the shared governanceDisposition(mode) mapper:
 *
 *   - The decision to BLOCK (throw a ReleaseGateError) is derived from
 *     `disposition.block && verdict.status is a fail state` ALONE,
 *     computed BEFORE the finding write is attempted (`shouldBlock` is
 *     captured first) — a write failure can never SUPPRESS a refusal
 *     that was already decided.
 *   - The finding write itself (shadow AND strict) is now FAIL-CLOSED in
 *     both modes: any error other than the writer's own
 *     ConditionalCheckFailedException dedupe swallow (see
 *     release-gate-finding-writer.ts) propagates out of
 *     validateReleaseGate uncaught, in strict mode exactly as it always
 *     did in shadow. This closes a real gap in the PREVIOUS asymmetric
 *     design (strict wrapped the write in try/catch + log): a
 *     PASS-verdict promotion in strict mode would proceed UNRECORDED if
 *     the ledger write failed — the refusal path was fine (a FAIL
 *     verdict still threw regardless of the write outcome), but a
 *     passing promotion had no such backstop. A promotion must never
 *     proceed without its finding recorded, in either mode — an
 *     infrastructure fault in the ledger write now blocks the promotion
 *     the same way a fail verdict does, which is the deliberate tradeoff
 *     fail-closed accepts.
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
import { randomUUID } from "crypto";
import { hasPermission } from "../utils/auth";
import { extractOrgFromEvent } from "../utils/auth-event";
import { getGovernanceEnforce } from "../utils/governance-flag";
import { getActiveTraceContext } from "../utils/trace-context";
import { governanceDisposition } from "./utils/governance-disposition";
import { evaluateReleaseGate } from "./utils/release-gate";
import { resolveReleaseGateEvidence } from "./utils/release-gate-evidence";
import { resolvePromotionPolicy } from "./utils/promotion-policy-store";
import {
  predecessorEnvironment,
  comparePolicyStrictness,
} from "./utils/promotion-ladder";
import { writeReleaseGateFinding } from "./utils/release-gate-finding-writer";
import { writeReleasePromotionApprovalFinding } from "./utils/release-promotion-approval-writer";
import { publishEvent, createReleaseEvent, EventTypes } from "../utils/events";
import {
  getEnvironmentReleasePointer,
  listEnvironmentReleasePointersForAgent,
  setEnvironmentReleasePointer,
} from "./environment-release-pointer-store";
import { queryEnvironmentReleasePointerHistory } from "./environment-release-pointer-history-store";
import type {
  AgentRelease,
  AuthContext,
  CanaryOpInput,
  CanaryState,
  EnvironmentLiteral,
  EnvironmentReleasePointer,
  EnvironmentReleasePointerHistoryEntry,
  GovernanceEventIdentity,
  GovernanceResolverEvent,
  PromotionApproval,
  ReweightCanaryInput,
  SetEnvironmentReleasePointerInput,
  StartCanaryInput,
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

/** Decision D6: release:canary authorizes start/reweight/abort of a
 * canary episode. promoteCanary (→100%) ALSO requires release:promote
 * (enforced separately in that handler) — a canary-only grant can never
 * reach a full cutover on its own. */
function requireReleaseCanaryPermission(authContext: AuthContext): void {
  if (!hasPermission(authContext, "release:canary")) {
    throw new Error(
      "UnauthorizedError: release:canary permission required to start, reweight, or abort a canary",
    );
  }
}

/** Thrown when a requested canary percent exceeds the org's resolved
 * `canaryMaxBasisPoints` ceiling (decision D5), OR when that ceiling
 * cannot be resolved (fail-closed: an UNREADABLE policy refuses the
 * canary rather than assuming an unlimited ceiling — same discipline as
 * validateReleaseGate's policy branch). Distinct class, like
 * PromotionLadderError, so callers can surface a precise message. */
export class CanaryCeilingError extends Error {
  constructor(
    public readonly requestedBasisPoints: number,
    public readonly ceilingBasisPoints: number | null,
    public readonly reason: "EXCEEDS_CEILING" | "POLICY_UNREADABLE",
  ) {
    super(
      reason === "POLICY_UNREADABLE"
        ? "CanaryCeilingError: the promotion policy is UNREADABLE — refusing the canary change fail-closed rather than assuming an unlimited ceiling"
        : `CanaryCeilingError: requested canary percent ${requestedBasisPoints}bp exceeds the org ceiling of ${ceilingBasisPoints}bp (canaryMaxBasisPoints). Lower the percent or raise the org policy ceiling.`,
    );
    this.name = "CanaryCeilingError";
  }
}

/** Thrown when a canary operation targets an (agent, environment) pair
 * that has no active canary (reweight/promote/abort) — or, for
 * startCanary, when the env has no current stable pointer to canary
 * against. Distinct from ValidationError so callers can tell "there is
 * no canary here" apart from malformed input. */
export class CanaryStateError extends Error {
  constructor(message: string) {
    super(`CanaryStateError: ${message}`);
    this.name = "CanaryStateError";
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

/** Thrown when a promotion violates the dev→staging→prod ladder (G1):
 * the immediately-lower environment's CURRENT pointer does not reference
 * the release being promoted. Distinct class (like ReleaseGateError) so
 * callers can surface a precise "promote to <predecessor> first" message
 * rather than string-matching a generic Error. Consensus decision 1:
 * adjacency is the predecessor's CURRENT pointer, NOT a history-based
 * "was ever there" — promoting a release that has since been superseded
 * in the lower env is a distinct ROLLBACK operation, not built here.
 * Promotion INTO DEV (the ladder entry) is unconstrained and never
 * throws this. */
export class PromotionLadderError extends Error {
  constructor(
    public readonly releaseId: string,
    public readonly targetEnvironment: EnvironmentLiteral,
    public readonly predecessorEnvironment: EnvironmentLiteral,
    public readonly predecessorReleaseId: string | null,
  ) {
    super(
      `PromotionLadderError: release ${releaseId} cannot be promoted to ${targetEnvironment} — the ladder requires ${predecessorEnvironment}'s current pointer to reference it, but ${predecessorEnvironment} currently points at ${predecessorReleaseId ?? "no release"}. Promote it to ${predecessorEnvironment} first.`,
    );
    this.name = "PromotionLadderError";
  }
}

/** Thrown when strict-mode governance requires an explicit human
 * approval (approved=true) before a promotion may proceed, and the
 * caller's `approval` input is absent or `approved=false`. Distinct from
 * ReleaseGateError — this is a MISSING-DECISION refusal (no operator has
 * approved this promotion yet), not a quality-evidence refusal, so
 * callers must be able to tell the two apart and surface a clear,
 * distinct operator message ("get this approved" vs. "the release
 * failed the quality gate"). Decision 8165b7e5: interim human approval
 * rides this existing mutation — there is no separate CIT-030 approval
 * substrate. */
export class ReleaseApprovalRequiredError extends Error {
  constructor(public readonly releaseId: string) {
    super(
      `ReleaseApprovalRequiredError: strict-mode governance requires an explicit approved=true PromotionApproval before promoting release ${releaseId} — none was supplied, or approval was denied. Obtain approval and retry with { approval: { approved: true } }.`,
    );
    this.name = "ReleaseApprovalRequiredError";
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
  const now = new Date().toISOString();

  // Decision ada70113: promotion policy is per-org config, resolved
  // (org, agentTargetId)-scoped via promotion-policy-store.ts (field-level
  // merge floor<-org<-agent; absent config -> DEFAULT_PROMOTION_POLICY).
  // A resolution failure (thrown GetItem or a schema-invalid row) is
  // UNREADABLE and MUST fail the gate closed exactly like a
  // resolveReleaseGateEvidence UNREADABLE_RECORD — never fall back to
  // DEFAULT_PROMOTION_POLICY on this branch, which would silently
  // downgrade an org's intentionally-tightened policy on an
  // infrastructure blip.
  const policyResolution = await resolvePromotionPolicy(
    callerOrgId,
    release.agentTargetId,
    environment,
  );

  // G2 gate-time monotonicity (AUTHORITATIVE, fail-closed): the TARGET
  // env's fully-resolved policy must be at least as strict as the
  // immediately-LOWER env's, for the SAME (org, agent). This sees
  // per-agent overrides that the write-time check in
  // promotion-policy-resolver.ts cannot, so an inversion introduced after
  // the write can never let a prod promotion run under a policy weaker
  // than staging. Skipped for DEV (no predecessor). A violation — or an
  // UNREADABLE predecessor policy — becomes a synthetic FAIL verdict of
  // the SAME shape as the UNREADABLE branch below, so downstream
  // consumers (ledger finding, isFailStatus) treat it identically.
  let monotonicityFailure: string | null = null;
  if (policyResolution.ok) {
    const predecessor = predecessorEnvironment(environment);
    if (predecessor !== null) {
      const predecessorResolution = await resolvePromotionPolicy(
        callerOrgId,
        release.agentTargetId,
        predecessor,
      );
      if (!predecessorResolution.ok) {
        // Fail-closed: can't prove monotonicity against an unreadable
        // lower-env policy, so refuse rather than assume it holds.
        monotonicityFailure = `MONOTONICITY_PREDECESSOR_${predecessorResolution.reason}`;
      } else {
        const comparison = comparePolicyStrictness(
          policyResolution.policy,
          predecessorResolution.policy,
        );
        if (!comparison.monotonic) {
          monotonicityFailure = `MONOTONICITY_VIOLATION: ${comparison.violations
            .map((v) => v.field)
            .join(", ")}`;
        }
      }
    }
  }

  // evidence is only resolved when the policy itself resolved OK AND the
  // per-env monotonicity ladder holds — either failure short-circuits
  // before any evidence read, and the synthetic FAIL verdict below
  // carries the SAME `reasons: [<failure-reason>]` shape
  // resolveReleaseGateEvidence's own ok:false branch produces, so
  // downstream consumers treat every failure source identically.
  const gateBlockingReason: string | null = !policyResolution.ok
    ? policyResolution.reason
    : monotonicityFailure;

  const evidence =
    policyResolution.ok && monotonicityFailure === null
      ? await resolveReleaseGateEvidence(
          release,
          environment,
          callerOrgId,
          policyResolution.policy,
          now,
        )
      : ({ ok: false, reason: gateBlockingReason as string } as const);

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
    // Finding 23971f32 — FAIL-CLOSED in BOTH modes (USER DECISION): a
    // promotion must never proceed without its finding recorded. This
    // used to swallow strict-mode write failures (log + continue) on the
    // theory that shouldBlock was already fixed above and didn't need
    // the write to succeed. That reasoning is true for a FAIL verdict
    // (the refusal still throws either way — the try/catch never
    // affected THAT test), but it is a live gap for a PASS verdict: a
    // passing-verdict strict-mode promotion would proceed UNRECORDED if
    // the ledger write failed, silently defeating the audit trail the
    // gate exists to produce. Unified with shadow's existing behavior
    // below — every non-dedupe write failure propagates in both modes.
    // The writer's own ConditionalCheckFailedException dedupe swallow
    // (release-gate-finding-writer.ts) is untouched — a retried
    // promotion against the same decision must still succeed.
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
 * G1 ladder adjacency (consensus decision 1; decision D7 reuses it for
 * canary): promotion INTO a non-DEV environment requires the immediately-
 * lower env's CURRENT pointer to reference this exact release. DEV is the
 * ladder entry and is unconstrained. Throws PromotionLadderError on
 * violation — the SAME rule and error a full promotion uses, so a canary
 * start (which puts the candidate on real prod traffic) can never be a
 * side-door around the ladder. Read-only; performs no write, so callers
 * that run it before the store's conditional write leave the pointer
 * provably untouched on refusal.
 */
async function assertLadderAdjacency(
  callerOrgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
  releaseId: string,
): Promise<void> {
  const predecessor = predecessorEnvironment(environment);
  if (predecessor === null) return;
  const predecessorPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    agentTargetId,
    predecessor,
  );
  if (!predecessorPointer || predecessorPointer.releaseId !== releaseId) {
    throw new PromotionLadderError(
      releaseId,
      environment,
      predecessor,
      predecessorPointer?.releaseId ?? null,
    );
  }
}

/**
 * Resolve and enforce the org's canary blast-radius ceiling (decision
 * D5). Fail-closed: an UNREADABLE policy refuses the change rather than
 * assuming an unlimited ceiling — identical discipline to
 * validateReleaseGate's policy branch. Throws CanaryCeilingError.
 */
async function enforceCanaryCeiling(
  callerOrgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
  requestedBasisPoints: number,
): Promise<void> {
  const policyResolution = await resolvePromotionPolicy(
    callerOrgId,
    agentTargetId,
    environment,
  );
  if (!policyResolution.ok) {
    throw new CanaryCeilingError(
      requestedBasisPoints,
      null,
      "POLICY_UNREADABLE",
    );
  }
  const ceiling = policyResolution.policy.canaryMaxBasisPoints;
  if (requestedBasisPoints > ceiling) {
    throw new CanaryCeilingError(
      requestedBasisPoints,
      ceiling,
      "EXCEEDS_CEILING",
    );
  }
}

/** Validate a caller-supplied canary percent is a whole number of basis
 * points in [0,10000]. The pure assignArm clamps out-of-range values,
 * but a mutation must reject a malformed request loudly rather than
 * silently clamp an operator's typo. */
function validatePercentBasisPoints(percentBasisPoints: number): void {
  if (
    typeof percentBasisPoints !== "number" ||
    !Number.isInteger(percentBasisPoints) ||
    percentBasisPoints < 0 ||
    percentBasisPoints > 10000
  ) {
    throw new Error(
      `ValidationError: percentBasisPoints must be an integer in [0,10000], got ${percentBasisPoints}`,
    );
  }
}

/**
 * Interim human-approval seam (decision 8165b7e5 — rides this existing
 * mutation; the CIT-030 approval substrate does not exist).
 *
 * Uses the SAME `governanceDisposition(mode)` mapper validateReleaseGate
 * already consults — `disposition.block` selects whether an approval is
 * REQUIRED, `disposition.recordFinding` selects whether a supplied
 * approval (or its absence, in the deny case) is recorded at all:
 *
 *   - strict (block:true): approval with approved=true is REQUIRED.
 *     Absent input, or approved=false, throws
 *     ReleaseApprovalRequiredError. On approved=false specifically, the
 *     denial finding is recorded FIRST (fail-closed — a failed write
 *     aborts the promotion here too), THEN the error is thrown, so the
 *     denial is never lost even though the promotion is refused either
 *     way.
 *   - shadow (block:false, recordFinding:true): approval is NOT
 *     required. If the caller supplied one, it is recorded (permit OR
 *     deny) but never blocks — mirrors validateReleaseGate's own
 *     shadow-mode telemetry-only disposition for the quality gate.
 *   - permissive (recordFinding:false): approval is ignored entirely —
 *     no recording, no requirement, no read of the input at all beyond
 *     this early return.
 *
 * Called AFTER validateReleaseGate and BEFORE
 * getEnvironmentReleasePointer/setEnvironmentReleasePointer — same
 * "everything before the store's conditional write" ordering
 * validateReleaseGate itself documents. The store write remains the
 * LAST statement in promoteEnvironmentReleasePointer.
 *
 * Resolves mode itself via `getGovernanceEnforce(environment)` — the
 * SAME per-environment reader validateReleaseGate uses — rather than
 * threading it through validateReleaseGate's return value, so
 * validateReleaseGate's existing signature and tests are undisturbed.
 */
export async function validatePromotionApproval(
  release: AgentRelease,
  environment: EnvironmentLiteral,
  callerOrgId: string,
  authContext: AuthContext,
  approval: PromotionApproval | null | undefined,
): Promise<void> {
  const mode = await getGovernanceEnforce(environment);
  const disposition = governanceDisposition(mode);

  if (!disposition.recordFinding) {
    // permissive: approval is ignored entirely.
    return;
  }

  if (!approval) {
    // No approval supplied.
    if (disposition.block) {
      throw new ReleaseApprovalRequiredError(release.releaseId);
    }
    // shadow: nothing to record when nothing was supplied.
    return;
  }

  const decision: "permit" | "deny" = approval.approved ? "permit" : "deny";
  const traceContext = getActiveTraceContext();

  if (!approval.approved) {
    // Record the denial finding BEFORE throwing (strict) — fail-closed:
    // a failed write here aborts the promotion, same as the gate
    // finding. In shadow, this records the deny without blocking.
    await writeReleasePromotionApprovalFinding({
      orgId: callerOrgId,
      agentTargetId: release.agentTargetId,
      environment,
      releaseId: release.releaseId,
      decidedBy: authContext.userId,
      decision,
      justification: approval.justification,
      ...(traceContext?.traceId ? { traceId: traceContext.traceId } : {}),
    });

    if (disposition.block) {
      throw new ReleaseApprovalRequiredError(release.releaseId);
    }
    return;
  }

  // approved=true: record the permit finding (strict and shadow both
  // record; only strict required it to reach here at all when absent).
  await writeReleasePromotionApprovalFinding({
    orgId: callerOrgId,
    agentTargetId: release.agentTargetId,
    environment,
    releaseId: release.releaseId,
    decidedBy: authContext.userId,
    decision,
    justification: approval.justification,
    ...(traceContext?.traceId ? { traceId: traceContext.traceId } : {}),
  });
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

  // G1 — ladder adjacency (consensus decision 1). Positioned AFTER
  // permission/existence/org checks and BEFORE the quality gate — a
  // ladder violation refuses the promotion before any evidence read or
  // pointer write (tests assert zero writes on refusal).
  await assertLadderAdjacency(
    callerOrgId,
    input.agentTargetId,
    input.environment,
    input.releaseId,
  );

  await validateReleaseGate(
    targetRelease,
    input.environment,
    callerOrgId,
    authContext,
  );

  await validatePromotionApproval(
    targetRelease,
    input.environment,
    callerOrgId,
    authContext,
    input.approval,
  );

  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );

  const moved = await setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: input.releaseId,
    expectedVersion: currentPointer?.version ?? null,
    currentReleaseId: currentPointer?.releaseId ?? null,
    promotedBy: authContext.userId,
  });

  // G5 — RELEASE_POINTER_MOVED, best-effort POST-commit (consensus
  // decision 2). The move is already durably audited by the atomic
  // history row + the fail-closed ledger finding; making this
  // NOTIFICATION fail-closed would let a transient EventBridge blip abort
  // an already-committed, already-audited move — strictly worse. So a
  // publish failure is logged and swallowed here, never propagated: the
  // caller still receives the successfully-moved pointer.
  await emitReleasePointerMovedEvent(moved);

  return moved;
}

/**
 * Best-effort emit of the RELEASE_POINTER_MOVED event (G5). Deliberately
 * NOT fail-closed — see the call site. Any error is logged and swallowed
 * so a downstream notification failure can never roll back or hide an
 * already-committed, already-audited pointer move.
 */
async function emitReleasePointerMovedEvent(
  moved: EnvironmentReleasePointer,
): Promise<void> {
  try {
    await publishEvent(
      createReleaseEvent(
        EventTypes.RELEASE_POINTER_MOVED,
        moved.agentTargetId,
        {
          orgId: moved.orgId,
          agentTargetId: moved.agentTargetId,
          environment: moved.environment,
          releaseId: moved.releaseId,
          previousReleaseId: moved.previousReleaseId,
          version: moved.version,
          promotedBy: moved.promotedBy,
          promotedAt: moved.promotedAt,
        },
      ),
    );
  } catch (err: unknown) {
    console.error(
      "environment-release-pointer-resolver: best-effort RELEASE_POINTER_MOVED emit failed — move is already committed and audited, continuing",
      {
        agentTargetId: moved.agentTargetId,
        environment: moved.environment,
        releaseId: moved.releaseId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * startCanary — begins a canary episode (decision D2, attribution-only).
 * Runs the IDENTICAL gate chain as a full promotion of the candidate
 * (ladder adjacency D7 + validateReleaseGate + validatePromotionApproval,
 * decision D4/D7) because the candidate begins receiving real prod
 * traffic at start, then writes the canary onto the pointer while keeping
 * `releaseId` = the current STABLE release. Salt is minted ONCE here and
 * preserved across reweight (decision D3). One version-gated atomic
 * pointer+history write (transitionType CANARY_START).
 */
export async function startCanary(
  input: StartCanaryInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<EnvironmentReleasePointer> {
  requireReleaseCanaryPermission(authContext);
  validatePercentBasisPoints(input.percentBasisPoints);

  const candidate = await getAgentRelease(input.candidateReleaseId);
  if (!candidate) {
    throw new Error(
      `ValidationError: candidate release not found: ${input.candidateReleaseId}`,
    );
  }
  if (candidate.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: release ${input.candidateReleaseId} belongs to a different org — a canary must never point at another org's release`,
    );
  }

  // The env must already have a current STABLE pointer to canary against
  // — a canary splits traffic between the running stable release and the
  // candidate, so there must be a stable arm.
  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );
  if (!currentPointer) {
    throw new CanaryStateError(
      `no current release pointer for ${input.agentTargetId}/${input.environment} — promote a stable release before starting a canary`,
    );
  }
  if (currentPointer.canary) {
    throw new CanaryStateError(
      `a canary is already active for ${input.agentTargetId}/${input.environment} — reweight, promote, or abort it first`,
    );
  }

  // D7: candidate must satisfy the same ladder adjacency as a promotion.
  await assertLadderAdjacency(
    callerOrgId,
    input.agentTargetId,
    input.environment,
    input.candidateReleaseId,
  );
  // Same quality gate + approval a full promotion faces.
  await validateReleaseGate(
    candidate,
    input.environment,
    callerOrgId,
    authContext,
  );
  await validatePromotionApproval(
    candidate,
    input.environment,
    callerOrgId,
    authContext,
    input.approval,
  );
  // D5 org ceiling (fail-closed) — checked BEFORE the write.
  await enforceCanaryCeiling(
    callerOrgId,
    input.agentTargetId,
    input.environment,
    input.percentBasisPoints,
  );

  const canary: CanaryState = {
    candidateReleaseId: input.candidateReleaseId,
    percentBasisPoints: input.percentBasisPoints,
    stickiness: input.stickiness,
    salt: randomUUID(),
    startedAt: new Date().toISOString(),
    startedBy: authContext.userId,
  };

  return setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: currentPointer.releaseId, // stable arm unchanged
    expectedVersion: currentPointer.version,
    currentReleaseId: currentPointer.releaseId,
    promotedBy: authContext.userId,
    canary,
    transitionType: "CANARY_START",
  });
}

/**
 * reweightCanary — moves ONLY the threshold `percentBasisPoints`; the
 * salt (hence every key's bucket) is preserved verbatim (decision D3), so
 * only keys the threshold crosses re-bucket. No re-gate (the candidate was
 * gated at start). One version-gated atomic write (CANARY_REWEIGHT).
 */
export async function reweightCanary(
  input: ReweightCanaryInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<EnvironmentReleasePointer> {
  requireReleaseCanaryPermission(authContext);
  validatePercentBasisPoints(input.percentBasisPoints);

  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );
  if (!currentPointer || !currentPointer.canary) {
    throw new CanaryStateError(
      `no active canary for ${input.agentTargetId}/${input.environment} to reweight`,
    );
  }

  await enforceCanaryCeiling(
    callerOrgId,
    input.agentTargetId,
    input.environment,
    input.percentBasisPoints,
  );

  const canary: CanaryState = {
    ...currentPointer.canary,
    percentBasisPoints: input.percentBasisPoints, // salt PRESERVED
  };

  return setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: currentPointer.releaseId,
    expectedVersion: currentPointer.version,
    currentReleaseId: currentPointer.releaseId,
    promotedBy: authContext.userId,
    canary,
    transitionType: "CANARY_REWEIGHT",
  });
}

/**
 * promoteCanary — full cutover to the candidate (→100%): sets `releaseId`
 * = candidate, clears the canary. Maximum blast radius, so decision D4
 * re-runs the FULL ladder + quality gate + approval on the candidate with
 * the freshest evidence (predecessor pointer / policy / eval can drift
 * between start and promote). Decision D6: requires release:canary AND
 * release:promote. One version-gated atomic write (CANARY_PROMOTE) + a
 * best-effort RELEASE_POINTER_MOVED emit.
 */
export async function promoteCanary(
  input: CanaryOpInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<EnvironmentReleasePointer> {
  requireReleaseCanaryPermission(authContext);
  requireReleasePromotePermission(authContext); // D6: →100% needs promote too

  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );
  if (!currentPointer || !currentPointer.canary) {
    throw new CanaryStateError(
      `no active canary for ${input.agentTargetId}/${input.environment} to promote`,
    );
  }

  const candidateReleaseId = currentPointer.canary.candidateReleaseId;
  const candidate = await getAgentRelease(candidateReleaseId);
  if (!candidate) {
    throw new Error(
      `ValidationError: candidate release not found: ${candidateReleaseId}`,
    );
  }
  if (candidate.orgId !== callerOrgId) {
    throw new Error(
      `SecurityError: candidate release ${candidateReleaseId} belongs to a different org`,
    );
  }

  // D4 — re-run the full promotion gate at the moment of full cutover.
  await assertLadderAdjacency(
    callerOrgId,
    input.agentTargetId,
    input.environment,
    candidateReleaseId,
  );
  await validateReleaseGate(
    candidate,
    input.environment,
    callerOrgId,
    authContext,
  );
  await validatePromotionApproval(
    candidate,
    input.environment,
    callerOrgId,
    authContext,
    input.approval,
  );

  const moved = await setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: candidateReleaseId, // stable := candidate
    expectedVersion: currentPointer.version,
    currentReleaseId: currentPointer.releaseId,
    promotedBy: authContext.userId,
    canary: null, // cleared
    transitionType: "CANARY_PROMOTE",
  });

  await emitReleasePointerMovedEvent(moved);
  return moved;
}

/**
 * abortCanary — reverts to 0% (stable stays the current stable release),
 * clears the canary. Always safe (reverting to the already-live stable),
 * so no gate. Decision D6: release:canary. One version-gated atomic write
 * (CANARY_ABORT).
 */
export async function abortCanary(
  input: CanaryOpInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<EnvironmentReleasePointer> {
  requireReleaseCanaryPermission(authContext);

  const currentPointer = await getEnvironmentReleasePointer(
    callerOrgId,
    input.agentTargetId,
    input.environment,
  );
  if (!currentPointer || !currentPointer.canary) {
    throw new CanaryStateError(
      `no active canary for ${input.agentTargetId}/${input.environment} to abort`,
    );
  }

  return setEnvironmentReleasePointer({
    orgId: callerOrgId,
    agentTargetId: input.agentTargetId,
    environment: input.environment,
    releaseId: currentPointer.releaseId, // stable unchanged
    expectedVersion: currentPointer.version,
    currentReleaseId: currentPointer.releaseId,
    promotedBy: authContext.userId,
    canary: null, // cleared
    transitionType: "CANARY_ABORT",
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

/** Read: the append-only promotion history for one agent+environment
 * (G6). Oldest→newest; optionally bounded to promotedAt <= `until` — the
 * "what ran in <env> on date D" query. Read-only: delegates to the
 * dedicated history reader module, never the pointer writer. */
export async function getEnvironmentReleasePointerHistory(
  orgId: string,
  agentTargetId: string,
  environment: SetEnvironmentReleasePointerInput["environment"],
  until?: string | null,
): Promise<EnvironmentReleasePointerHistoryEntry[]> {
  return queryEnvironmentReleasePointerHistory(
    orgId,
    agentTargetId,
    environment,
    until ?? undefined,
  );
}

/** Merged view of every argument this resolver's fields receive. */
interface EnvironmentReleasePointerResolverArguments {
  input:
    | SetEnvironmentReleasePointerInput
    | StartCanaryInput
    | ReweightCanaryInput
    | CanaryOpInput;
  agentTargetId: string;
  environment: SetEnvironmentReleasePointerInput["environment"];
  until?: string | null;
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
          event.arguments.input as SetEnvironmentReleasePointerInput,
          authContext,
          callerOrgId,
        );
      }
      case "startCanary": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await startCanary(
          event.arguments.input as StartCanaryInput,
          authContext,
          callerOrgId,
        );
      }
      case "reweightCanary": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await reweightCanary(
          event.arguments.input as ReweightCanaryInput,
          authContext,
          callerOrgId,
        );
      }
      case "promoteCanary": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await promoteCanary(
          event.arguments.input as CanaryOpInput,
          authContext,
          callerOrgId,
        );
      }
      case "abortCanary": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await abortCanary(
          event.arguments.input as CanaryOpInput,
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
      case "environmentReleasePointerHistory": {
        const callerOrgId = await extractOrgFromEvent(event);
        if (!callerOrgId) {
          throw new Error(
            "ValidationError: caller organization could not be determined",
          );
        }
        return await getEnvironmentReleasePointerHistory(
          callerOrgId,
          event.arguments.agentTargetId,
          event.arguments.environment,
          event.arguments.until,
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
