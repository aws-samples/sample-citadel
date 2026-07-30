# Observability — Waterfall Trace Viewer

User-facing guide to the waterfall trace viewer added in architect task
`60ba09e4` (backend pass in `2c89844`, frontend pass in this change). For the
underlying trace-propagation contract, authorization matrix, and residual-risk
statement, see `docs/TRACING_RUNBOOK.md`.

## What it is

A one-click waterfall view of the X-Ray spans behind a workflow execution or
an agent conversation: nested span tree, per-span durations drawn as
proportional bars, and fault/error/throttle badges — so you can see exactly
where time went and where something failed, without leaving the app.

## Opening a trace

There is no separate "search for a trace" step for normal use — the viewer is
reached by clicking **View trace**:

- From an execution's detail sheet (Agent Apps → an app → Executions tab →
  open an execution) — opens the trace for that execution.
- From a project's conversation view (the chat header, next to the document
  panel toggle) — opens the trace(s) linked to that conversation.

Both deep links land on `/observability/trace/:kind/:id`, which resolves the
execution or conversation to your organization and fetches the matching
X-Ray trace(s). Non-admin users can only open traces for executions and
conversations owned by their own organization (server-enforced 403
otherwise — see the authorization matrix in `docs/TRACING_RUNBOOK.md`).

## Reading the waterfall

- Each **trace block** is one X-Ray trace (there can be more than one per
  execution/conversation — one Lambda/worker hop can produce its own trace).
- Rows are **spans**, indented by nesting depth, with a collapsible chevron
  when a span has children.
- The horizontal bar's position and width are proportional to the span's
  start offset and duration within its trace — read left-to-right against
  the duration ruler at the top of each trace block.
- A `fault`, `error`, or `throttle` badge appears on the trace header and/or
  the individual span, in that precedence order.

## Honest states

The viewer never fakes data. If a trace can't be shown, you'll see one of:

- **Loading** — fetching in progress.
- **Indexing** — X-Ray hasn't finished indexing the trace yet (typically
  resolves within ~90 seconds of the execution/conversation completing); the
  page auto-retries once and offers a manual retry.
- **Empty** — no trace was recorded (a sampling miss, or the flow's tracing
  hasn't been stitched yet).
- **Not authorized** — you don't have access to this execution/conversation's
  trace (cross-org, or you tried the admin-only raw trace-id route without
  admin rights).
- **Unavailable** — the trace API isn't configured for this deployment.

## Admin: raw trace-id lookup

Administrators additionally see an **Observability** entry in the sidebar
with a **Raw trace ID (admin)** sub-entry, and a raw-trace-id input directly
on the Observability page. A raw X-Ray trace id has no organization it can be
checked against (unlike an execution or conversation id), so looking one up
directly is restricted to admins — this is the same reasoning used for other
account-wide reads in the governance UI.

## Execution replay package (CIT-026)

A "Download replay package" button appears next to "View trace" on
execution inspection, and above the waterfall for execution/conversation
deep links (never for the raw trace-id kind — a replay package always needs
an ownership entry key). Unlike the raw trace-id lookup above, replay
package download is **not** admin-only — every member of the owning org can
download it, since ownership is resolved the same way as
`by-execution`/`by-conversation`. See `docs/REPLAY_PACKAGE.md` for the full
envelope contract, the sanitisation/fail-closed-gate guarantee, and the
eval-ingestion contract.

## Configuration note: `aws_cost_api_url` reuse

The trace query routes (`/traces/by-execution/{id}`, `/traces/by-conversation/{id}`,
`/traces/{traceId}`) were added to the **same** API Gateway HTTP API that
already serves the cost dashboards (`TelemetryStack`'s `costHttpApi`), behind
the same Cognito JWT authorizer and CORS configuration. The frontend
`traceService` therefore reads the **same** configuration key the cost
service already uses — `serverService.getConfig()?.costApiUrl` (surfaced to
the frontend as `aws_cost_api_url`) — rather than introducing a new config
key or a new CDK output. If `aws_cost_api_url` isn't configured for a given
deployment, both the cost dashboards and the trace viewer report themselves
as unavailable with zero network calls.

This means `aws_cost_api_url` is a slight misnomer now that it also serves
tracing — a documented tradeoff, with an optional future rename to
`aws_telemetry_api_url` tracked as tech debt, not addressed in this change.

## Decision <-> runtime trace linking

Two one-click links between a governance decision and the runtime trace it
was made inside of (architect task `9b3f4f78`). Full contract in
`.kiro/specs/governance-ui/graphql-contract.md`; this section is the
user-facing summary.

**From a governance finding -> "what actually ran"** (Governance ->
Tracer): the finding header shows a **View runtime trace** action.

- If the finding carries a stamped `traceId` (X-Ray trace id captured at
  the moment the finding was written) and you're an admin, it deep-links
  straight to `/observability/trace/traceId/<id>` — the same admin-only raw
  trace-id route described above.
- If you're not an admin, the `traceId` is shown as a copyable string
  instead (trace data is account-wide, so the raw-id route can't be
  ownership-checked for anyone) with a note explaining why, plus a
  **View execution trace** fallback using the finding's `workflowId`
  through the ownership-gated by-execution route.
- If the finding predates this feature (the ledger is write-once — old
  rows can never be retro-stamped), the primary button is disabled with a
  tooltip saying so, and the same `workflowId` fallback is offered.
- If the trace API isn't configured for this deployment, the link is
  hidden entirely rather than shown broken.

**From a runtime trace -> "why was this allowed?"** (Tracer ->
Governance): the waterfall page shows a **Governance decisions (N)** panel
below the trace, populated from the loaded trace's `execution_id`
annotation (falling back to `correlation_id`). N=0 renders as "No
governance decisions recorded for this execution" — true whether none were
written or the execution ran ungoverned. A missing annotation renders
"Execution id unavailable on this trace — cannot look up governance
decisions" instead of attempting a lookup. A query failure renders inline
without breaking the waterfall.

**Known limitation (read before treating the fallback/panel as
authoritative):** the fallback/panel above both key off `workflowId` /
`execution_id`, which for supervisor-dispatched governance findings today is
the supervisor's own `orchestrationId` — a separate identifier from the
StepRunner `executionId` used by runtime traces. They are not guaranteed to
be the same value. The `traceId` primary link does not have this problem
(it's the trace the finding was actually written inside), but the
`workflowId`-keyed fallback and the runtime→decision panel may legitimately
come back empty/not-found even for a governed execution. Treat a hit as
signal, not an absence of a hit as proof nothing was governed.

**BOUNDED SCAN as of Pass 2 (design §4, decision f1cbd5ef) — runId pivot:**
`getDecisionTrace` additionally surfaces `finding.runId` and a
`linkedExecutionId` pivoted from it: when the finding carries a
server-minted `runId` (Pass 1), the resolver runs a bounded, paginated Scan
of the executions table (capped at 1000 items examined) looking for a row
whose own `runId` matches AND whose `orgId` matches the finding's org (a
cross-org match is skipped, never surfaced) — unlike the
`workflowId`/`orchestrationId` fallback above, `runId` is minted once per
dispatch and does not suffer the orchestrationId/executionId identifier
mismatch. `linkedExecutionId` is `null`, never an error, when: the finding
predates runId stamping (write-once ledger, no backfill), no execution row's
`runId` matches within the scan cap, or the only matching row belongs to a
different org. A `null` here means "not found within the bounded scan," not
a guarantee that no matching execution exists — it does **not** distinguish
"confirmed absent" from "cap-truncated" in the API response itself (the
`String` return type has no field for that); a cap-truncation is instead
logged at `warn` in the resolver so operators can tell the two apart in
CloudWatch. This pivot becomes a true guarantee only once a dedicated GSI on
`runId` (deferred per design — "+1 GSI findings" is future work) replaces
the capped Scan with an exact Query. The `workflowId` fallback remains
available as a secondary signal regardless of `linkedExecutionId`'s value.

**Still best-effort (pre-runId findings/executions, or no GSI-backed global
lookup):** the runId pivot above is a bounded, capped Scan (no runId GSI
exists on either the governance ledger or the executions table — see
`docs/TRACING_RUNBOOK.md`'s "Deferred" note); it degrades to `null` on any
lookup failure rather than propagating an error. Two GSIs (governance
ledger `runId` index; cost-ledger `runId` index) are the deferred follow-up
that would make a *global* "given only a runId, find everything" query
possible without a Scan — not implemented in this pass.

---

# Platform-Health Dashboard + SLO Alarms

Owned by **TelemetryStack** (decision `ab73ae1b`: dashboards + alarms are a
telemetry-stack responsibility, kept out of `backend-stack.ts` to preserve
its resource headroom). One dashboard; per-stack detail dashboards are
deliberately **deferred** — CloudWatch's own drill-down (click a widget →
Metrics console → filter by dimension) already covers that need at the
current traffic scale.

## Dashboard: `citadel-platform-health-${env}`

Six sections, top to bottom (on-call reads the health strip first):

| # | Section | Widgets |
|---|---------|---------|
| 0 | Health strip | 1h SingleValue: workflow failures, AppSync 5XX, max DLQ depth, cost-reconciler windows-reconciled, escalations |
| 1 | API health | AppSync errors/latency/requests; cost + gateway HttpApi 5xx/4xx; published-app APIs via `SEARCH()` |
| 2 | Workflow health | `NodeDurationMs`/`NodeQueueWaitMs` p50/p90 (`SEARCH()`), `NodeFailure` breakdown, `NodeColdStart`, worker/supervisor/fabricator Lambda Errors/Throttles/Duration |
| 3 | Cost & reconciliation | `AbsEstimateDriftPct` (with a 25% SLO annotation), `WindowsReconciled`, `UnmatchedLedgerModels`, `LedgerTokens` vs `MetricTokens`, `TierBActive` |
| 4 | Governance | `OffFrontierEscalations` + an `AlarmStatusWidget` referencing the existing (arbiter-stack-owned) escalation alarm |
| 5 | DLQ / error budget | DLQ depth + oldest-message age (`SEARCH()`, `citadel-*dlq*`), DynamoDB throttles/errors, and the platform-health `AlarmStatusWidget` (all 6 new alarms) |

All `Citadel/Workflows` metric-name/namespace/dimension strings are imported
from `backend/src/utils/metrics-constants.ts` — never retyped. That module
was extended for this story to add `METRIC_NODE_DURATION_MS`,
`METRIC_NODE_FAILURE`, and `METRIC_NODE_QUEUE_WAIT_MS`, mirroring the
values already pinned in the Python arbiter tier's
`arbiter/common/metrics_constants.py` (same namespace, both languages write
into it; the TS side just didn't have these three yet). Cross-dimension
**widgets** use `SEARCH()`; cross-dimension **alarms** use CloudWatch
Metrics Insights, because `SEARCH()` results are not alarmable.

## Alarms (6 new — all → the existing `citadel-alarms-${env}` topic)

No new SNS topic was created. `BackendStack.alarmTopic` (previously a local
`const`) was promoted to `public readonly` and threaded into
`TelemetryStackProps`, alongside `appSyncApiId` (for the concrete
`GraphQLAPIId` dimension on A3). TelemetryStack already depends on
BackendStack, so this added zero new stack edges.

| # | Alarm name | Metric / expression | Threshold | Period × Eval (datapoints) | `treatMissingData` | Action |
|---|---|---|---|---|---|---|
| A1 | `citadel-workflow-node-failure-${env}` | Metrics Insights `SUM(NodeFailure)` across `WorkflowId`/`AgentId` | ≥ 1 | 5m × 3 (1) | `notBreaching` | Trace viewer + DLQ check |
| A2 | `citadel-workflow-queue-wait-${env}` | Metrics Insights `MAX(NodeQueueWaitMs)` | > 30000 ms | 5m × 3 (3) | `notBreaching` | Worker concurrency/throttles |
| A3 | `citadel-appsync-5xx-${env}` | `AWS/AppSync 5XXError` (dim `GraphQLAPIId`) | ≥ 5 | 5m × 1 (1) | `notBreaching` | Resolver logs / X-Ray |
| A4 | `citadel-dlq-not-empty-${env}` | Metrics Insights `MAX(ApproximateNumberOfMessagesVisible)` WHERE `QueueName LIKE 'citadel-%dlq%'` | ≥ 1 | 5m × 1 (1) | `notBreaching` | Identify queue, redrive |
| A5 | `citadel-cost-reconciler-stalled-${env}` | `Citadel/CostReconciler WindowsReconciled` (dim `Environment`) | < 1 | 1h × 3 (3) | **`breaching`** — absence IS the failure | Check reconciler Lambda/schedule |
| A6 | `citadel-cost-drift-high-${env}` | `Citadel/CostReconciler AbsEstimateDriftPct` (dim `Environment`) | > 25% | 1h × 3 (3) | `notBreaching` | Pricing catalog freshness |

Every alarm carries an in-code comment marking its threshold as a
**dev-calibrated starting point**. The existing `OffFrontierEscalations`
alarm (arbiter-stack) and the backend-stack Lambda error/throttle alarms are
retained unchanged — they are surfaced on the dashboard, not re-created here.

## Tuning path (binding procedure, not a one-time calibration)

1. Run for **2 weeks** against real (or representative staging) traffic.
2. Pull p90/p99 of `NodeDurationMs`, `NodeQueueWaitMs`, and the AppSync 5XX
   rate from CloudWatch for that window.
3. Set each threshold to `baseline × agreed-multiplier` (multiplier decided
   per-alarm, not a single global constant — e.g. queue-wait tolerates less
   headroom than cost-drift).
4. Record the change as an ADR referencing the baseline data pulled in step 2.

No threshold shipped in this change is final; treat the numbers in the table
above as placeholders that unblock dev/staging sign-off.

## Fault-injection acceptance procedure

**Unit level** (`backend/lib/__tests__/telemetry-stack.test.ts`): `Template`
assertions per alarm — name, threshold, comparison operator, evaluation
periods, datapoints-to-alarm, `treatMissingData`, and that `AlarmActions`
resolves to the shared alarm topic — plus dashboard-body assertions for the
four cross-stack namespaces and all six section titles. These are the
primary, CI-enforced proof that each alarm is wired correctly.

**Operational** (manual, one-time-per-environment sign-off — supplements,
does not replace, the unit assertions above):

Datapoint alarms (A1–A4, A6) — publish a synthetic datapoint and confirm the
alarm actually fires:

```bash
aws cloudwatch put-metric-data --namespace Citadel/Workflows \
  --metric-name NodeFailure --unit Count --value 1 \
  --dimensions WorkflowId=inject-test,AgentId=inject-test --region "$REGION"
# wait ~5-15 min for the eval window, then:
aws cloudwatch describe-alarms --alarm-names "citadel-workflow-node-failure-${ENV}" \
  --query 'MetricAlarms[0].StateValue' --output text   # expect: ALARM
```

Absence-based alarm (A5) cannot be forced by adding data — either wait 3h
with the reconciler schedule disabled, or (faster, and this also proves the
SNS wiring for every alarm including the datapoint ones) force the state
directly:

```bash
aws cloudwatch set-alarm-state --alarm-name "citadel-cost-reconciler-stalled-${ENV}" \
  --state-value ALARM --state-reason "fault-injection wiring test" --region "$REGION"
# confirm the on-call subscriber (email/chatbot) received the notification, then:
aws cloudwatch set-alarm-state --alarm-name "citadel-cost-reconciler-stalled-${ENV}" \
  --state-value OK --state-reason "reset" --region "$REGION"
```

`put-metric-data` proves the metric → threshold path for datapoint alarms;
`set-alarm-state` proves the alarm → SNS → notifier path for every alarm,
including the absence-based one. Both are required before signing off a new
environment's alarm wiring.
