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
| Start / reweight / abort a canary | `release:canary` |
| Promote a canary to 100% | `release:canary` **and** `release:promote` |
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

For a **canary**, the rollback IS built: the manual surface is the
existing `abortCanary` (decision D5), and an automated, metric-driven
`AUTO_ABORT_CANARY` is performed by the auto-rollback evaluator (§17).
Full-release (stable-pointer) automated rollback remains deferred (D4).

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


## 16. Canary agent releases (attribution-only interim)

Canary lets an operator run a *candidate* release alongside the current
*stable* release for one `(agent, environment)` and route a bounded,
deterministic fraction of dispatch to the candidate — then promote it to
100% or abort back to 0% as a single, audited pointer move.

> **HONEST SCOPING — read this before using canary.** This is an
> **attribution-only** interim (decision D2). **Both arms run the identical
> live agent config today.** The canary does **not** yet change agent
> behavior: there is no release→config binding, so a dispatch routed to
> the `candidate` arm executes the same prompts/model/tools/policy as the
> `stable` arm. What the canary DOES do is **deterministically label**
> which release *would* serve each session (the arm) and record that label
> on usage rows, the cost ledger, findings, and the `CanaryAssignment`
> CloudWatch metric (dimensioned `ReleaseArm=stable|candidate`), so you can
> measure the split and per-arm cost/quality *before* behavioral binding
> is built. Do **not** present canary to stakeholders as behavioral
> traffic-shifting until the release→config binding lands as a separate,
> separately-gated change. The pointer/history `transitionType`
> (`CANARY_START|REWEIGHT|PROMOTE|ABORT`) and this section are the record
> of that limitation.

### Assignment (deterministic, sticky)

The arm is a **pure** function `assignArm(stickinessKey, percentBasisPoints,
salt)` (mirrored byte-for-byte in TS `canary-assignment.ts` and Python
`canary_assignment.py`, guarded by a cross-language parity fixture):
`bucket = sha256(salt + ":" + key)[:8] mod 10000`, `candidate` iff
`bucket < percentBasisPoints`.

- **Stickiness key (decision D1):** assigned ONCE at flow entry from a
  **server-minted** envelope field — `orchestrationId` (supervisor) /
  `executionId` (stepRunner). Never read from a client-supplied field; any
  external `releaseArm`/`resolvedReleaseId` claim on the envelope is
  stripped at the boundary and re-minted server-side. `conversationId`
  threading is NOT wired yet, so a chat spanning multiple orchestrations
  may re-bucket between orchestrations (within one orchestration/execution
  it never mixes arms).
- **Salt (decision D3):** minted once at `startCanary`, **preserved
  verbatim across every reweight**, cleared only on promote/abort. Because
  the salt (hence every key's bucket) is fixed across a reweight, changing
  the percent only re-buckets keys the threshold crosses — a one-way
  delta-band move — never a wholesale flap. There is **no pin store**.

### Operations & RBAC (decision D6)

| Action | Permission | Gate |
|---|---|---|
| `startCanary` | `release:canary` | Full ladder adjacency (D7) + quality gate + approval — identical to a promotion, because the candidate starts serving real traffic. Also enforces the org ceiling (below). |
| `reweightCanary` | `release:canary` | Ceiling only; salt preserved; NO re-gate. |
| `promoteCanary` (→100%) | `release:canary` **AND** `release:promote` | Re-runs the FULL ladder + quality gate + approval (decision D4) — max blast radius, freshest evidence. Sets `stable := candidate`, clears canary. |
| `abortCanary` (→0%) | `release:canary` | None (reverting to the already-live stable is always safe). Clears canary. |

Every transition is ONE version-gated atomic `TransactWriteItems` (pointer
+ history), same optimistic lock as a promotion — a raced transition loses
with `ConcurrentPromotionError` and writes nothing.

### Org ceiling (decision D5)

`canaryMaxBasisPoints` bounds the maximum canary fraction. **Default 2500
(25%)**; raise it explicitly per-org/per-agent/per-env through the existing
`PromotionPolicy` override chain. It is a **tightening** ceiling
(`prod ≤ staging`, enforced by the same monotonicity check as latency/cost/
evidence-age), so a prod canary can never expose a wider fraction than
staging. An UNREADABLE policy refuses the canary change fail-closed —
`CanaryCeilingError`.

### Triage

| Symptom | Likely cause / action |
|---|---|
| `CanaryCeilingError` | Requested percent > org `canaryMaxBasisPoints`, or the policy is UNREADABLE. Lower the percent or raise the ceiling. |
| `CanaryStateError` | No active canary for that `(agent, env)` (reweight/promote/abort), or no stable pointer to canary against (start). |
| `PromotionLadderError` at start/promote | Predecessor env's current pointer ≠ candidate (D7/D4). Promote the lower env first. |
| Everyone on stable despite a canary | The choke point failed to thread a server-minted stickiness key — the safe degradation. Check `orchestrationId`/`executionId` presence. |


## 17. Automated metric-driven rollback (auto-rollback evaluator)

A scheduled evaluator can automatically **abort a breaching canary** —
zeroing the candidate arm back to the human-promoted stable release —
without an operator in the loop. It is **opt-in, fail-safe, and
canary-abort-only** in v1.

### What it does (and does NOT do)

- **Action scope (decision D4): `AUTO_ABORT_CANARY` ONLY.** The evaluator
  can only zero a candidate arm (leaving the stable `releaseId`
  untouched). It has **no promote path and cannot flip the stable
  pointer** — by construction it can never move the pointer *below* the
  last human-promoted stable (the "floor"). Its IAM role grants no
  promote capability; the abort-only bound is additionally enforced in
  code by the shared store helper `performAutoAbortCanary`, which mints
  the `promotedBy = "system:release-rollback-evaluator"` principal and the
  `AUTO_ABORT_CANARY` transition **server-side** (caller-supplied values
  are never honored).
- **Metric scope (decision D3): cost-per-invocation + model-call p95
  latency ONLY.** These are the only two signals with per-arm attribution
  today (via the cost ledger's `releaseId` + `releaseArm`, written from
  the arbiter usage rows). `errorRateMax`, `policyViolationFindingRateMax`,
  and `driftScoreMax` are accepted as **policy fields** but always resolve
  to `INSUFFICIENT_DATA` and **never trigger** until their per-arm
  attribution lands (finding-rate is an E12 follow-up; drift is gated on
  prod-sample arm attribution that does not exist yet). Missing data
  **never** rolls back.
- **Fail-safe everywhere.** Auto-rollback is off unless an org sets
  `rollbackPolicy.enabled = true` AND authors a threshold. A `null`
  threshold is "not evaluated". A candidate arm with fewer than
  `minSampleCount` samples yields `INSUFFICIENT_DATA` (no action). An
  UNREADABLE policy → the evaluator does nothing.

### Configuring it

`rollbackPolicy` is a distinct sub-object on the **same**
`PROMOTION_POLICY_CONFIG_TABLE` row as the promotion policy (decision D1),
with the identical `DEFAULT ← org ← per-agent ← per-env` field-level merge
and admin authz. Example (per-env):

```
perEnvironmentRollbackOverrides: {
  staging: {
    enabled: true,
    costPerInvocationMaxMicros: 1500,   // candidate-arm ceiling, micros
    latencyP95MaxMs: 6000,              // candidate-arm model-call p95 ceiling
    minSampleCount: 20,                 // below this → INSUFFICIENT_DATA
    evaluationWindowMinutes: 15,
    action: "ABORT_CANARY"
  }
}
```

### Trigger cadence + detection latency (be honest about lag)

The evaluator runs on a **1-minute scheduled poll ONLY** (decision D2 — no
SNS/alarm subscription in v1). "Rolls back within one evaluation cycle"
therefore means **within roughly one minute of the metric being
observable** — NOT one minute from the bad request. The true
detection-to-action latency is:

```
poll interval (≤1 min)
  + cost-ledger WRITE LAG (a candidate-arm invocation is not queryable
    until its usage row has been ingested into the cost ledger — this is
    an eventually-consistent, event-driven path, not synchronous)
  + evaluationWindowMinutes (the lookback the p95/cost is computed over,
    default 15 min, must accumulate ≥ minSampleCount candidate samples)
```

So a freshly-started canary that is bad from the first request will not
auto-abort until enough attributed ledger rows exist in the window to meet
`minSampleCount`. This is deliberate (thin data must never trigger); tune
`minSampleCount` / `evaluationWindowMinutes` against your traffic rate. Do
not expect sub-minute reaction — the ledger write lag alone can exceed the
poll interval.

### Enumeration + the deploy-time GSI backfill gap

Active canaries are enumerated via the sparse **`ActiveCanaryIndex`** GSI
on the pointer table (decision D8 — never a Scan). The index marker
(`activeCanaryPk`/`activeCanarySk`) is written by the sole pointer writer
**only when a canary is present**, inside the same atomic Put; clearing
the canary removes it from the index in the same write.

> **BACKFILL GAP (operational):** the marker is maintained **going
> forward**. A canary that was **already active at the moment this feature
> deployed** has **no marker yet**, so the evaluator will not see it until
> its **next pointer write** (a reweight, or any move) re-materializes the
> item with the marker. To force-materialize markers for pre-existing
> canaries after deploy, reweight each active canary to its current
> percent (a no-op-percent reweight still rewrites the pointer and writes
> the marker). Audit active canaries via `environmentReleasePointerHistory`
> and reweight any that predate the deploy.

### Every auto-rollback is an audited finding (decision D6)

On a breach the evaluator: captures evidence → does the **version-gated**
abort write (the commit; its gap-free history row is the atomic legal
record) → writes a **write-once** `GovernanceFinding`
(`category: "auto-rollback"`, keyed `sha256(org#agent#env#fromVersion#action)`)
carrying the `rollback_evidence` (metric, arm, observed vs threshold,
sample count, window, from/to release) → best-effort emits
`governance.release.auto_rollback`.

**Exactly-once under concurrent evaluators** is the pointer's version
`ConditionExpression`: two evaluators racing the same version both attempt
the write, DynamoDB lets exactly one win, the loser gets
`ConcurrentPromotionError` and no-ops.

**If the finding write fails after the committed move**, the evaluator
emits the CloudWatch metric **`Citadel/Governance /
AutoRollbackFindingWriteFailure`** (alarm:
`citadel-auto-rollback-finding-write-failure-<env>`, wired to the SLO
alarm topic) so a committed-but-unrecorded rollback **pages** — the move
is still audited via the history row, and the deterministic finding id
lets a later run re-write the finding idempotently.

### Triage

| Symptom | Likely cause / action |
|---|---|
| Bad canary not auto-aborting | Check `rollbackPolicy.enabled`, a non-null threshold, and that the candidate arm has ≥ `minSampleCount` attributed ledger rows in the window. Remember the cost-ledger write lag + window. |
| Canary active before deploy never evaluated | Deploy-time GSI backfill gap — reweight it once to materialize the `ActiveCanaryIndex` marker (see above). |
| `AutoRollbackFindingWriteFailure` alarm firing | An abort committed but its ledger finding write failed. The move is audited via history; re-drive the finding (idempotent id) or investigate the governance-ledger write path. |
| Auto-rollback fired but stable changed | Should be impossible in v1 (abort-only leaves stable untouched). If observed, treat as a security incident — the auto path must only mint `AUTO_ABORT_CANARY`. |
