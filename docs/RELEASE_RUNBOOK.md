# Release Promotion Runbook

How an agent release moves through environments (dev → staging → prod) in
Citadel, who may do it, what gates it, and how to answer "what ran in prod
on date D". Sibling to [GOVERNANCE_ROLLOUT_RUNBOOK.md](GOVERNANCE_ROLLOUT_RUNBOOK.md).

> **Name mapping.** The product concept "promoteRelease" is implemented by
> the GraphQL mutation **`promoteEnvironmentReleasePointer`**. There is no
> second `promoteRelease` mutation — a duplicate promote path would be a
> security/consistency hazard. All gating hangs off this one mutation.

## 1. Overview & lifecycle

A release is **cut once** and **promoted many times**:

1. **Cut** — `cutAgentRelease` produces an immutable, content-addressed
   `AgentRelease` (`releaseId = sha256(constituents)`, `release-store.ts`).
   The bytes never change afterward.
2. **Promote** — `promoteEnvironmentReleasePointer` moves a per-environment
   *pointer* (`EnvironmentReleasePointersTable`) to reference that release.
   Promotion **never re-cuts or rebuilds** — the same immutable `releaseId`
   moves across DEV → STAGING → PROD. (Acceptance A1 is satisfied by
   construction.)

The pointer is a **mutable cursor**; the release it points at is immutable.

## 2. Roles / RBAC

| Action | Permission |
|---|---|
| Cut a release | `release:cut` |
| Promote a release (move a pointer) | `release:promote` |
| Author promotion policy | `admin` (platform-wide) |

The caller's org is derived from the `custom:organization` claim, never
from input. A release belonging to another org can never be pointed at
(`SecurityError`).

## 3. Cutting a release (prerequisite)

Use `cutAgentRelease`. A release bundles the agent config, prompt
versions, exec-spec, model/tool snapshots, policy snapshot, and eval
evidence. Only a successfully-cut release can be promoted.

## 4. Promotion ladder (G1 — adjacency)

Promotion is **strictly adjacent**: DEV → STAGING → PROD, one hop at a
time, via a separate `promoteEnvironmentReleasePointer` call per hop.

- **DEV** is the ladder entry — promotion into DEV is unconstrained.
- **STAGING** requires DEV's **current** pointer to reference the exact
  release being promoted.
- **PROD** requires STAGING's **current** pointer to reference it.

The invariant is the **predecessor's CURRENT pointer**, not "was ever
there": *what is running in staging now is what gets promoted to prod.*
Trying to promote a release that has since been **superseded** in the
lower environment fails with `PromotionLadderError` — that scenario is a
**rollback**, a distinct operation not performed by this mutation (§12).

## 5. Promotion policy — per-org / per-agent / per-env thresholds (G2)

Admins author a `PromotionPolicyConfig` (`setPromotionPolicy`, admin-only)
that sets the quality **floor** every promotion is gated against.
Resolution precedence (low → high, field-by-field merge):

```
DEFAULT_PROMOTION_POLICY
  ← policy (org-wide)
  ← perAgentPolicyOverrides[agentTargetId]
  ← perEnvironmentPolicyOverrides[environment]     (most authoritative)
```

An unreadable/malformed policy **fails closed** (never silently falls
back to defaults).

### prod ≥ staging monotonicity

The policy ladder must get **stricter** going up, per field/direction:

| Field | Direction going up the ladder |
|---|---|
| `taskSuccessMin`, `policyComplianceMin`, `minSampleCount` | floors **rise** (≥) |
| `latencyP95TargetMs`, `avgCostBudgetUsd`, `maxEvidenceAgeDays` | ceilings **tighten** (≤) |
| `requiredGateClasses` | **superset** (⊇) |
| `allowNoBaselineOnAbsoluteFloors` | prod **no looser** than staging |

Enforced at **two** points:

1. **Write-time** (`setPromotionPolicy`) — a non-monotonic authored
   ladder is rejected with a `ValidationError` before persisting (catches
   the common misconfig early).
2. **Gate-time (authoritative, fail-closed)** — at promotion, the target
   env's fully-resolved policy is compared against the immediately-lower
   env's for the same (org, agent). A violation becomes a synthetic gate
   FAIL, which strict mode blocks. This sees per-agent overrides that
   could create an inversion after the write-time check.

## 6. Enforcement modes per environment

Mode comes from SSM `/citadel/governance/enforce/{env}`:

- **permissive** — evaluate + telemetry only, never block, no finding.
- **shadow** — evaluate, **record** a finding, do not block.
- **strict** — evaluate, record, **block** on a FAIL verdict.

Modes progress permissive → shadow → strict, per environment, mirroring
the governance rollout runbook. Mode-lookup failure falls back to
**shadow** (matches the Python dispatch path).

## 7. Interim human approval (strict)

In **strict** mode a promotion also requires an explicit
`approval: { approved: true }` on the mutation input
(`ReleaseApprovalRequiredError` otherwise). `approved: false` records a
denial finding and refuses. `decidedBy` is server-derived from the
caller's identity, never from input. In shadow, a supplied approval is
recorded but not required; in permissive it is ignored.

## 8. Reading history — "what ran in PROD on date D" (G6)

Every pointer move appends an **atomic** row to
`EnvironmentReleasePointerHistoryTable` (written in the SAME
`TransactWriteItems` as the pointer move, so history is gap-free). Query:

```graphql
query {
  environmentReleasePointerHistory(
    agentTargetId: "agent-123"
    environment: PROD
    until: "2026-06-01T00:00:00.000Z"   # date D (optional)
  ) {
    releaseId
    promotedAt
    promotedBy
    version
  }
}
```

Rows are returned oldest → newest, bounded to `promotedAt <= until`. The
release running **at date D** is the **last** row (greatest
`promotedAt`/`version`) in the result.

## 9. Audit trail

Every promotion produces, durably:

- a **governance ledger finding** (`release-promotion`,
  `release-promotion-approval`) with the deciding `traceId` (fail-closed
  in shadow and strict);
- an **atomic history row** (§8);
- a best-effort **`citadel.*` event** `release.pointer.moved` (§10).

## 10. `release.pointer.moved` event (G5)

After a successful move, a best-effort `release.pointer.moved` event is
published to the shared bus (`Source: citadel.backend`), carrying
`{orgId, agentTargetId, environment, releaseId, previousReleaseId,
version, promotedBy, promotedAt}` plus trace context. It is **post-commit
and never blocking**: the move is already durably audited by the history
row + ledger finding, so a transient EventBridge failure is logged and
swallowed rather than aborting an already-committed move. Consumers:
governance graph snapshot, dashboards. See
[EVENTBRIDGE_CATALOG.md](EVENTBRIDGE_CATALOG.md).

## 11. Arbiter env-scoped dispatch (G3)

Each environment's Supervisor and Step Runner Lambdas read
`RELEASE_DISPATCH_ENVIRONMENT` (the feature switch, uppercased —
`DEV`/`STAGING`/`PROD`) and `RELEASE_DEFAULT_ORG_ID` (the named org seam),
set per-env stack via CDK (`arbiter-stack.ts`). `resolve_release`
(Python, unchanged) resolves that env's own pointer set at dispatch time,
returning `RESOLVED` / `NO_POINTER` / `LOOKUP_FAILED` (a lookup failure is
**not** the same as no pointer). Grandfathering and shadow-fallback are
inherited from the governance path. When the env vars are unset the gate
is a forward-compatible no-op (every lookup → `NO_POINTER`).

> **Known constraint (follow-up, not this story):** the arbiter resolves
> for a single `RELEASE_DEFAULT_ORG_ID` per deployment. True multi-tenant
> per-env dispatch needs the org from the dispatch/orchestration context.

## 12. Bootstrapping a new environment's first pointer

The first promotion into an empty target env has **no baseline** to
compare against. Under the default policy, `NO_BASELINE` is a fail state
(`allowNoBaselineOnAbsoluteFloors = false`). To bootstrap, either set
`allowNoBaselineOnAbsoluteFloors = true` (pass on absolute floors alone)
or perform the first move in **shadow** mode.

## 13. Rollback (distinct operation — not built here)

Rolling back = promoting the `previousReleaseId` back into the
environment. The gate still applies. Because adjacency uses the
predecessor's **current** pointer, a plain rollback of a superseded
release is intentionally blocked by `PromotionLadderError`; a break-glass
rollback path is a separate operation and is **not** part of
`promoteEnvironmentReleasePointer`.

## 14. Incident triage

| Symptom | Likely cause / action |
|---|---|
| `PromotionLadderError` | Predecessor env's current pointer ≠ this release. Promote the lower env first, or confirm you are not trying to rollback a superseded release. |
| `ReleaseGateError` | Quality gate FAIL (regression, threshold, stale evidence) **or** a prod<staging monotonicity inversion. Inspect the ledger finding's `reasons`. |
| `ReleaseApprovalRequiredError` | Strict mode; supply `approval: { approved: true }`. |
| `ConcurrentPromotionError` | Two promotions raced; the loser's transaction (pointer + history) was atomically rejected. Reload and retry. |
| Dangling pointer / unexpected release live | Read `environmentReleasePointerHistory` (§8) to reconstruct the move sequence. |

## 15. Metrics / alarms

Promotion outcomes are observable via the governance ledger findings and
the `release.pointer.moved` event stream; wire dashboards/alarms off
those (deny-rate, gate-refusal-rate, monotonicity-refusal-rate) alongside
the platform-health SLO alarms in [OBSERVABILITY.md](OBSERVABILITY.md).
