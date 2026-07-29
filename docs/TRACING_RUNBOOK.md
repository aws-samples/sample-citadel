# Tracing Runbook — Cross-Service Trace Propagation

Operator reference for finding the full set of per-Lambda / per-worker
traces belonging to one logical flow (a workflow execution, an intake
session), and the stable API contract the waterfall-viewer UI story depends
on.

> **Applies to:** `feat/runtime-tracing` (architect task `f4f4bab3-7a07-4acf-
> ba43-ba43bb488444`, "Trace-Context Propagation" design).
> **Last updated:** 2026-07-28.

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
```
annotation.correlation_id = "<executionId-or-sessionId>"
```
Returns every per-Lambda/per-worker trace annotated with that
correlation id — the full stitched set for one workflow execution or
intake session.

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
  `node_id`, `session_id`) + `trace_context` metadata. These are **shared-infra
  operational identifiers, not per-row customer data** — the same function/
  table serves every org, so a name/timing is not org-sensitive.
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
`session_id`) — this is what keeps the ownership-gated, account-wide-segment
read model in this section safe. Any change that adds richer data to
`traceContext`/`metadata` must be reviewed against the residual-risk
statement above before merging.

### Frontend

`frontend/src/services/traceService.ts` calls these routes (Bearer idToken,
reuses `aws_cost_api_url` — see `docs/OBSERVABILITY.md`). The viewer page
(`frontend/src/pages/Observability.tsx`) is reached via "View trace" deep
links from an execution detail sheet or a project conversation, or — for
admins only — a raw trace-id lookup input, consistent with the
admin-only gate on `/traces/{traceId}` above.
