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
