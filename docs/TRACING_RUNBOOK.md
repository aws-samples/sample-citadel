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

**(a) Port the trace query surface to Transaction Search — IMPLEMENTED
(design task `c7a4bf52`).** `trace-query-handler.ts` now dispatches on a
`TRACE_BACKEND` env var (`xray` | `spans`, **default `xray`**) — the
handler ships with NO behavior change until an operator flips it. The
`spans` path queries CloudWatch Logs Insights over `aws/spans`
(`utils/spans-query.ts`: `StartQuery` → bounded poll (~20s cap, `500ms`
interval, `StopQuery` on early exit) → `GetQueryResults`) and shapes rows
into the SAME `TraceEntry`/`TraceSpan` types the X-Ray path emits
(`utils/spans-waterfall.ts`) — the frontend cannot tell which backend
produced a response. `utils/trace-span-query.ts` builds the Logs Insights
filter clauses (`annotation.correlation_id`/`annotation.run_id`) with the
same allowlist/reject-first discipline as `xray-filter.ts`.

> ⚠️ **`utils/spans-waterfall.ts` carries an unverified-schema warning at
> every field-name assumption** (`spanId`, `parentSpanId`, `traceId`,
> `startTimeUnixNano`/`endTimeUnixNano`, the `attributes.*`/`annotation.*`
> attribute-key shapes). These are design-time assumptions, not values
> confirmed against a real Transaction Search span. See "Cutover
> procedure" below — do not flip `TRACE_BACKEND=spans` in any real account
> before completing the schema-verification step.

### Cutover procedure (flipping `TRACE_BACKEND` from `xray` to `spans`)

Both IAM permission sets (X-Ray read + Logs Insights StartQuery/
GetQueryResults/StopQuery) are granted on the `TraceQueryHandler` role
regardless of the env value (`telemetry-stack.ts`), so this cutover is an
**env-only** change — no IAM/CDK-permission deploy is needed at flip time.

1. **Verify the aws/spans schema with a real sample** (blocking,
   pre-requisite — do this BEFORE step 2). In a dev account with
   Transaction Search already enabled, run a Logs Insights query against
   `aws/spans` for a recent span (console or
   `aws logs start-query`/`get-query-results`) and diff the actual result
   column names against every field-name assumption listed in
   `utils/spans-waterfall.ts`'s module header (`spanId`, `parentSpanId`,
   `traceId`, `startTimeUnixNano`/`endTimeUnixNano`, the
   `attributes.http.response.status_code` / `attributes.exception.*` /
   `annotation.*` attribute keys, `statusCode`). Update the constants in
   `spans-waterfall.ts` (and the query text in `trace-span-query.ts` if the
   annotation attribute key differs) to match reality; add/adjust the Red
   fixture in `spans-waterfall.test.ts` to the verified shape before
   changing the implementation (strict TDD, not a silent hand-edit).
2. **Enable Transaction Search account-wide** — manual/deploy step, never
   executed by an agent (binding constraint, see the section above). This
   redirects the account's X-Ray trace destination to CloudWatch Logs; the
   `xray` backend goes blind for every Lambda in every stack the moment
   this is done.
3. **Flip `TRACE_BACKEND=spans`** — a tiny CDK env-only deploy of
   `telemetry-stack.ts` (`TRACE_BACKEND` Lambda environment variable). No
   other resource changes (after this branch's telemetry-stack is
   deployed) — both IAM permission sets are already granted on the
   deployed `TraceQueryHandler` role only once the branch's stack update
   has shipped; against an account still running a pre-port
   `telemetry-stack.ts`, this step is a full stack deploy, not merely an
   env-var flip.
4. **Verify** the waterfall viewer against a live execution/conversation
   trace and the admin raw-trace-id route; confirm `status`/`linkedBy`
   behave as documented below and that AgentCore agent spans (once the
   runtime grants + ADOT wiring below are live) appear in the same viewer.
5. **Reversible**: flip `TRACE_BACKEND` back to `xray` instantly if the
   ported path misbehaves — this works right up until the account-wide
   Transaction Search switch itself is reverted (which is the actually
   hard-to-reverse step, not the env flag).
6. **Deferred cleanup (do NOT do this until `spans` is confirmed stable in
   all environments)**: remove the `xray:GetTraceSummaries`/
   `BatchGetTraces` grant + its NagSuppression from `telemetry-stack.ts`,
   and consider removing the X-Ray fetch/parse path (`xray-filter.ts`,
   `xray-waterfall.ts`, the X-Ray branches in `trace-query-handler.ts`)
   entirely.

**(b) Keep the X-Ray APIs and do NOT enable Transaction Search.** The
waterfall viewer keeps working exactly as documented in this runbook, and
AgentCore-hosted agents stay **invisible** to tracing (their spans have
nowhere to go that we query). This is the pre-port default state
(`TRACE_BACKEND` unset/`xray`) — safe indefinitely, but a permanent blind
spot for AgentCore agents if the cutover above is never run.

### What the intake container needs before its telemetry appears at all

Independent of the account-level choice, the intake runtime
(`AgentIntakeSingleRuntime` in `backend/lib/services-stack.ts`) previously
emitted nothing usable. Status as of the port (design task `c7a4bf52`):

1. **Execution-role permissions — RESOLVED.** `services-stack.ts` now
   grants: `xray:PutTraceSegments`, `xray:PutTelemetryRecords`,
   `xray:GetSamplingRules`, `xray:GetSamplingTargets` (Resource:*,
   un-scopable, covered by the existing
   `AgentIntakeSingleRuntime/ExecutionRole/DefaultPolicy/Resource`
   NagSuppression in `bin/app.ts`); `cloudwatch:PutMetricData`
   conditioned on `cloudwatch:namespace == bedrock-agentcore`; CloudWatch
   Logs create/put/describe scoped to
   `arn:aws:logs:<region>:<account>:log-group:/aws/bedrock-agentcore/runtimes/*`.
2. **The runtime tracing toggle — UNRESOLVED, documented no-op.** At
   implementation time the alpha `agentcore.Runtime` construct exposed no
   observability/tracing field, and the underlying L1
   `AWS::BedrockAgentCore::Runtime` CFN schema could not be verified
   (`node_modules` not installed in that checkout — see design task
   `c7a4bf52`'s recon). No `addPropertyOverride` escape hatch was added
   speculatively. **Before relying on AgentCore spans in production**,
   re-check whether the installed `aws-cdk-lib`/alpha package version
   exposes an observability/tracing property on `CfnRuntime`; if so, wire
   it via `(runtime.node.defaultChild as CfnRuntime).addPropertyOverride(...)`
   (the same L1-escape-hatch pattern `tracing-aspect.ts` uses for
   `CfnFunction.tracingConfig`) and cover it with a
   `services-stack.test.ts` assertion — do not assert its presence from
   memory. Absent an explicit toggle, observability is expected to follow
   from (a) the account-level Transaction Search switch, (b) the
   exec-role permissions above, and (c) ADOT auto-instrumentation not
   being disabled (item 3).
3. **ADOT disable semantics — RESOLVED.** The 3 empty
   `LANGFUSE_SECRET_KEY`/`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_BASE_URL` env pins
   have been REMOVED from `services-stack.ts` (verified via
   `service/agent_intake_single/agent.py`'s Langfuse-exporter gate,
   `if _lf_pk and _lf_sk` — both keys are falsy whether pinned to `""` or
   fully absent, so removing the pins changes nothing about that gate;
   the Langfuse OTLP exporter stays un-wired either way). `services-stack.ts`
   does **NOT** set `DISABLE_ADOT_OBSERVABILITY` — the intent (design §6,
   decision `dc270923`) is ADOT observability ON, unifying Lambda +
   AgentCore spans in one Transaction Search-backed viewer.


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
| H6 | intake AgentCore Runtime → EventBridge `intake.progress.updated` / `intake.usage.captured` → consumers | producer: live OTel span context (ADOT), rendered to X-Ray form; downstream annotation-stitched | HIGH (annotation) — see caveat below |

**H6 caveat:** `service/agent_intake_single` runs OpenTelemetry (via
`strands-agents[otel]`), not the X-Ray SDK — `aws-xray-sdk` is not a
declared dependency of that service. `tools/tracing.active_trace_context()`
no longer degrades to a no-op: its source priority 1 is the live
OpenTelemetry span context (ADOT auto-instrumentation via
`opentelemetry-instrument` + `strands-agents[otel]`), rendered into the
X-Ray form (`1-<8 hex>-<24 hex>` traceId, 16-hex parentId, sampled from
`trace_flags`) so ids stay compatible with the platform's trace search — no
new dependency is required for this to work (bb35989). The X-Ray
(sub)segment branch (`aws-xray-sdk`) is kept only as a harmless fallback for
the currently nonexistent case where that package is added and a segment is
actually open; it is not a precondition for H6 to stitch. Both branches
degrade to `None`/never raise, preserving the byte-identical-when-absent
`traceContext` guarantee.

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

### Run identity (`runId`) minting contract

`runId` (Pass 1, decision `f1cbd5ef`) is **server-minted only** —
`backend/src/utils/run-id.ts`'s `mintRunId()` (format: `run-<uuidv4>`) is
the sole TypeScript producer, invoked at every entry point (intake,
conversation, execution, task-runner, and app-invoke resolvers per
`8ebef1d`). Any client-supplied `runId` on an inbound request body is
stripped/ignored, mirroring how the client-minted `orchestrationId` is
already discarded in `task-runner-resolver.ts` — no code path may read a
`runId` off external input.

`DispatchContext` (same module) makes this a **compile-time** guard, not
just a runtime convention: `runId` is a required field on the type and a
required parameter on `buildDispatchContext()`, so an entry point that
omits it fails `tsc` rather than silently shipping an unstamped dispatch.

Absence of `runId` never fails a write — it is additive/nullable
everywhere it is carried (cost-ledger rows, EventBridge Detail bodies,
X-Ray annotations). To catch a *silent* regression where a call site
should be stamping a `runId` but isn't, the platform emits a WARN-level
backstop metric, `UnstampedDispatch` (`METRIC_UNSTAMPED_DISPATCH` in
`backend/src/utils/metrics-constants.ts`, mirrored in the Python arbiter
tier's `arbiter/common/metrics_constants.py`), whenever a finding or
dispatch is written `runId`-absent. This metric is observability-only — it
never gates dispatch or blocks a write, it exists purely so an operator can
notice the regression on a dashboard instead of discovering it later as a
missing correlation.

## Operator query: "show me every trace for one flow"

**X-Ray / CloudWatch (trace side, `TRACE_BACKEND=xray` — default):**

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

**CloudWatch Logs Insights span query (trace side, `TRACE_BACKEND=spans`
— post-cutover):** the equivalent filter clauses over the `aws/spans` log
group (`utils/trace-span-query.ts`), same runId-primary/correlation_id-
fallback split, same `linkedBy` reporting:
```
filter `annotation.run_id` = "<runId>"
```
```
filter `annotation.correlation_id` = "<executionId-or-sessionId>"
```
Field names (`annotation.run_id`/`annotation.correlation_id` as Logs
Insights attribute keys) are the SAME unverified-schema assumption flagged
in `utils/spans-waterfall.ts` — see "Cutover procedure" above.

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
4. **H6 probe** — runnable now: emit a usage event and confirm
   `traceContext` is carried (live OTel span source, bb35989); find the
   consumer trace by `annotation.correlation_id`.

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
`BatchGetTraces` (or, under `TRACE_BACKEND=spans`, the equivalent Logs
Insights span query over `aws/spans`) is account-wide segment/span
content. Concretely:
- **What is returned:** every segment/subsegment (or, under `spans`,
  every span) sharing the org-checked `correlation_id`. By construction
  (`correlation_id == executionId`, a v4 UUID; or a per-session UUID)
  these belong to **one flow / one org** — UUID collision across orgs is
  negligible, so cross-org bleed via the filter is effectively nil. The
  ownership-before-query posture and the filter's pinned target
  (`correlation_id`/`run_id`) are identical under both backends — only
  the query syntax (X-Ray `FilterExpression` vs. Logs Insights `filter`
  clause) differs.
- **What segment/span content exposes:** AWS **infrastructure
  identifiers** — Lambda function names, DynamoDB table names, Bedrock
  model/inference-profile ARNs, SQS/EventBridge names, HTTP status codes,
  durations, and our own annotations (`correlation_id`, `source_trace_id`,
  `execution_id`, `node_id`, `session_id`, `run_id`) + `trace_context`
  metadata. These are **shared-infra operational identifiers, not
  per-row customer data** — the same function/table serves every org, so
  a name/timing is not org-sensitive.
- **The genuine residual leak** is narrow: (a) if a future code path ever put
  **customer payload into a subsegment name, annotation, or metadata** it would
  become viewable by any owner of the entry key — so the design mandates a docs
  guardrail: *never put request/response bodies or PII into X-Ray annotations/
  metadata/subsegment names* (the current contract only stamps IDs, which is
  safe); and (b) a shared-infra subsegment created by an unrelated concurrent
  flow could in principle carry the same correlation_id only if we mis-stamped
  it — prevented by the CIT-021 contract stamping correlation_id from the
  carried context, not a shared constant.
- **Mitigations baked into the design:** (1) server-side filter (an X-Ray
  `FilterExpression` under `xray`, a Logs Insights `filter` clause under
  `spans`) is pinned to the single org-checked correlation id — we never
  return "all recent traces"; (2) the waterfall shaper (`xray-waterfall.ts`
  / `spans-waterfall.ts`) **allowlists** fields onto the response (id, name,
  times, http.status, error/fault/throttle, namespace, our annotation keys) and
  **drops raw `metadata`/`sql`/`aws.*` bags** by default so an accidental
  payload in metadata is not surfaced; (3) admin-only raw trace-id keeps the
  unscoped lookup behind the highest gate.

Security posture summary (one line for docs/PR): *Entry-key ownership check
(execution/conversation → org) for all users; account-wide raw trace-id
admin-only; X-Ray IAM is unavoidably `Resource:*` (nag-suppressed with
justification), and the `spans` backend's `logs:GetQueryResults`/`StopQuery`
carry the same unavoidable `Resource:*` posture (its `logs:StartQuery` IS
scoped to the `aws/spans` log-group ARN); trace/span bodies are infra-level
identifiers, field-allowlisted on egress, and the tracing contract forbids
customer data in annotations/metadata.*

### `status` freshness semantics (X-Ray / Transaction Search eventual availability)

- `GetTraceSummaries` filter (`xray` backend) or a Complete Logs Insights
  query with rows (`spans` backend) returns ≥1 → `ready`.
- 0 summaries/rows AND the entry (execution/conversation) `completedAt`/
  last activity is within the freshness window (~90s) → `indexing` (UI:
  "trace still indexing, retry" + auto-retry). This avoids a false "no
  trace". The window matters MORE under the `spans` backend — Transaction
  Search ingestion lag can exceed a single Lambda invocation.
- 0 summaries/rows AND entry is older than the window → `empty` (UI: "no
  trace recorded" — e.g. sampling miss, or H6 intake not yet stitching per
  the hop matrix above).
- **`spans` backend only — poll-budget-exhausted:** if the bounded Logs
  Insights poll (`utils/spans-query.ts`, ~20s cap) exhausts its attempts
  while the query is still `Running`/`Scheduled`, the response maps this
  to `indexing` unconditionally — **never** `empty` and **never** a 5xx —
  regardless of how old the entry is. This is a retryable "still working"
  signal, not evidence of absence; it reuses the existing `indexing`
  status so the frontend needs zero changes for this case. A genuine query
  `Failed`/`Cancelled`/`Timeout` terminal status falls back to the
  freshness-window mapping above instead (logged, not surfaced as an
  error to the caller).

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


## Durable execution resume & the exactly-once limit (decision O7)

Workflow node execution is durable across lost events and worker crashes via
three conditional DynamoDB writes plus a write-then-signal worker:

1. **Dispatch guard** — a node is flipped `pending→running` only while still
   `pending` (`ConditionExpression: nodeResults.#nid.#status = :pending`), so
   concurrent predecessor completions, a resume, and a watchdog sweep converge
   to exactly one dispatch per node.
2. **Worker first-write-wins completion** — the Worker persists the completed
   result to `EXECUTIONS_TABLE.nodeResults[nodeId]` (`status <> :completed`)
   BEFORE emitting `workflow.node.completed`. A lost event therefore leaves a
   durable, reconcilable checkpoint, not a lost result.
3. **Finalize guard** — the execution flips `running→completed` only while
   still `running`, so finalize + the terminal event fire exactly once.

`resumeExecution(executionId)` is **advance-only**: the server re-derives the
frontier from the persisted row (never a caller node list), dispatches only
`pending`-ready nodes, and NEVER re-dispatches a `running` node. Re-driving a
possibly-live worker is the watchdog stall-detector's job, gated by the stall
threshold + first-write-wins.

### The agent-side exactly-once limit (READ THIS)

The guarantees above are **recorded-state** exactly-once ONLY — exactly one
recorded completion, one dispatch, one finalize. They do **NOT** guarantee that
an agent body executes at most once. If the watchdog re-dispatches a node whose
original worker was merely slow (not dead), or SQS redelivers a dispatch after
a persist error, **the agent body runs more than once** and first-write-wins
simply drops the later recorded result.

Operational consequence: **workflow agent bodies must be idempotent** — a node
that provisions IAM, calls an external SaaS integration, or vends credentials
must tolerate being run twice without duplicating the side effect. True
agent-side exactly-once requires a dispatch-generation/lease token (the worker
echoes a monotonic `dispatchGen`; the completion write rejects a stale
generation) and is a deferred fast-follow, NOT provided by this slice.
