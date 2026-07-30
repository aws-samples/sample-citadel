# Execution Replay Package (CIT-026)

Sibling doc to [`TRACING_RUNBOOK.md`](./TRACING_RUNBOOK.md) and
[`OBSERVABILITY.md`](./OBSERVABILITY.md). Documents the replay package
envelope contract, the sanitisation guarantee, and the ingestion contract
for E10's eval-fixture promotion story (CIT-100).

## What it is

`GET /replay/by-execution/{executionId}` and
`GET /replay/by-conversation/{conversationId}` (TelemetryStack `costHttpApi`)
assemble a single, sanitised, org-scoped JSON artifact reproducing a
workflow execution: agent config, workflow/exec-spec/model-config versions,
governance mode, per-node inputs/outputs, governance findings, usage
totals, and trace ids. The artifact is written to a dedicated S3 bucket and
returned as a presigned GET URL (TTL ≤ 5 minutes).

## Authorization

Ownership-gated for **all** members of the owning org (not admin-only) —
reuses `resolveExecutionOwnership` / `resolveConversationOwnership`. A
non-owning org (or an unresolvable execution/conversation id) gets a `404`,
mirroring the waterfall trace viewer's not-found-on-mismatch posture (avoids
existence disclosure). Cross-org leakage is prevented in three independent
layers:

1. The entry-key ownership check (executionId/conversationId → orgId).
2. A per-row `orgId` filter on every table read during assembly
   (`CrossOrgRowError` if any sourced row disagrees with the resolved org).
3. The sanitisation gate itself (see below) — a fail-closed backstop.

## The fail-closed secret gate

Every string in the assembled bundle — at every nesting depth, including
JSON-encoded-string fields — is redacted for PII (`redact-pii.ts`) and
secrets (`secret-patterns.ts`, the single shared pattern module covering
private keys, JWTs, GitHub/Slack/Stripe/Google tokens, DB connection URIs,
and generic key/secret/password/token assignments). After redaction, the
**entire serialized bundle is re-scanned** by `assertBundleSecretFree`
(`replay-sanitize.ts`). Any hit throws `ReplaySecretLeakError` — the handler
never writes to S3 and never returns a URL on that path. Publication is
structurally impossible when a secret pattern fires.

This gate's non-vacuousness is proven by a mutation-kill test
(`replay-gate.test.ts`): the redactor is stubbed to identity, and the test
asserts both that the survival property fails *and* that the gate throws —
i.e. if redaction ever silently regresses, the build refuses rather than
publishing.

## Delivery

- **Bucket**: dedicated (`ReplayPackageBucket` in `TelemetryStack`) — not
  the shared backend document bucket, which has a different lifecycle and
  permissive upload CORS for a different purpose. Block Public Access = all
  on, SSE (S3-managed), lifecycle expiration ~7 days.
- **Presigned URL TTL**: ≤ 300 seconds (5 minutes), enforced with a hard
  ceiling in the handler regardless of the configured env var.
- **Key layout**: `ORG#<orgId>/<kind>-<id>/<packageId>.json`.

## Envelope schema

```json
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-07-30T03:00:00.000Z",
  "producerCommit": "abc1234",
  "kind": "execution",
  "correlationId": "<executionId|conversationId>",
  "orgId": "<orgId>",
  "sanitisation": {
    "redactPiiVersion": "1",
    "secretPatternsVersion": "1",
    "gate": "passed"
  },
  "sections": {
    "agentConfig": { "...": "agent config row, or null" },
    "workflow": { "...": "workflow row, or null" },
    "execSpec": { "...": "exec-spec row, or null" },
    "modelConfig": { "...": "model-config row, or null" },
    "governanceMode": "on | shadow | off | null",
    "nodes": [
      {
        "nodeId": "node-1",
        "inputs": null,
        "outputs": "...",
        "status": "completed",
        "retries": 0,
        "usage": { "inputTokens": 10, "outputTokens": 20, "totalTokens": 30, "callCount": 1 }
      }
    ],
    "toolResults": {
      "partial": true,
      "results": [],
      "provenance": "Raw per-tool-call results are not persisted in a queryable store (CIT-121, E12, not yet built). This section is derived from tool-call governance findings and node final outputs only; it is never backfilled from CloudWatch logs."
    },
    "findings": [],
    "usageTotals": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "callCount": 0 },
    "traceIds": { "correlationId": "<executionId|conversationId>" }
  }
}
```

### Stability rule

`schemaVersion` is semver and additive-safe: new optional fields never
require a bump. A breaking change to an existing section's shape forces a
**major** version bump, so downstream consumers (CIT-100/104/126/143) can
pin to a major and upgrade deliberately.

## Honest gap — `toolResults` (CIT-121)

Raw per-tool-call result payloads are **not persisted in a queryable store
today**. What this package sources instead: (a) the node's final output
(which may embed tool output), and (b) tool-call governance findings (that
a tool ran + its governance decision). `sections.toolResults` is therefore
always `{ partial: true, results: [], provenance: "..." }` in this pass.

This is deliberate and documented, not an oversight: CloudWatch logs are
**never** read to backfill this gap, because logs are not a reproducible
artifact and would pull unredacted data outside this pipeline's
sanitisation guarantee. The dedicated tool-execution ledger that would make
`toolResults` non-partial is tracked as **CIT-121 (E12)**, not yet built.
When CIT-121 lands, this section's `results` array gains real entries while
`partial`/`provenance` stay additive-compatible — no `schemaVersion` bump
required for that specific change, since it's purely additive to an
already-nullable/partial field.

## Conversation-kind (`kind: "conversation"`)

`GET /replay/by-conversation/{conversationId}` assembles the SAME versioned
envelope, through the SAME deep sanitisation + fail-closed secret gate, the
SAME ownership resolution (`resolveConversationOwnership`), the SAME
presigned GET (≤300s), and the SAME dedicated bucket as execution-kind.
Only the section *sources* differ.

**Feasibility basis** (read directly, cited in
`replay-package-builder.ts`'s module header):

- `conversationId == projectId` — `resolveConversationOwnership` resolves
  ownership via `PROJECTS_TABLE.GetItem(Key={id: conversationId})`
  (`backend/src/lambda/utils/trace-http-shared.ts`).
- Messages are queryable: `CONVERSATIONS_TABLE` (`backend/lib/backend-stack.ts`
  `conversationsTable`) is keyed `projectId` (partition) / `timestamp`
  (sort) — the same query shape `conversation-resolver.ts`'s
  `getConversationHistory` already uses.
- Usage/cost is queryable: `service/agent_intake_single/tools/state.py`'s
  `publish_usage_event` stamps `projectId: session_id` on every
  `agent_intake.usage` event; `cost-ledger-writer.ts`'s `handleIntakeUsage`
  path persists those rows with `GSI1PK = PROJECT#<projectId>` on the cost
  ledger's `ProjectIndex` GSI — a real, queryable, org-scoped join.
- Governance findings do **not** join: the governance ledger keys findings
  on `workflowId` (== `orchestrationId`), and nothing ties a
  conversationId/projectId to an orchestrationId. `sections.findings` is
  therefore an explicit partial section for conversation kind — never
  invented, never guessed from an unrelated row.
- `agentConfig`/`workflow`/`execSpec`/`modelConfig` are execution-scoped
  concepts with no conversation-side row to read — they are `null` for
  conversation kind (genuinely absent, not partial).

### What it contains

| Section | Conversation kind |
|---|---|
| `sections.messages` | Transcript rows from `CONVERSATIONS_TABLE`, queried by `projectId`, in chronological order. |
| `sections.usageTotals` | Aggregated `{inputTokens, outputTokens, totalTokens, callCount}` from the cost ledger's `ProjectIndex` GSI. |
| `sections.findings` | `{ partial: true, results: [], provenance: "..." }` — no join key from conversationId to orchestrationId. |
| `sections.toolResults` | `{ partial: true, results: [], provenance: "..." }` — same CIT-121 gap as execution kind. |
| `sections.agentConfig` / `workflow` / `execSpec` / `modelConfig` | `null` — no conversation-side equivalent. |
| `sections.nodes` | `[]` — nodes are an execution-kind concept. |

### What it does NOT contain

- Per-node execution detail (nodes are execution-scoped; a conversation may
  span zero or many executions with no join recorded).
- Governance findings (no join key exists — see above).
- Raw per-tool-call results (CIT-121, same gap as execution kind).

Cross-org protection, sanitisation, and the fail-closed gate apply
**identically** to this path: every message row and every cost-ledger row
is filtered by the caller-resolved `orgId` (`CrossOrgRowError` on mismatch),
and the assembled bundle is sanitised and gate-checked before any S3 write.

### Frontend

The Observability waterfall page (`frontend/src/pages/Observability.tsx`)
already dispatches `replayService.getByConversation(id)` for
`conversation`-kind deep links — this was wired ahead of the backend route
being functional (it previously received a 404 from the backend's
`ReplayNotFoundError`). No frontend change was required to close this gap;
the existing "Download replay package" button now succeeds for
conversation-kind deep links.


## Eval ingestion contract (E10 / CIT-100)

A replay package must be ingestible by CIT-100 ("promote a production
execution to an eval case") **unchanged** — no transformation step between
"download replay package" and "eval fixture." Consumers should:

1. Pin to a `schemaVersion` major.
2. Never assume `toolResults.results` is non-empty — always check `partial`.
3. Treat `producerCommit: null` as "unknown provenance," not an error — it
   is only populated when the deploying CI pipeline sets `COMMIT_SHA`.

## Deep links

- Execution inspection (`ExecutionDetailSheet`): a "Download replay
  package" button next to "View trace," rendered whenever the caller
  supplies `onDownloadReplay` (owner-only enforcement happens server-side).
- Waterfall (`Observability` page): the same button renders above the
  waterfall for `execution`/`conversation` deep links (never for the raw
  `traceId` kind, which has no ownership entry-key and therefore no replay
  route).
- Both surfaces degrade gracefully on a gate refusal or a 403: an honest
  toast message, never a crash.
