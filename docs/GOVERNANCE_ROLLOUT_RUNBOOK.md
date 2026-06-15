# Governance Rollout Runbook — AgentCore Registry

Operational procedure for rolling out registry-backed governance modes in
production, including the permissive → shadow → strict mode flip.

> **Applies to:** `feat/ai-governance` ≥ PR 2.
> **Last updated:** 2026-05-08.

## Table of Contents

- [Governance Rollout Runbook — AgentCore Registry](#governance-rollout-runbook--agentcore-registry)
  - [Table of Contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
  - [Mode Semantics (Decision #6)](#mode-semantics-decision-6)
  - [Decision Context](#decision-context)
  - [Pre-flip Readiness Checklist](#pre-flip-readiness-checklist)
    - [Data integrity](#data-integrity)
    - [Telemetry](#telemetry)
    - [Rollback readiness](#rollback-readiness)
    - [Ownership and communication](#ownership-and-communication)
  - [Flip Procedure (Happy Path)](#flip-procedure-happy-path)
    - [Step 1 — Pre-flip snapshot](#step-1--pre-flip-snapshot)
    - [Step 2 — Flip to `shadow`](#step-2--flip-to-shadow)
    - [Step 3 — Soak window](#step-3--soak-window)
    - [Step 4 — Flip to `strict`](#step-4--flip-to-strict)
    - [Step 5 — Post-flip soak](#step-5--post-flip-soak)
  - [Rollback Procedure](#rollback-procedure)
    - [Trigger conditions](#trigger-conditions)
    - [Rollback steps](#rollback-steps)
  - [Observability — What To Watch](#observability--what-to-watch)
    - [Metrics](#metrics)
    - [Log queries](#log-queries)
    - [SLOs](#slos)
  - [FAQ / Common Pitfalls](#faq--common-pitfalls)
  - [References](#references)
    - [In-repo references](#in-repo-references)
    - [Decision record](#decision-record)

## Prerequisites

Before any mode flip beyond `permissive` is attempted, confirm the following
are in place. Each item is a hard gate — do not skip.

- PRs 0 through 4 of the governance retrofit are landed locally or are
  moving through the release train ahead of this procedure. PR 5 (this
  document) is merged.
- The AWS Bedrock AgentCore Registry is provisioned via CDK. The
  registry construct lives in `BackendStack` (PR 2). Confirm the stack
  has deployed cleanly in the target environment and the registry ID is
  available as a stack output.
- Every governance-aware Lambda has the following environment variables
  set, wired through CDK:
  - `REGISTRY_ID` — the AgentCore Registry ID from the stack output.
  - `AUTHORITY_UNITS_TABLE` — the DynamoDB table name for the
    authority-unit store.
  - `GOVERNANCE_MODE` — one of `permissive`, `shadow`, or `strict`.
    Default value for a fresh deploy is `permissive`.
- The Python arbiter reads registry records via
  `arbiter/catalog/registry_client.py` (PR 4). Confirm the module is
  installed in the arbiter Lambda package and that its boto3 dependency
  resolves.
- CloudWatch observability is currently limited to a single governance
  alarm: `citadel-offfrontier-escalations-${env}`, wired to the
  `CitadelGovernance/OffFrontierEscalations` metric emitted from the
  `escalate` tool (`arbiter/workerWrapper/tools/escalate.py`). This
  alarm publishes to the `citadel-governance-escalations-${env}` SNS
  topic.

  The gate-decision, workload-identity-mismatch, and registry-sync
  dashboards referenced in earlier drafts of this runbook have **not**
  yet been provisioned. Until the governance gate emits its own
  telemetry (tracked as a PR 4 follow-up), operators must rely on:
  - the structured log queries in [Observability — What To Watch](#observability--what-to-watch);
  - the `OffFrontierEscalationAlarm` signal as a coarse indicator that
    agents are hitting fail-closed paths.

## Mode Semantics (Decision #6)

The governance gate operates in one of three modes. The mode is set per
Lambda via the `GOVERNANCE_MODE` environment variable. Mode changes do not
require a code deploy — update the CloudFormation parameter and redeploy
the Lambda function configuration only.

| Mode         | Gate behaviour                                                                            | Logging                                                                    | Rollout stage                                 |
|--------------|-------------------------------------------------------------------------------------------|----------------------------------------------------------------------------|-----------------------------------------------|
| `permissive` | Gate is bypassed entirely. All requests proceed regardless of workload-identity match.    | No gate decision log; normal request logs only.                            | Initial deploy; rollback parking state.        |
| `shadow`     | Gate evaluates but does not block. Mismatches are logged but the request proceeds.        | `level=WARN` entry to CloudWatch Logs on every mismatch, including the reason. | Validation window before the strict flip.      |
| `strict`     | Gate enforces fail-closed. Mismatches reject the dispatch with a structured error.        | `level=INFO` on ALLOW; `level=WARN` with full context on DENY.             | Production steady state after successful soak. |

The modes share one invariant: the gate position in the engine does not
change with the mode. Only the terminal decision (enforce versus log)
changes. See [Decision Context](#decision-context) for the engine position.

## Decision Context

Three decisions from the retrofit decision record (see
[References](#references)) shape this runbook.

- **Decision #6 — Workload-identity gate position and strictness.** The
  workload-identity gate sits at position 3 in the governance engine,
  evaluated after authority-unit resolution (position 2) and before
  composition contract evaluation (position 4). In `strict` mode the gate
  fails closed on any missing or mismatched identity; in `permissive` and
  `shadow` mode it logs but does not deny.
- **Decision #8 — Production launch sequence.** The production launch
  sequence is `shadow` first (for a minimum soak window; default 7 days),
  then a flip to `strict`. Direct `permissive` → `strict` flips are not
  permitted in production. The soak window exists to surface data-quality
  issues (missing `registryId` attributes on authority units, stale records)
  before they become user-facing rejections.
- **Decision #9 — Authority-unit key rename.** `AuthorityUnit.appId` has
  been renamed to `AuthorityUnit.registryId`. Every authority-unit record
  must be migrated to the new key before `GOVERNANCE_MODE` can be raised
  beyond `permissive`. Cross-reference:
  [migration check](#pre-flip-readiness-checklist).

## Pre-flip Readiness Checklist

Run through every item before setting `GOVERNANCE_MODE` to `shadow`. Run
again before flipping to `strict`. Check off each item in the change
ticket; do not flip on a partial checklist.

### Data integrity

1. **Every active `AuthorityUnit` has a non-null `registryId`.** Scan the
   authority-units table and confirm zero rows with a missing or null
   `registryId` attribute.

   ```bash
   aws dynamodb scan \
     --table-name "$AUTHORITY_UNITS_TABLE" \
     --filter-expression "attribute_not_exists(registryId) OR registryId = :null" \
     --expression-attribute-values '{":null": {"NULL": true}}' \
     --select COUNT
   ```

   Expected result: `Count: 0`. Non-zero rows must be backfilled via the
   PR 1 migration script before proceeding.

2. **Every `registryId` on an authority unit points to a live registry
   record.** Sample a random subset (≥ 50) of authority units, resolve
   each via `GetRegistryRecord`, and confirm the record exists and is
   not in `DEPRECATED` state.

   A dedicated sampling CLI is not yet shipped. Until it lands, use the
   following ad-hoc invocation of the Python registry client:

   ```python
   # Run from the repo root with .venv activated.
   from arbiter.catalog.registry_client import (
       list_agent_records,
       get_agent_record,
   )
   import random

   registry_id = "<REGISTRY_ID from stack output>"
   units = list_agent_records(registry_id)
   sample = random.sample(units, min(50, len(units)))
   for u in sample:
       rec = get_agent_record(registry_id, u["recordId"])
       assert rec is not None, f"missing {u['recordId']}"
       assert rec["status"] != "DEPRECATED", f"deprecated {u['recordId']}"
   ```

   Record the sample size and failure count in the change ticket.

3. **Every governance-aware agent and tool has a workload-identity
   attribute on its registry record.** The attribute name is `registryId`
   per Decision #9. Listing can be run with `list_agent_records` from the
   Python bridge; see `arbiter/catalog/registry_client.py`.

### Telemetry

4. **`governance-gate-decisions` dashboard shows ≥ 7 days of `shadow` mode
   traffic at a baseline rate.** The dashboard must show non-zero
   evaluations for the full soak window; a flat-line would indicate the
   gate is not being reached.

5. **`workload-identity-mismatch-rate` is below the acceptance threshold
   of 0.5 % over the rolling 24-hour window.** Any single day above 1 %
   during the soak invalidates the window and resets the clock.

6. **`registry-sync-failures` DLQ is empty for ≥ 48 consecutive hours.**
   A non-empty DLQ means registry reads are failing intermittently; flip
   will surface those as user-facing rejections.

### Rollback readiness

7. **`GOVERNANCE_MODE` is controllable via a CloudFormation parameter on
   every governance-aware Lambda.** Confirm via a dry-run stack update
   that changing the parameter rolls only the Lambda configuration, not
   application code.

8. **The `permissive` fallback path has been exercised in a non-prod
   environment within the last 7 days.** A stale fallback path is not a
   rollback path. Include the timestamp and test evidence in the change
   ticket.

### Ownership and communication

9. **On-call runbook entry is updated and the PagerDuty escalation path
   has been verified with a test page.**

10. **The flip is announced to stakeholders at least 48 hours in advance.**
    Include the target mode, the target time window, the expected
    blast radius, and a link to this document. Allow at least one full
    business day for comment.

11. **The change ticket lists the rollback criteria explicitly** — the
    specific metric thresholds that trigger an immediate rollback (see
    [Rollback Procedure](#rollback-procedure)).

## Flip Procedure (Happy Path)

Execute each step in order. Do not skip the soak windows. If any step
produces an unexpected result, abort and consult
[Rollback Procedure](#rollback-procedure).

### Step 1 — Pre-flip snapshot

Take a snapshot of the governance metrics for the 24-hour window
immediately before the flip. The snapshot is the reference point for
anomaly detection during the soak.

Until gate-decision telemetry is shipped, this snapshot is based on the
only governance metric currently emitted — `OffFrontierEscalations` in
the `CitadelGovernance` namespace:

```bash
aws cloudwatch get-metric-statistics \
  --namespace "CitadelGovernance" \
  --metric-name "OffFrontierEscalations" \
  --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 3600 \
  --statistics Sum > pre-flip-snapshot-$(date -u +%Y%m%d-%H%M).json
```

Attach the snapshot file to the change ticket. Once PR 4-follow-up
ships `GovernanceGateDecisions{Mode,Outcome}`, extend this command to
also capture the gate-decision baseline.

### Step 2 — Flip to `shadow`

Update the CloudFormation parameter on every governance-aware Lambda to
set `GOVERNANCE_MODE=shadow`. Redeploy the stack. The deploy is
configuration-only — application code is not rebuilt.

Verify within 5 minutes that `shadow` log entries are appearing:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/<governance-aware-lambda>" \
  --filter-pattern '{ $.governance_mode = "shadow" }' \
  --start-time "$(date -u -v-5M +%s000)"
```

Expected result: a non-zero number of events within the first 5 minutes
after the deploy completes. Zero events within the window means the gate
is not being reached — investigate before proceeding.

### Step 3 — Soak window

Monitor the `workload-identity-mismatch-rate` and
`governance-gate-decisions` dashboards for the soak window. Default
duration: 7 days. Longer is acceptable; shorter requires an explicit
tech-lead sign-off recorded in the change ticket.

**Abort condition:** any single 24-hour window during the soak where the
mismatch rate exceeds 1 %. If the abort condition fires, do not flip to
`strict`. Investigate the root cause, fix the underlying data or config
issue, and restart the soak clock.

Record daily mismatch rates in the change ticket. The soak is complete
when every day's rate is below 0.5 % and the DLQ remained empty.

### Step 4 — Flip to `strict`

Update the CloudFormation parameter to set `GOVERNANCE_MODE=strict`.
Redeploy the stack. Configuration-only deploy; no code change.

Confirm strict decisions are appearing:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/<governance-aware-lambda>" \
  --filter-pattern '{ $.governance_mode = "strict" && $.decision = "DENY" }' \
  --start-time "$(date -u -v-10M +%s000)"
```

Watch the `/dispatch` endpoint error rate for the next 60 minutes. A
small uptick (< 0.1 % above baseline) is expected and reflects the
previously-shadowed mismatches now being enforced. A larger increase
triggers [Rollback Procedure](#rollback-procedure).

### Step 5 — Post-flip soak

Keep on-call active for the first 24 hours after the strict flip. Do not
start unrelated deploys to governance-aware Lambdas during this window.
Keep the rollback path warm: the CloudFormation parameter update to
revert to `permissive` must be executable on the first try without a
stack lock.

At 24 hours, review the dashboards, close the change ticket, and stand
down on-call.

## Rollback Procedure

The rollback procedure is the counter-action to Step 4 of the flip. It
reverts to `permissive` — not `shadow` — because a rollback-class incident
means we do not trust the evaluation path.

### Trigger conditions

Any of the following triggers an immediate rollback:

- Dispatch rejection rate attributable to the governance gate exceeds 1 %
  within the first hour of the strict flip.
- Dispatch rejection rate sustained above 0.5 % for longer than 30
  minutes at any point after the strict flip.
- A critical (SEV-1 or SEV-2) production incident is opened that
  implicates governance-gate behaviour in the impact chain.
- The registry-sync DLQ begins filling and the rate of fill exceeds
  10 messages per minute.

### Rollback steps

1. **Set `GOVERNANCE_MODE=permissive` via CloudFormation parameter.**
   Apply the parameter update across every governance-aware Lambda in the
   affected environment. Use the same parameter-only deploy mechanism as
   the flip. Do not edit Lambda function code directly.

2. **Confirm gate telemetry drops to zero rejections within 2 minutes.**
   Watch the `governance-gate-decisions` dashboard for the `strict /
   DENY` series to flatline. If rejections persist beyond 2 minutes, the
   parameter update did not land — retry the deploy and escalate through
   the on-call chain.

3. **Capture an incident record.** File a SEV-ranked incident ticket
   with a timeline, root-cause hypothesis, and link to the change ticket
   that initiated the flip.

4. **Do not attempt to re-flip until root cause is identified and every
   readiness checklist item is re-verified.** A failed flip is evidence
   that some readiness item was incorrect or stale.

## Observability — What To Watch

### Metrics

Current state (as of PR 4): only one governance metric is emitted.

- `CitadelGovernance/OffFrontierEscalations` — emitted once per
  invocation of the `escalate` tool in
  `arbiter/workerWrapper/tools/escalate.py`, dimensioned by
  `ProjectId`. Watched by the `citadel-offfrontier-escalations-${env}`
  alarm in `backend/lib/arbiter-stack.ts`.

Planned (not yet shipped — tracked as PR 4 follow-up):

- `GovernanceGateDecisions{Mode, Outcome}` — count of gate evaluations,
  to be dimensioned by `Mode` (`permissive` / `shadow` / `strict`) and
  `Outcome` (`ALLOW` / `DENY` / `WARN`). Will be the primary rate
  metric once shipped.
- `WorkloadIdentityMismatchRate` — rolling percentage of evaluations
  with a mismatched or missing workload-identity attribute.
- `RegistrySyncDLQDepth` — depth of the DLQ for registry-sync failures.

Until the planned metrics ship, operators must substitute the log
queries below for rate and data-quality monitoring.

### Log queries

Paste-ready CloudWatch Logs Insights queries for the three most useful
investigation paths during a flip.

**Shadow-mode mismatches (reason breakdown).**

```text
fields @timestamp, reason, registryId, agentId
| filter governance_mode = "shadow" and decision = "WARN"
| stats count() as mismatches by reason
| sort mismatches desc
| limit 20
```

**Strict-mode rejection traces (correlation-id grouped).**

```text
fields @timestamp, correlationId, reason, registryId, agentId
| filter governance_mode = "strict" and decision = "DENY"
| sort @timestamp desc
| limit 100
```

**Authority-unit lookup failures.**

```text
fields @timestamp, registryId, errorType, errorMessage
| filter event = "authority_unit_lookup_failed"
| stats count() as failures by errorType
| sort failures desc
```

### SLOs

- Post-strict-flip dispatch success rate ≥ 99.5 % over a rolling 7-day
  window, measured at the `/dispatch` endpoint.
- Shadow-mode mismatch rate < 0.5 % over a rolling 24-hour window for
  the duration of the soak.
- Registry-sync DLQ depth = 0 for ≥ 48 hours before any mode flip.

## FAQ / Common Pitfalls

**Q: I flipped to `strict` and the dispatch rejection rate jumped above
10 %. What is going on?**

A: Almost always a stale authority unit missing the `registryId`
attribute. Decision #9 renamed `AuthorityUnit.appId` to
`AuthorityUnit.registryId`, and any authority unit that was not migrated
will fail the gate in strict mode. Run item 1 of the
[readiness checklist](#pre-flip-readiness-checklist) — the
`attribute_not_exists(registryId)` scan. If it returns non-zero rows,
roll back to `permissive`, backfill the attribute via the PR 1 migration
script, and restart the shadow soak.

**Q: Shadow mode shows zero evaluations even though traffic is flowing.**

A: Confirm the gate is at position 3 in `arbiter/governance/engine.py`.
A branch that predates PR 2 may still have the gate at position 1, in
which case an earlier gate rejects the request before the workload-
identity gate is reached. Walk the engine position list in the source
and confirm ordering against Decision #6.

**Q: The registry-sync DLQ filled up during the soak. Can I continue to
flip?**

A: No. DLQ growth is a separate incident and must be resolved per the
registry-sync runbook before any further flip. Stay in `shadow` while
the DLQ is drained. Do not flip `strict` with a non-empty DLQ — any
sync lag will manifest as a fail-closed rejection.

**Q: How do I roll back a single Lambda rather than the whole
environment?**

A: Use a per-Lambda CloudFormation parameter override. Each governance-
aware Lambda carries its own `GOVERNANCE_MODE` parameter; changing the
value for one Lambda affects only that function. Do not edit the
function code directly — parameter overrides are the supported rollback
path and preserve the audit trail.

**Q: Can I skip `shadow` and go straight from `permissive` to `strict` in
a lower environment?**

A: In dev and staging, yes, at the operator's discretion. In production,
no — Decision #8 mandates the shadow-first sequence for every production
flip.

**Q: Does the flip affect in-flight dispatches?**

A: The mode is read per-invocation, so a flip affects any dispatch that
begins after the configuration change lands. In-flight dispatches
complete under their original mode. There is no drain window required.

## Governance Scope: Org-Uniform

The governance framework in this system is **organization-uniform**. AuthorityUnits, CaseLaw, ConstitutionalLayers, ProgramReviews, and the GovernanceLedger apply a single ruleset across every organization in the deployment. There is no schema field, resolver logic, or storage dimension that carries an orgId on governance entities.

Organization scoping applies to **resource visibility** (apps, agents, tools, workflows, integrations, datastores, executions) and to the user-org binding itself (Cognito `custom:organization` attribute). It does not apply to the governance evaluation logic.

If you find yourself wanting a per-org governance rule, stop and escalate — this is an architecture decision that requires additions to AuthorityUnit and related tables plus resolver-level scoping across every governance path. Do not add an ad-hoc check inline.

## References

### In-repo references

- [`docs/AGENT_RECORDS.md`](./AGENT_RECORDS.md) — the authoritative
  AgentCore Registry data model, lifecycle state machine, and adapter
  API contracts.
- [`docs/EVENTBRIDGE_CATALOG.md`](./EVENTBRIDGE_CATALOG.md) — governance
  event contracts (`governance.*` source).
- `arbiter/governance/engine.py` — governance engine; the workload-
  identity gate is at position 3.
- `arbiter/catalog/registry_client.py` — Python bridge to the AgentCore
  Registry; `get_agent_record`, `get_source_project_id`,
  `list_agent_records`.
- `backend/src/services/registry-service.ts` — TypeScript registry
  service layer used by the shim resolver and other TypeScript Lambdas.

### Decision record

- Decision #6 — Workload-identity gate at engine position 3, fail-closed
  in strict mode, warn-only in permissive and shadow.
- Decision #8 — Production launch sequence: shadow first, then strict.
- Decision #9 — `AuthorityUnit.appId` → `AuthorityUnit.registryId`
  rename.
