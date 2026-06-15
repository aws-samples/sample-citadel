# Governance UI Guide

A single-stop reference for the twelve pages under `/governance`.
Audience: governance operators, compliance reviewers, and application
owners who interact with the governance console in a browser. If you
are an SRE flipping enforcement modes via CDK or CloudFormation, see
[`docs/GOVERNANCE_ROLLOUT_RUNBOOK.md`](./GOVERNANCE_ROLLOUT_RUNBOOK.md)
instead — that document is the source of truth for the actual mode
flip mechanics. This guide describes how those flips appear in the UI,
how to inspect decisions the engine has made, and how to amend the
configuration that drives them.

> **Last updated:** 2026-05-21.
> **Applies to:** branch `feat/ai-governance-ui` and any release that
> ships the twelve `/governance/*` routes.

## Table of Contents

- [1. Overview](#1-overview)
- [2. Governance modes](#2-governance-modes)
- [3. The Overview page (`/governance`)](#3-the-overview-page-governance)
- [4. Enabling governance for the first time (the rollout flow)](#4-enabling-governance-for-the-first-time-the-rollout-flow)
- [5. The 8 automated readiness checks](#5-the-8-automated-readiness-checks)
- [6. The 3 manual readiness checks](#6-the-3-manual-readiness-checks)
- [7. Page reference](#7-page-reference)
  - [7.1 Ledger (`/governance/ledger`) — everyone](#71-ledger-governanceledger--everyone)
  - [7.2 Reconciler (`/governance/reconciler`) — admin](#72-reconciler-governancereconciler--admin)
  - [7.3 Rollout (`/governance/rollout`) — admin](#73-rollout-governancerollout--admin)
  - [7.4 Mismatch heatmap (`/governance/mismatches`) — admin](#74-mismatch-heatmap-governancemismatches--admin)
  - [7.5 Escalations (`/governance/escalations`) — admin](#75-escalations-governanceescalations--admin)
  - [7.6 Decision flow tracer (`/governance/tracer`) — admin](#76-decision-flow-tracer-governancetracer--admin)
  - [7.7 Authority graph (`/governance/graph`) — admin](#77-authority-graph-governancegraph--admin)
  - [7.8 Constitution (`/governance/constitution`) — admin](#78-constitution-governanceconstitution--admin)
  - [7.9 Case law (`/governance/case-law`) — admin](#79-case-law-governancecase-law--admin)
  - [7.10 D4 retrospective (`/governance/d4`) — admin](#710-d4-retrospective-governanced4--admin)
  - [7.11 IAM trust path (`/governance/iam`) — admin](#711-iam-trust-path-governanceiam--admin)
- [8. Common workflows](#8-common-workflows)
- [9. Permissions and roles](#9-permissions-and-roles)
- [10. FAQ / common pitfalls](#10-faq--common-pitfalls)
- [11. References](#11-references)

## 1. Overview

Governance in this system is the enforcement layer that decides
whether a given agent-to-agent or agent-to-tool action is allowed.
Every decision is grounded in four kinds of configuration:

- **Authority units.** Each authority unit declares that an agent (or
  group of agents) is permitted to act over a particular scope — for
  example, "agent X may invoke tools in datastore D". An action that
  no authority unit covers is denied.
- **Composition contracts.** When two or more authority units cover
  the same action, the composition contract resolves the contention
  (tightest scope wins, additive permits, exclusive locks, and so on).
- **Constitutional rules.** Layered invariants — global, per-domain,
  and pairwise — that override authority decisions. A constitutional
  rule can convert what would be a permit into a deny when a
  high-level policy is violated, regardless of what the authority
  units say.
- **Case-law precedents.** Operator-encoded resolutions of past
  ambiguous situations. Higher-precedence precedents take effect
  before authority discovery runs, providing a deterministic answer
  for known patterns.

The UI gives you visibility into every decision the engine makes, the
reasoning that produced it, and the configuration that drove the
reasoning. Admins additionally get controls to roll out and roll back
enforcement and to amend the configuration directly in the browser.

Anyone with at least viewer access to `/governance` can read this
guide profitably. A few sections describe admin-only actions; those
are clearly marked. If you are not an admin, you can still read those
sections to understand what your platform team is doing — you just
cannot perform the actions yourself.

## 2. Governance modes

The governance engine operates in one of three modes, set globally
per environment. The current mode is shown in the **ModeBadge** in
the header of every governance page.

- **`permissive`** *(default)*. The engine evaluates nothing. Agents
  act freely. A telemetry-only signal is emitted so you can still see
  the shape of agent traffic, but no decisions are made and nothing
  is logged to the ledger. You will see this mode at first deploy,
  during a rollback, and any time you intentionally park enforcement.
  The badge renders in a muted neutral color.
- **`shadow`**. The engine evaluates every decision and records the
  outcome in the ledger as a `warn` finding, but it does **not**
  block the action. This is the safe-soak state. You inspect the
  would-have-been decisions during a soak period — typically seven
  days — to confirm the rules behave as intended before turning on
  enforcement. The badge renders amber.
- **`strict`**. The engine enforces decisions fail-closed. A `deny`
  blocks the action. A `permit` allows it. A constitutional override
  on top of a permit converts to a deny. This is the production
  state. The badge renders green.

The mode is controlled by the `GOVERNANCE_MODE` SSM parameter. When
an SRE flips that parameter via CDK or the console, every governance
Lambda picks up the new value within roughly thirty seconds and the
ModeBadge updates on the next page load. This guide describes how to
**monitor** the flip from the UI; the runbook describes how the flip
is actually performed and is the source of truth for the mechanics.

## 3. The Overview page (`/governance`)

`/governance` is the landing page. Every authenticated user — viewer
or admin — can see it.

Three status cards run across the top of the page.

- **Current Mode.** Shows the active mode, the timestamp at which the
  current mode became effective, and the environment name. If the
  effective time is recent (within the last hour) the card shows a
  small "recently flipped" indicator so you know the system has just
  changed state.
- **24h Ledger Pulse.** Counts of `permit`, `deny`, and `escalate`
  decisions in the last twenty-four hours. In `permissive` mode the
  counts are all zero; in `shadow` mode they reflect would-have-been
  decisions; in `strict` mode they reflect actual enforcement. The
  card links straight into the Ledger filtered to the same window.
- **Reconciler.** *(admin-only.)* Drift between the registry and the
  ledger, broken down into in-sync, missing, stale, and orphan
  counts. A non-zero "missing" or "orphan" value here is your earliest
  signal that registry sync has degraded.

Between the status row and the tools grid there is a contextual
call-to-action card. It appears only when you are an admin **and**
the current mode is not `strict`. It promotes the rollout wizard as
the recommended next step — for example, "Governance is in shadow
mode. Start the readiness check to flip to strict." When the
environment is fully enforced (mode is `strict`) the card is hidden
because no rollout work remains to be done.

Below that is the **Tools & Views** grid, an icon tile per page.
Some tiles are admin-only and are simply not rendered for viewers,
which keeps the grid tidy regardless of role. The Ledger tile is
always shown — every authenticated user can browse the ledger.

## 4. Enabling governance for the first time (the rollout flow)

The first time you turn governance on in an environment, drive the
flip from `/governance/rollout`. The page walks you through eleven
readiness checks across four categories — data integrity, telemetry,
rollback readiness, and ownership — and gates the actual mode flip
behind all of them being green.

Walk through it in this order:

1. From the Overview page, click **Start rollout readiness**, or
   open `/governance/rollout` directly. Either entry point lands you
   on the same wizard.
2. Review the readiness checklist. Eleven checks total: eight
   automated, three manual. Each check shows its current status,
   when it last computed, and a link to the underlying source
   (CloudWatch metric, DynamoDB scan, SSM parameter, and so on).
3. The eight automated checks compute live status when you load the
   page and re-compute on demand when you click their refresh
   icons. Each shows one of `PASS`, `FAIL`, `WARN`, or `UNKNOWN`,
   along with concrete remediation steps when the status is anything
   other than `PASS`.
4. The three manual checks require operator attestation. Each one
   tells you exactly what to verify and where the evidence lives.
   When you have confirmed the criterion, click **Mark verified** on
   the check. The check stores your username, the timestamp, and an
   expiry date.
5. Once all eleven checks are green, the **Flip to shadow** control
   at the bottom of the page is enabled. Click it, confirm the
   dialog, and the SSM parameter is updated. The new mode is live
   in roughly thirty seconds; the ModeBadge updates as soon as the
   next page load picks it up.
6. Soak in `shadow` mode for at least seven days. During the soak,
   watch the Mismatch heatmap (Section 7.4) and the Escalations
   page (Section 7.5). The goal of the soak is to confirm that the
   rules behave as you expect on real traffic before they actually
   block anything.
7. When the soak is clean — no unexplained denial patterns, no
   escalation spikes — return to `/governance/rollout` and click
   **Flip to strict**. The same SSM parameter update happens; the
   ModeBadge transitions from amber to green.
8. Watch the post-flip soak window for the next twenty-four hours.
   Rollback is one click away on the same page (**Rollback to
   permissive**). If anything looks wrong, roll back without
   hesitation and investigate from the ledger.

The audit log at the bottom of the rollout page records every
verification, every mode flip, and every rollback, with operator
identity and timestamp. Admin mutations everywhere in the UI also
emit an EventBridge event for downstream auditing — see Section 9.

## 5. The 8 automated readiness checks

Each automated check has an ID, a one-line statement of what it
verifies, a method that explains how it computes, and an explicit
"what FAIL means" so you can act on a non-PASS result without
needing to ask the platform team.

- **`data-1` — Authority units have registry IDs.** Verifies that
  every active `AuthorityUnit` in DynamoDB has a non-null
  `registryId` field. Computes via a live scan of the authority
  units table. **FAIL** means at least one authority unit was
  written before registry-backed governance landed; remediate by
  running the back-fill script under
  `backend/scripts/reconcile-apps-meta.ts` (or the equivalent for
  authority units) before flipping out of `permissive`.

- **`data-2` — Registry IDs resolve.** Verifies that every
  `registryId` referenced by an authority unit points to a live
  record in the AgentCore Registry. Sample-resolves up to fifty
  units against the registry. **FAIL** means a registry record was
  deleted but the authority-unit row still references it; remediate
  by either re-creating the registry record or deleting the stale
  authority unit.

- **`data-3` — Workload-identity attribute present.** Verifies that
  every governance-aware agent and tool has a `workloadIdentity`
  attribute set on its registry record. Resolves a sample of agents
  and tools against the registry and confirms the attribute is
  present and non-empty. **FAIL** means at least one agent or tool
  is missing the identity attribute; the engine cannot enforce
  identity-bound rules without it. Remediate by re-running the
  registration step that populates the attribute.

- **`tel-1` — Shadow traffic spans ≥7 days.** Verifies that the
  governance ledger contains at least one finding from at least
  seven days ago. Scans the ledger for the oldest finding within a
  thirty-day window. **FAIL** means you have not soaked in `shadow`
  long enough. Remediate by waiting — there is no shortcut. If you
  are confident the soak is unnecessary (for example, in a brand
  new environment with no live traffic) document the exception in
  your change ticket and proceed with operator concurrence.

- **`tel-2` — Workload-identity-mismatch rate is healthy.**
  Verifies that less than 0.5% of decisions in the last twenty-four
  hours are `decision=deny` due to a workload-identity mismatch.
  Computes via two paginated `COUNT` scans on the ledger — one for
  total findings, one for findings with `decision=deny`. **FAIL**
  means agent identity is misconfigured at scale; flipping to
  `strict` would cause a wave of denials. Remediate by chasing the
  mismatched identities (the Ledger pre-filtered to
  `reason=workload_identity_mismatch` will show you which agents
  are affected).

- **`tel-3` — Registry-sync DLQ empty.** Verifies that the
  `registry-sync-failures` DLQ has been empty for at least
  forty-eight hours. Reads the corresponding CloudWatch metric over
  a forty-eight-hour window. **FAIL** means registry writes have
  been failing intermittently. Remediate by draining the DLQ and
  fixing the underlying sync error before continuing.

- **`rb-1` — Mode is controllable via SSM.** Verifies that the
  `GOVERNANCE_MODE` SSM parameter exists and currently holds one of
  the three recognised values (`permissive`, `shadow`, `strict`).
  **FAIL** means the parameter is missing or holds an unexpected
  value; remediate via the runbook step that creates the parameter.

- **`rb-2` — Permissive fallback exercised in non-prod.** Verifies
  that within the last seven days you have, in at least one
  non-prod environment, transitioned the SSM parameter into
  `permissive`. Walks the SSM parameter history. **FAIL** means
  rollback has not been rehearsed recently. Remediate by performing
  a rehearsal flip in dev/staging — flip to `permissive`, confirm
  the engine stops evaluating, then flip back. The check picks up
  the rehearsal automatically on the next refresh.

## 6. The 3 manual readiness checks

The three manual checks cover the things the engine genuinely
cannot determine for itself — whether a human is on call, whether
stakeholders have been told, and whether the change ticket is
complete.

- **`own-1` — PagerDuty rotation active.** What to verify: there is
  an active on-call rotation in PagerDuty for the
  `governance-escalations` schedule. Where: PagerDuty schedules.
  After confirmation, click **Mark verified** to attest. The
  attestation captures your identity and the timestamp.

- **`own-2` — Stakeholders informed.** What to verify: the flip has
  been announced to stakeholders at least forty-eight hours in
  advance, per the announcement template in
  [`docs/GOVERNANCE_ROLLOUT_RUNBOOK.md`](./GOVERNANCE_ROLLOUT_RUNBOOK.md).
  Where: your ChatOps channel, mailing list, or change-management
  system, depending on which the runbook directs you to. Click
  **Mark verified** to attest.

- **`own-3` — Change ticket has rollback criteria.** What to
  verify: the change ticket associated with this flip lists the
  specific trigger conditions that would justify a rollback (e.g.
  "deny rate above 5%"), names an on-call owner, and includes a
  comms plan. Where: your change-management system. Click **Mark
  verified** to attest.

You choose the verification expiry when you mark a check verified —
between seven and thirty days. Re-verify before expiry to refresh
the window. Verifications are immutable: you cannot un-verify a
check, only let it expire. If you click **Mark verified** by
mistake, the easiest remedy is to wait it out (the default expiry is
seven days). For urgent corrections, ask platform-ops to remove the
underlying SSM parameter that backs the verification — see Section
10 for the FAQ entry on this.

## 7. Page reference

This section gives one short reference per governance page. For each
page you get four things: who can see it, what it is for, the key UI
elements you will encounter, and the common workflows that bring you
to it.

### 7.1 Ledger (`/governance/ledger`) — everyone

**Purpose.** Browse every governance finding the engine has emitted,
filtered however you need.

**Key UI.** A table of findings keyed by timestamp, with columns for
decision (`permit`, `deny`, `escalate`, `warn`), workflow ID,
subject (the agent and tool), and reason tokens. Filters across the
top let you narrow by decision, workflow ID, time window, and reason
token. A pagination bar at the bottom lets you walk back further in
history.

Click any row to open a side drawer with the full decision trace:
the eight pipeline steps the engine ran, the authority units it
considered, the rules it applied, and the reason tokens it produced.
Reason tokens are stable identifiers (`workload_identity_mismatch`,
`covering_unit_not_found`, `constitutional_override:layer-global`,
and so on) that you can pin to filters or feed into other tools.

**Common workflows.**

- Investigating a specific denial. Filter to the workflow ID, click
  the finding, read the trace.
- Auditing a recent window. Set the time filter, page through, look
  for unexpected patterns.
- Following a reason. Filter on the reason token to see every place
  that reason has fired.

### 7.2 Reconciler (`/governance/reconciler`) — admin

**Purpose.** Detect drift between the AgentCore Registry and the
governance ledger.

**Key UI.** Four classification cards across the top:

- **In-sync.** Records that exist in both registry and ledger, with
  matching state.
- **Missing.** Records that exist in the registry but have no
  ledger activity in the configured window.
- **Stale.** Records whose registry version is older than the
  ledger expects.
- **Orphan.** Records that have ledger rows but no longer exist in
  the registry.

A drift-over-time chart underneath the cards shows the last
twenty-four hours of each classification, so you can see trends as
well as totals.

**Common workflows.**

- Detecting failed ledger writes (orphan grows). Drill into the
  orphan cohort, read the timestamps, correlate with deploys.
- Detecting failed registry deletes (stale grows). Drill into the
  stale cohort, confirm the registry record is gone, then expire
  the ledger row.

### 7.3 Rollout (`/governance/rollout`) — admin

**Purpose.** Run the readiness checklist and perform the actual mode
flip from the browser.

The full walkthrough is in Section 4. The page has two parts that
are worth flagging here: the **readiness panel** (the eleven checks
described in Sections 5 and 6) and the **audit log** at the bottom
of the page. Every verification, every flip, and every rollback is
recorded in the audit log with operator identity, timestamp, and the
SSM parameter value that was set. The audit log is also exported to
the central governance audit table — see Section 9 — but the
copy on this page is the most convenient for after-action review.

**Common workflows.**

- First-time enablement. See Section 4.
- Rolling back to permissive. Click **Rollback to permissive**,
  confirm the dialog. Then read the runbook entry on rollback for
  the post-rollback hygiene steps (notification, ticket update,
  cause investigation).

### 7.4 Mismatch heatmap (`/governance/mismatches`) — admin

**Purpose.** Spot problematic hours and reason patterns during the
shadow soak.

**Key UI.** A 7-day × 24-hour grid. Each cell counts the `warn`
decisions during that hour-of-day across the seven-day window.
Hotter cells are darker. Hover a cell for a popover that lists the
top `(workflow_id, reason)` tuples that contributed to its count;
click the cell to open the Ledger pre-filtered to the same hour.

**Common workflows.**

- Ad-hoc soak inspection. Scan for hot rows (problematic times of
  day) and hot columns (problematic days). A hot column on a deploy
  day is a strong signal that a recent change introduced a regression.
- Reason-pattern hunting. Hover the hot cells, look at the popover
  tuples — if one reason dominates, that is your next investigation.

### 7.5 Escalations (`/governance/escalations`) — admin

**Purpose.** Triage off-frontier escalation alarm fires.

**Key UI.** A list of every fire of the
`OffFrontierEscalations` alarm, dimensioned by project. Each row
shows the project name, the time of the fire, and a count of the
underlying findings. Each row expands into an accordion drill-down
listing the findings; clicking any finding opens it in the Ledger.

**Common workflows.**

- "OffFrontierEscalations alarm fired in production." Open this
  page, expand the most recent fire for the affected project, click
  the findings to drill into the ledger, work the cause from there.
- Investigating a chronic project. Sort by project, look at the
  pattern of fires over time.

### 7.6 Decision flow tracer (`/governance/tracer`) — admin

**Purpose.** Understand exactly why a particular decision happened,
and explore "what if" alternatives.

**Key UI.** An animated 8-step pipeline canvas. Each node is a stage
of the decision: case-law lookup, covering-unit discovery, residual
denial, tightest-scope selection, composition arbitration,
single-domain permit, constitutional review, and final outcome. As a
finding plays through, each node lights up with the data the engine
considered at that step.

Two specialised controls accompany the canvas:

- **Time-machine scrubber.** Replays the last sixty seconds of
  findings as they happened. Use this to "see" live traffic
  decompose into stages.
- **Counterfactual evaluator** (*Edit and re-evaluate*). Lets you
  edit the request — change the agent, the tool, the parameters —
  and replays it client-side without a backend round-trip. The
  resulting verdict is computed from the same engine logic as
  production, just against your edited input. Use this to answer
  "would this have been allowed if X?" without having to mock up
  traffic in shadow.

**Common workflows.**

- Debugging a specific decision. Open it from the Ledger, watch the
  pipeline animate, identify the stage that produced the verdict.
- Hypothetical exploration. Click **Edit and re-evaluate**, change
  one field at a time, watch the verdict change. Useful before
  proposing a configuration amendment.

### 7.7 Authority graph (`/governance/graph`) — admin

**Purpose.** Visualise the authority topology and run impact
analysis before changing it.

**Key UI.** A force-directed graph with four node shapes:

- **Squares** are agents.
- **Circles** are authority units.
- **Diamonds** are composition contracts.
- **Triangles** are constitutional layers.

Edges show "delegates to", "covered by", "compounds with", and
"governed by" relationships, and are styled to make the kind clear.
The graph supports zoom, pan, and node search by name.

Two modes are particularly useful:

- **Blast-radius mode.** Click any authority unit, then enable the
  mode. The graph dims, and every dispatch path that would be
  denied if the selected unit were revoked is highlighted. Run this
  before any revoke — even a small unit can have surprisingly broad
  reach when other units depend on it for composition.
- **Time-scrubber.** Replays delegation changes over a selectable
  window. Use this to see how the topology has evolved — useful
  when the current shape does not match your mental model.

**Common workflows.**

- Pre-revoke impact analysis. Click the unit, enable blast-radius,
  inspect the highlighted paths, decide whether the affected agents
  have alternative authority. Only then proceed.
- Topology audit. Walk the graph, look for orphan circles
  (authority units no agent uses) or dense diamonds (overloaded
  composition contracts).

### 7.8 Constitution (`/governance/constitution`) — admin

**Purpose.** Read and amend the constitutional rules that override
authority decisions.

**Key UI.** A tree per `ConstitutionalLayer`, with the global layer
at the top, domain layers below it, and pairwise layers (specific
agent ↔ tool combinations) at the leaves. Each rule is rendered as
`field operator expected` — for example,
`request.action eq "delete-database"`.

Hover any rule for a sparkline of override count over the last seven
days, so you can see at a glance whether a rule is firing in
practice. A rule that has never fired is either dead code or
defensively necessary; either way the sparkline gives you the data
to decide.

Admin actions on the page:

- **Add rule.** Opens a form with the layer pre-filled. The form
  validates the rule against the engine's six supported operators
  (`eq`, `neq`, `in`, `not_in`, `lt_eq`, `gt_eq`). You cannot
  author a rule with an `Unknown` operator — the form rejects
  it before submit.
- **Edit rule.** Opens the same form pre-populated with the
  existing rule. The same operator validation applies.
- **Delete rule.** Soft-deletes the rule; the rule is preserved in
  history for audit but is no longer evaluated.

**Common workflows.**

- Amending a rule. Find it in the tree, hover for the override
  sparkline as a sanity check (a rule with high override volume
  needs more thought before changing), click **Edit**, adjust the
  expected value, save.
- Sweeping for dead rules. Sort the tree by override count, ask
  whether the always-zero rules are still needed.

### 7.9 Case law (`/governance/case-law`) — admin

**Purpose.** Read and amend the case-law precedents that pre-empt
authority discovery.

**Key UI.** A vertical timeline sorted by precedence — highest
precedence at the top, lowest at the bottom. Each entry shows:

- The **pattern dictionary** that triggers the precedent (a
  selection of request fields and expected values).
- The **resolution** (`permit`, `deny`, or `escalate`).
- The operator who **encoded** it, and when.
- The **scope of applicability** — global, domain, or pairwise.

Admin actions on the page:

- **Revoke.** Soft-deletes the precedent. Use this when an
  encoded precedent is no longer wanted; the precedent is
  preserved in history for audit but is no longer matched.
- **Unrevoke.** Restores a previously-revoked precedent.
- **Update precedence inline.** Drag rows up or down, or edit the
  precedence number directly, to change the matching order.

**Common workflows.**

- Quieting a noisy escalation. If a known-safe pattern is producing
  escalations, encode a precedent that resolves it as `permit` at
  the appropriate scope, and watch the ledger to confirm the
  escalations stop.
- Precedence reordering. When two precedents could both match the
  same request, the higher-precedence one wins. Reorder them here.

### 7.10 D4 retrospective (`/governance/d4`) — admin

**Purpose.** Decide whether the project's two defense-in-depth deny
scopes (worker-pre-filter and worker-tool-handler) are both pulling
their weight, or whether one is redundant.

**Key UI.** A Venn diagram of the two `DENY` scopes over a
configurable window. The left circle is denials that fired in the
worker-pre-filter; the right circle is denials that fired in the
worker-tool-handler. The intersection is denials that both layers
caught. The window slider above the Venn drives the underlying
query — narrow it for a focused look, widen it for trend.

A recommendation card next to the Venn flips in real-time as you
move the slider. The four possible recommendations are:

- **`keep-both`** — typical case, both layers have unique catches.
- **`re-debate`** — one layer has zero unique catches in the window,
  worth re-opening the architectural debate.
- **`keep-both-strong-evidence`** — overwhelming overlap with
  unique catches in both layers; both are necessary.
- **`deferred-90d`** — not enough data; revisit in 90 days.

Click any slice of the Venn to list the `(workflow_id, reason)`
tuples that contributed to it.

**Common workflows.**

- Quarterly defense-in-depth review. Open the page, set the slider
  to 90 days, read the recommendation, click into the unique
  catches to confirm the engine's verdict.
- Targeted investigation. Click the intersection slice to see
  cases where both layers caught a denial — useful for confirming
  redundancy is intentional rather than accidental.

### 7.11 IAM trust path (`/governance/iam`) — admin

**Purpose.** Visualise the IAM chain that vends scoped credentials
to the agent runtime, and detect drift in the underlying roles.

**Key UI.** A two-hop assume chain rendered as a directed graph:

```
Lambda exec role → cross-account role → scoped role → target service
```

For any selected resource (agent, datastore, integration), each
edge in the chain shows a policy summary — the actions and
resources granted at that hop. Click an edge to expand it into the
full IAM policy JSON.

A **drift-detector overlay** flags roles whose inline policy
actions are a *superset* of what `requiredPolicies()` declares for
that resource. A superset means the role grants more than the
declared contract requires, which usually means the role is stale
(declared permissions were tightened, but the role wasn't updated)
and is a security hygiene issue worth fixing.

**Common workflows.**

- Pre-deploy verification. Pick the resource you are about to
  change, walk the chain, confirm the policies are what you
  expect.
- Drift remediation. Run the drift detector, work the flagged
  roles in priority order (most over-granted first), tighten the
  inline policies to match `requiredPolicies()`.

## 8. Common workflows

These end-to-end scenarios chain together pages from Section 7. Use
them as recipes for common operator tasks.

- **"I want to enable governance for the first time."** Section 4
  is the full walkthrough. The TL;DR: open `/governance/rollout`,
  green every check, click **Flip to shadow**, soak seven days,
  click **Flip to strict**, watch for twenty-four hours.

- **"I see an unexpected denial."** Filter the Ledger
  (`/governance/ledger`) to the affected workflow ID. Click the
  finding to see the eight-step trace in the side drawer. If you
  need to explore why each stage produced what it did, open the
  same finding in the Tracer (`/governance/tracer`) and watch the
  pipeline animate.

- **"The OffFrontierEscalations alarm fired in production."** Go
  to `/governance/escalations`. Find the matching project. Expand
  the accordion. Click into the underlying findings, which take
  you to the Ledger pre-filtered to that workflow.

- **"I see an unexpected denial pattern in shadow mode."** Open
  `/governance/mismatches`. Hover the hot cells in the heatmap to
  see the dominant `(workflow_id, reason)` tuples. Click a cell to
  open the Ledger pre-filtered to that hour, and work from there.

- **"I need to revoke an authority unit."** Open
  `/governance/graph`, click the unit, enable **Blast-radius
  mode**. Inspect every dispatch path that would be denied by the
  revoke. Confirm the affected agents have alternative authority.
  Only then perform the revoke (the second tap on the unit is the
  revoke action — the page links to the API for the actual write).

- **"I need to roll back governance."** Open
  `/governance/rollout` and click **Rollback to permissive**. The
  flip is one click; the runbook describes the post-rollback
  hygiene (notify stakeholders, update the change ticket, capture
  cause for the post-mortem).

- **"I want to amend a constitutional rule."** Open
  `/governance/constitution`, navigate to the layer, hover the
  rule for the override sparkline as a sanity check, click **Edit
  rule**, change the expected value. The form validates against
  the six supported operators before submit.

- **"I want to verify a decision would have changed under
  different conditions."** Open `/governance/tracer`, select the
  finding, click **Edit and re-evaluate**, change the field you
  want to test, watch the verdict update. No backend round-trip
  is required; the engine logic runs client-side against your
  edited input.

## 9. Permissions and roles

The governance UI authenticates against the project Cognito user
pool. Every authenticated user is in one of two effective groups:

- **viewer.** Can see `/governance` (Section 3) and
  `/governance/ledger` (Section 7.1). All other governance pages
  are not rendered for viewers — they do not appear in the tools
  grid, and direct navigation to them returns a "not authorised"
  page.
- **admin.** Can see all twelve pages and can perform mutations:
  `setGovernanceMode`, `addConstitutionalRule`,
  `editConstitutionalRule`, `deleteConstitutionalRule`,
  `revokeCaseLaw`, `unrevokeCaseLaw`, `updateCaseLawPrecedence`,
  `markReadinessCheckVerified`, and a few more. The full mutation
  list lives in the GraphQL schema next to the resolver
  implementations.

Every admin mutation is logged to the **governance audit table**
in DynamoDB with operator identity, timestamp, request payload,
and resulting state. The same mutation also emits an EventBridge
event on the governance event bus (`citadel-governance-${env}`),
which downstream consumers (SIEM, ChatOps, change-management
integrations) can subscribe to.

For the underlying RBAC model — including how Cognito groups map
to GraphQL operations and IAM policies — see
[`docs/AGENT_PERMISSIONS.md`](./AGENT_PERMISSIONS.md).

## 10. FAQ / common pitfalls

**My readiness check shows `UNKNOWN`.** This means the resolver
Lambda for that check could not reach its data source. Check the
resolver Lambda's CloudWatch logs for the underlying error — the
most common causes are throttling on the registry, a transient
DynamoDB error, or a missing IAM permission. Refresh the check
once the underlying issue is resolved.

**Shadow mode shows zero findings, even though I expect traffic.**
First confirm the engine is actually in shadow — the ModeBadge in
the header is the source of truth, not the SSM parameter alone (a
flip can take ~30 seconds to propagate). Then confirm there is
real traffic for the configured agents — `permissive` mode emits
traffic-shape telemetry; you can use `/governance/ledger` filters
or your CloudWatch dashboards to verify traffic exists. If both
of those check out and you still see zero findings, the gate
itself may be misconfigured; check the gate Lambda's logs.

**I marked a check verified but it's still showing `STUB`.**
Verifications cache for thirty seconds before the page rereads
them. Wait, then refresh. If the status is still wrong after a
minute, your verification did not persist — open the browser
devtools network tab, replay the call, and read the response.

**The reconciler shows `orphan` rows.** The ledger has rows for
agents that no longer exist in the registry. This usually means
that a registry deletion succeeded but the corresponding ledger
row never expired. Drill into the orphan cohort, confirm the
agent is genuinely gone, then either expire the ledger row
manually or wait for the natural expiry (typically thirty days).
If orphans grow steadily over time, the expiry job may be broken
— page the platform team.

**I clicked `Mark verified` by accident.** Verifications are
immutable by design — there is no un-verify button. The cleanest
remedy is to wait for the verification to expire (default seven
days) and then verify it again properly when you are ready. For
urgent corrections (you accidentally verified something that is
wrong, and you cannot wait), ask platform-ops to remove the
underlying SSM parameter that backs the verification record. They
have a documented procedure for this in their internal ops wiki.

**The mode flip control is enabled, but I'm not sure I should
press it.** The control is enabled when every readiness check is
green. That is necessary but not sufficient — your judgment is
still required. Re-read the most recent ledger findings, glance
at the Mismatch heatmap, confirm there are no in-progress
incidents, and only then proceed. If in doubt, defer to a more
experienced operator or page the on-call.

**The blast-radius preview on the authority graph shows fewer
paths than I expected.** The preview only includes paths that are
reachable from currently-active authority units. If the unit you
are about to revoke is referenced by a *suspended* downstream
unit, that path will not be highlighted. Inspect the graph
manually for any suspended authority before you revoke.

**I see two case-law precedents that look like they should both
match the same request.** Higher precedence wins. The Case-law
page is sorted with the highest precedence at the top of the
timeline; that is the one that will fire. If the lower-precedence
one is the one you actually want to win, drag the rows to
reorder, or edit the precedence number directly.

## 11. References

In-repo references and adjacent documentation:

- [`docs/GOVERNANCE_ROLLOUT_RUNBOOK.md`](./GOVERNANCE_ROLLOUT_RUNBOOK.md)
  — SRE-facing runbook for the actual mode flips via CDK and SSM,
  including the canonical *Mode Semantics (Decision #6)* section.
  This UI guide assumes you have read at least that section.
- [`docs/AGENT_PERMISSIONS.md`](./AGENT_PERMISSIONS.md) — the RBAC
  model that underlies viewer vs admin in the governance UI, and
  the credential vending pipeline that the IAM trust path page
  visualises.
- [`docs/AGENT_RECORDS.md`](./AGENT_RECORDS.md) — developer-focused
  reference for the `RegistryAgentRecord` schema, including the
  workload-identity attribute checked by readiness check `data-3`.
- [`docs/POLICY_MANAGER.md`](./POLICY_MANAGER.md) — the IAM
  credential vending subsystem behind the trust-path chain, with
  the canonical definition of `requiredPolicies()` used by the
  drift detector.
