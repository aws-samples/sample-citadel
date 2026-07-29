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
