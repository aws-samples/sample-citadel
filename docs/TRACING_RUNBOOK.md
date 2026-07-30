# Tracing Runbook — Cross-Service Trace Propagation

Operator reference for finding the full set of per-Lambda / per-worker
traces belonging to one logical flow (a workflow execution, an intake
session), and the stable API contract the waterfall-viewer UI story depends
on.

> **Applies to:** `feat/runtime-tracing` (architect task `f4f4bab3-7a07-4acf-
> ba43-ba43bb488444`, "Trace-Context Propagation" design).
> **Last updated:** 2026-07-30.

## Account tracing settings — Transaction Search (read BEFORE enabling AgentCore Observability)

> Platform constraint, discovered 2026-07-30 while researching AgentCore
> Observability for the intake runtime. Binding on anyone about to change
> ACCOUNT-level tracing settings. Everything below this section assumes the
> account's X-Ray trace destination is still the default (the X-Ray
> service).

### The constraint: Transaction Search blinds the waterfall viewer

AgentCore Observability (the managed GenAI views for AgentCore
Runtime-hosted agents — our intake container, and any fabricated agents
hosted there) **requires CloudWatch Transaction Search**. Enabling
Transaction Search is an **account-wide** switch: it changes the account's
X-Ray trace destination to CloudWatch Logs (spans land in the `aws/spans`
log group). After that switch the classic X-Ray query APIs return nothing —
AWS's own API reference notes that traces **cannot be found through
`GetTraceSummaries` / `BatchGetTraces` when Transaction Search is
enabled**.

Those two APIs are exactly what this platform's trace query surface uses:
`backend/src/lambda/trace-query-handler.ts` issues
`GetTraceSummariesCommand` + `BatchGetTracesCommand` behind all three
`/traces/*` routes. **Enabling Transaction Search makes the waterfall
viewer blind for every Lambda in all stacks** — workflows, cost,
governance, intake consumers, everything in the hop matrix below — not just
the AgentCore side. And it fails silently: zero summaries past the
freshness window renders as `empty` ("no trace recorded"), not as an error.

References:

- AgentCore Observability (Transaction Search prerequisite):
  <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html>
- Enabling it — what the setup actually toggles:
  <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html>
- The X-Ray API note ("You cannot find traces through this API if
  Transaction Search is enabled"), on both operations:
  <https://docs.aws.amazon.com/xray/latest/api/API_GetTraceSummaries.html>
  and
  <https://docs.aws.amazon.com/xray/latest/api/API_BatchGetTraces.html>

### The two coherent choices

There is **no no-cost third option**: AgentCore Observability and the
current X-Ray-API-backed viewer cannot coexist in one account. Decide (a)
or (b) explicitly; any plan that assumes "AgentCore agents in the viewer"
without funding the port in (a) is wrong.

**(a) Port the trace query surface to Transaction Search — recommended
long term.** Rework `trace-query-handler.ts` (and the `xray-filter.ts` /
`xray-waterfall.ts` shaping behind it) from `GetTraceSummaries` /
`BatchGetTraces` to Transaction Search / CloudWatch Logs span queries over
`aws/spans`. This unifies Lambda traces with AgentCore agent spans in one
query surface and unlocks the managed GenAI Observability views
(Sessions → Traces → Spans). It is a real port — filter expressions,
pagination, and the segment-document shaping all change — so treat it as a
scoped story, not a toggle.

**(b) Keep the X-Ray APIs and do NOT enable Transaction Search.** The
waterfall viewer keeps working exactly as documented in this runbook, and
AgentCore-hosted agents stay **invisible** to tracing (their spans have
nowhere to go that we query). This is the current state; acceptable
short-term, permanent blind spot if never revisited.

### What the intake container needs before its telemetry appears at all

Independent of the account-level choice, the intake runtime
(`AgentIntakeSingleRuntime` in `backend/lib/services-stack.ts`) emits
nothing usable today. All of the following are currently missing:

1. **Execution-role permissions** — none of these are granted in
   `services-stack.ts` today:
   - `xray:PutTraceSegments`, `xray:PutTelemetryRecords`,
     `xray:GetSamplingRules`, `xray:GetSamplingTargets`
   - `cloudwatch:PutMetricData`, condition-scoped to the
     `bedrock-agentcore` namespace
   - CloudWatch Logs write/describe on `/aws/bedrock-agentcore/runtimes/*`
2. **The runtime tracing toggle** — nothing in the
   `AgentIntakeSingleRuntime` definition enables observability/tracing on
   the runtime resource.
3. **ADOT disable semantics** — the runtime env pins `LANGFUSE_SECRET_KEY`
   / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_BASE_URL` to `""`. That starves the
   Langfuse exporter path but is **not** the sanctioned way to disable
   ADOT — `DISABLE_ADOT_OBSERVABILITY=true` is. If the intent is
   "observability off", set that variable explicitly; if the intent is
   "observability on", do not assume the empty Langfuse pins are a
   sanctioned lever either way.

### AgentCore identifier semantics (Sessions → Traces → Spans)

Worth knowing before joining ids across the two worlds:

- AgentCore models telemetry as **Sessions → Traces → Spans**, keyed on
  the runtime session id header, which ADOT propagates as the `session.id`
  span attribute.
- AgentCore trace ids are **X-Ray-compatible**. The X-Ray-form rendering
  the intake helper now performs
  (`service/agent_intake_single/tools/tracing.py::active_trace_context()`,
  OTel span context → `1-<8 hex>-<24 hex>` trace id + 16-hex parent) is
  correct and joinable with every id in this runbook.
- Two improvements NOT yet made (follow-ups — do not assume they exist):
  1. **Trace context is not propagated INTO the agent on invoke** — the
     container starts a new root instead of parenting our hop. Carrying
     the trace context (e.g. `traceparent`) on `InvokeAgentRuntime` would
     fix the split.
  2. **The run identifier is not carried as the runtime session id** — so
     runs do not appear in the GenAI Observability Sessions view. Passing
     `runId` as the session id would make runs first-class there.

## Root-segment framing (read this first)

AWS Lambda owns its own X-Ray root segment per invocation; a consumer Lambda
**cannot** adopt an upstream trace-id as its own root. "One trace across
every hop" is only literally true for subsegments **within a single
invocation** (H1, H5 in the hop matrix below). Across every async
Lambda→Lambda boundary (EventBridge fan-out, SQS dispatch), the delivered
guarantee is **provably-linked traces** — either a native X-Ray Link (SQS
with `AWSTraceHeader`) or an annotation-stitched, searchable correlation —
never a false merge of two root segments into one.

## Hop matrix (confidence as of design time; see the 4 dev probes below)

| Hop | Path | Mechanism | Confidence |
|-----|------|-----------|------------|
| H1 | resolver/worker → EventBridge `PutEvents` | native subsegment | HIGH |
| H5 | in-invocation DynamoDB / Bedrock / PutEvents | native | HIGH |
| H3 | stepRunner → SQS → workerWrapper | native-linked (via `AWSTraceHeader` MessageAttribute) + annotation floor | HIGH (upgraded from MEDIUM) |
| H2 | EventBridge fan-out (agent-message-handler, project-progress-updater, workflow-progress-fanout, governance-notifier, gateway-registration-handler, stepRunner, cost-ledger writer) | annotation-stitched | HIGH (annotation), LOW/unverified (native EB→Lambda link) |
| H4 | worker → EventBridge `workflow.node.completed/failed` → stepRunner | same as H2 | HIGH (annotation) |
| H6 | intake AgentCore Runtime → EventBridge `intake.progress.updated` / `intake.usage.captured` → consumers | producer subsegment native; downstream annotation-stitched | HIGH (annotation) — see caveat below |

**H6 caveat:** `service/agent_intake_single` runs OpenTelemetry (via
`strands-agents[otel]`), not the X-Ray SDK — `aws-xray-sdk` is not a
declared dependency of that service. `tools/tracing.active_trace_context()`
degrades to a genuine no-op (`traceContext` never populated) in every
current deployment. The Detail shape stays additive-safe either way; H6
will start actually stitching the moment `aws-xray-sdk` is added to
`service/agent_intake_single/requirements.txt` (an infra follow-up, no code
change required beyond that).

**cost-ledger-reconciler is NOT a consumer hop.** It is `rate(1 hour)`
schedule-triggered with no event argument — there is no Detail/traceContext
to extract from. It originates its own X-Ray root per invocation like any
other scheduled Lambda; no annotation wiring applies.

## Annotation-key contract (STABLE — do not rename without a migration plan)

X-Ray annotations (searchable, `[A-Za-z0-9_]` keys):

| Key | Meaning |
|-----|---------|
| `correlation_id` | correlationId (== executionId for workflows; per-event uuid for intake usage) |
| `source_trace_id` | the carried upstream X-Ray Root trace id — the stitch key |
| `execution_id` | workflow executionId, when applicable |
| `node_id` | workflow node id, when applicable |
| `session_id` | intake sessionId, when applicable |
| `run_id` | server-minted shared correlation id (Pass 1, decision f1cbd5ef) — additive, absent on pre-runId hops. When present, this is the PRIMARY key the query surfaces (`docs/OBSERVABILITY.md`, `docs/TRACING_RUNBOOK.md#operator-query`) use — see the Pass 2 GUARANTEED/best-effort split below. |

X-Ray metadata (non-searchable, full fidelity): namespace `trace_context` →
the raw carried `traceContext` object.

Structured-log fields (every line, both runtimes): `trace_id` (active
segment Root, or the Lambda-injected `_X_AMZN_TRACE_ID` Root when no SDK
segment is active), `correlationId`, `source_trace_id` (when a
`traceContext` was carried in).

These key literals are pinned by dedicated tests in both languages —
`backend/src/utils/__tests__/trace-context.test.ts` (`addAnnotation`/
`addMetadata` call assertions) and
`arbiter/common/__tests__/test_tracing.py` (`put_annotation`/
`put_metadata` call assertions) — so a silent rename fails CI rather than
silently breaking the waterfall-viewer story.

## Operator query: "show me every trace for one flow"

**X-Ray / CloudWatch (trace side):**

**GUARANTEED (runId present — Pass 2):**
```
annotation.run_id = "<runId>"
```
`/traces/by-execution/{executionId}` and `/traces/by-conversation/{conversationId}`
now query by `annotation.run_id` FIRST whenever the resolved execution/
conversation row carries a server-minted `runId` (Pass 1, decision f1cbd5ef).
This is the runId-PRIMARY correlation path (design §4): it covers the
execution path that `workflowId == orchestrationId` never reached, since
that equality only ever held on the chat/task path. The response's
`linkedBy` field reports which key was actually used
(`"run_id"` vs `"correlation_id"`), so callers never have to guess.

**STILL BEST-EFFORT (pre-runId data):**
```
annotation.correlation_id = "<executionId-or-sessionId>"
```
Rows/traces written before this change carry no `runId` — the query
surface falls back to the original `correlation_id` filter automatically
(additive/nullable; a missing `runId` on the ownership row never breaks
the response — the fallback path is unconditionally exercised in this
case, not a degraded/partial result). This fallback stays in place
permanently for any row that predates the runId feature; there is no
backfill (write-once/immutable data, see design §5).

**Deferred:** a *global* "given only a runId, find everything across
findings + cost-ledger with no other key" lookup requires two new GSIs
(governance-findings `runId` index, cost-ledger `runId` index — GSI5).
Both are explicitly deferred per the design; this pass adds runId-primary
correlation on the EXISTING entry-key routes only (execution/conversation
by-id), not a standalone `by-runId` route.

**CloudWatch Logs Insights (log side):**
```
filter correlationId = "<id>"
```
Then pivot to the corresponding X-Ray trace via each log line's `trace_id`
field. This bidirectional `correlationId ↔ traceId` mapping in every
structured log line is what makes the two views cross-navigable.

## Carried-context format

Additive, always-optional `traceContext` object on EventBridge Detail /
SQS message bodies:

```json
{
  "xrayTraceHeader": "Root=1-<8hex>-<24hex>;Parent=<16hex>;Sampled=1",
  "traceId": "1-<8hex>-<24hex>",
  "parentId": "<16hex>",
  "traceparent": "00-<32hex>-<16hex>-01"
}
```

Absence of `traceContext` must never fail a consumer — property-tested in
both languages. SQS additionally carries the standard `AWSTraceHeader`
MessageAttribute (the transport X-Ray/Lambda natively recognize for link
inference).

## Dev probes required before trusting the confidence column above

Run these in a dev account and update the hop-matrix confidence from
**observed** truth, not design-time assumption:

1. **H2 probe** — emit one EventBridge event, inspect the target Lambda's
   trace in the X-Ray console for a `Links` entry (native) vs. relying on
   the `correlation_id` annotation alone (guaranteed path).
2. **H3 probe** — dispatch a workflow node; confirm the worker's trace shows
   as **Linked** to the stepRunner trace, and confirm the `correlation_id`
   annotation is present regardless of link status.
3. **H4 probe** — same as H2, on the worker→stepRunner return leg.
4. **H6 probe** — once `aws-xray-sdk` ships in
   `service/agent_intake_single/requirements.txt`: emit a usage event, find
   the consumer trace by `annotation.correlation_id`.

## File map

TypeScript: `backend/src/utils/trace-context.ts` (helpers), `events.ts`
(producer), `logger.ts` (log fields), and consumers
`agent-message-handler.ts`, `project-progress-updater.ts`,
`workflow-progress-fanout.ts`, `governance-notifier.ts`,
`gateway-registration-handler.ts`, `cost-ledger-writer.ts`.

Python: `arbiter/common/tracing.py` (helpers + `TraceIdLogFilter`),
`arbiter/stepRunner/events.py` (producer), `arbiter/stepRunner/executor.py`
(SQS `AWSTraceHeader` + body `traceContext`), `arbiter/stepRunner/index.py`
(consumer), `arbiter/workerWrapper/index.py` (SQS consumer + node-result
producer), `arbiter/common/workflow_contract.py` (additive kwarg
plumbing), `service/agent_intake_single/tools/tracing.py` (self-contained
copy — see H6 caveat above for why it's not `arbiter/common/tracing`),
`service/agent_intake_single/tools/state.py` (producer).

## Waterfall viewer API + authorization posture

> **Applies to:** architect task `60ba09e4-d859-42f2-9e47-6e6c9ccd2a83`
> ("Waterfall Trace Viewer" design). Pass 1 (backend query surface) landed in
> `2c89844`; pass 2 (frontend viewer + deep-links) is this change.

The waterfall viewer surfaces the annotation contract above through three
read-only HTTP routes added to the **existing** `costHttpApi` (same Cognito
JWT authorizer, same CORS/access-log stage as the cost API — see
`docs/OBSERVABILITY.md` for the `aws_cost_api_url` reuse rationale):

```
GET /traces/by-execution/{executionId}       # ownership-gated
GET /traces/by-conversation/{conversationId} # ownership-gated (→ project → org)
GET /traces/{traceId}                        # admin-only
```

### Authorization matrix

| Route | Non-admin, own org | Non-admin, other org | Admin |
|---|---|---|---|
| `GET /traces/by-execution/{id}` | 200 (org == execution.orgId) | 403 | 200 (any) |
| `GET /traces/by-conversation/{id}` | 200 (org == project.orgId) | 403 | 200 (any) |
| `GET /traces/{traceId}` | **403** | **403** | 200 |
| unknown execution/conversation id | 404 | 404 | 404 |
| missing `custom:organization` claim | 403 | 403 | (admin still 403 on by-* if no claim; 200 on traceId) |

An `executionId` or `conversationId` resolves to an owning org in our own
DynamoDB (executions row carries `orgId` directly; conversations resolve via
`projectId` → the projects table) and that org is checked **before any X-Ray
call is issued** — mirroring the cost API's `resolveScopedOrg` /
`isAdminFromHttpEvent` discipline. A raw trace id has no such org entry key,
so `/traces/{traceId}` is admin-only, matching the governance
counterfactual/decision-trace precedent for account-wide reads.

### RESIDUAL-RISK STATEMENT

Even after the entry key is org-checked, the trace **data** returned by
`BatchGetTraces` is account-wide segment content. Concretely:
- **What is returned:** every segment/subsegment sharing the org-checked
  `correlation_id`. By construction (`correlation_id == executionId`, a v4
  UUID; or a per-session UUID) these belong to **one flow / one org** — UUID
  collision across orgs is negligible, so cross-org bleed via the filter is
  effectively nil.
- **What segment content exposes:** AWS **infrastructure identifiers** —
  Lambda function names, DynamoDB table names, Bedrock model/inference-profile
  ARNs, SQS/EventBridge names, HTTP status codes, durations, and our own
  annotations (`correlation_id`, `source_trace_id`, `execution_id`,
  `node_id`, `session_id`, `run_id`) + `trace_context` metadata. These are
  **shared-infra operational identifiers, not per-row customer data** — the
  same function/table serves every org, so a name/timing is not
  org-sensitive.
- **The genuine residual leak** is narrow: (a) if a future code path ever put
  **customer payload into a subsegment name, annotation, or metadata** it would
  become viewable by any owner of the entry key — so the design mandates a docs
  guardrail: *never put request/response bodies or PII into X-Ray annotations/
  metadata/subsegment names* (the current contract only stamps IDs, which is
  safe); and (b) a shared-infra subsegment created by an unrelated concurrent
  flow could in principle carry the same correlation_id only if we mis-stamped
  it — prevented by the CIT-021 contract stamping correlation_id from the
  carried context, not a shared constant.
- **Mitigations baked into the design:** (1) server-side filter is pinned to
  the single org-checked correlation id — we never return "all recent traces";
  (2) the waterfall shaper **allowlists** fields onto the response (id, name,
  times, http.status, error/fault/throttle, namespace, our annotation keys) and
  **drops raw `metadata`/`sql`/`aws.*` bags** by default so an accidental
  payload in metadata is not surfaced; (3) admin-only raw trace-id keeps the
  unscoped lookup behind the highest gate.

Security posture summary (one line for docs/PR): *Entry-key ownership check
(execution/conversation → org) for all users; account-wide raw trace-id
admin-only; X-Ray IAM is unavoidably `Resource:*` (nag-suppressed with
justification); trace bodies are infra-level identifiers, field-allowlisted on
egress, and the tracing contract forbids customer data in annotations/metadata.*

### `status` freshness semantics (X-Ray eventual availability)

- `GetTraceSummaries` filter returns ≥1 → `ready`.
- 0 summaries AND the entry (execution/conversation) `completedAt`/last
  activity is within the freshness window (~90s) → `indexing` (UI: "trace
  still indexing, retry" + auto-retry). This avoids a false "no trace".
- 0 summaries AND entry is older than the window → `empty` (UI: "no trace
  recorded" — e.g. sampling miss, or H6 intake not yet stitching per the
  hop matrix above).

### Guardrail (binding on all future annotation/metadata producers)

**Never put request/response bodies or PII into X-Ray annotations, metadata,
or subsegment names.** The current contract only stamps IDs
(`correlation_id`, `source_trace_id`, `execution_id`, `node_id`,
`session_id`, `run_id`) — this is what keeps the ownership-gated,
account-wide-segment read model in this section safe. Any change that adds
richer data to `traceContext`/`metadata` must be reviewed against the
residual-risk statement above before merging.

### Frontend

`frontend/src/services/traceService.ts` calls these routes (Bearer idToken,
reuses `aws_cost_api_url` — see `docs/OBSERVABILITY.md`). The viewer page
(`frontend/src/pages/Observability.tsx`) is reached via "View trace" deep
links from an execution detail sheet or a project conversation, or — for
admins only — a raw trace-id lookup input, consistent with the
admin-only gate on `/traces/{traceId}` above.
