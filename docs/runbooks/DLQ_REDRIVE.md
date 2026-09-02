# DLQ Redrive Runbook — Per-Consumer Safety Classification

On-call procedure for triaging and redriving dead-letter-queue messages,
per consumer. This runbook supersedes the one-line "identify the queue,
read the message, fix the handler, redrive" guidance formerly in the A4 row
of [../OBSERVABILITY.md](../OBSERVABILITY.md).

**Golden rule: the redrive matrix in §3 decides whether you redrive first
or reconcile first. Never blind-redrive a consumer in the reconcile-first
list.**

## 0. Deployment-state legend (read this first)

This runbook is written against the fully hardened state of the DLQ
substrate: shared per-stack async DLQs (`feat/eventbridge-shared-dlqs`, PR
102) and supervisor/fabricator dedupe (`feat/agent-event-idempotency`, PR
103) have both merged to `main`. All procedures below reflect current
production state — there is no partial-deployment caveat to track.

```bash
export ENV=dev            # or your environment suffix
export REGION=<region>
```

## 1. Alarm → triage entry point

Two paging alarms watch DLQ depth (both `→ citadel-alarms-${ENV}` SNS, see
§6 for the last-mile caveat):

- `citadel-dlq-not-empty-${ENV}` — sum of
  `ApproximateNumberOfMessagesVisible` across the seven pre-existing
  work/stream/notifier DLQs (explicit list in
  `backend/lib/telemetry-stack.ts`; CloudWatch rejects a Metrics-Insights
  `LIKE` filter at alarm create, so the list is explicit and
  drift-guarded).
- `citadel-dlq-not-empty-shared-${ENV}` — same expression over the
  seven per-stack shared async DLQs. Split into two alarms to stay
  within CloudWatch's metric-math operand limit. The drift
  guard is structural: `backend/lib/__tests__/dlq-coverage-structural.test.ts`
  discovers every DLQ from the synthesized templates and fails if any is
  unalarmed.

When either fires:

1. Find the non-empty queue(s):

   ```bash
   for q in $(aws sqs list-queues --queue-name-prefix citadel- --region $REGION \
              --query 'QueueUrls[]' --output text); do
     n=$(aws sqs get-queue-attributes --queue-url "$q" --region $REGION \
         --attribute-names ApproximateNumberOfMessagesVisible \
         --query 'Attributes.ApproximateNumberOfMessagesVisible' --output text)
     [ "$n" != "0" ] && echo "$n  $q"
   done
   ```

2. Peek at a message **without consuming it permanently** (reading raises
   the receive count; the message returns after the visibility timeout):

   ```bash
   aws sqs receive-message --queue-url "$DLQ_URL" --region $REGION \
     --max-number-of-messages 1 --visibility-timeout 60 \
     --attribute-names All --message-attribute-names All --output json
   ```

3. Identify the owning consumer:
   - **Work-queue DLQs** (worker-agent / fabricator / eval-dispatch): the
     queue itself names the consumer — see §2.
   - **Function async DLQs**: the message body is the **raw EventBridge
     envelope** (Lambda `DeadLetterConfig` is used rather than `onFailure`
     destinations). Map the envelope's `source` /
     `detail-type` to the consumer via §2's table. The SQS message
     attributes carry `RequestID` / `ErrorCode` / `ErrorMessage` from the
     failed invocation.
   - **Stream DLQs**: pointers, not payloads — go straight to §3.3.
4. Look up the consumer in the §3 matrix and follow its row.

## 2. Queue inventory → owning consumer

### Work-queue DLQs (SQS redrive policy)

| DLQ (retention 14d) | Source queue | Consumer | Queue config |
|---|---|---|---|
| `citadel-worker-agent-dlq-${ENV}` | `citadel-worker-agent-queue-${ENV}` | workerAgentWrapper (`arbiter/workerWrapper/`) | visibility 15m, retention 7d, maxReceiveCount 3 |
| `citadel-fabricator-dlq-${ENV}` | `citadel-fabricator-queue-${ENV}` | fabricator (`arbiter/fabricator/index.py`) | visibility 90m (6× fn timeout), retention 7d, maxReceiveCount 3 — a poison message needs up to ~4.5h to reach the DLQ (documented tradeoff in `backend/lib/arbiter-stack.ts`, fabricatorQueue) |
| `citadel-eval-dispatch-dlq-${ENV}` | `citadel-eval-dispatch-${ENV}` | eval-conversation-worker (`backend/src/lambda/eval-conversation-worker.ts`) | visibility 15m, retention 7d, maxReceiveCount 3 |

### Target/function DLQs

| DLQ | Feeds from | Consumer |
|---|---|---|
| `citadel-governance-notifier-dlq-${ENV}` | EB target DLQ **and** Lambda async DLQ (both mechanisms) | governance-notifier (`backend/src/lambda/governance-notifier.ts`) |
| `citadel-registry-sync-dlq-${ENV}` | EB target DLQ + app-level `sendToDlq()` on handler error | registry-sync (`backend/src/lambda/registry-sync.ts`) |

### DynamoDB-stream DLQs (ESM `onFailure`)

| DLQ | Consumer | Payload type |
|---|---|---|
| `citadel-governance-graph-snapshot-on-change-dlq-${ENV}` | governance-graph-snapshot-on-change (4 ESMs over the authority tables) | **shard/sequence pointers — see §3.3** |
| `citadel-governance-finding-fanout-dlq-${ENV}` | governance-finding-fanout (ledger-table stream) | **pointers — see §3.3** |

### Shared per-stack async DLQs

One queue per stack (`citadel-<stack>-async-dlq-${ENV}`, 14d retention,
SQS-managed SSE, enforceSSL); every EventBridge-invoked Lambda in that
stack sets it as its `DeadLetterConfig`. Envelope `source`/`detail-type` →
consumer:

| DLQ | Consumers (event source ⇒ handler) |
|---|---|
| `citadel-arbiter-async-dlq-${ENV}` | `task.request` / `task.completion` ⇒ **supervisor** (§3.2); `agent.activate` ⇒ activator; `execution.start.requested`, `workflow.node.completed/failed`, cancel/resume ⇒ stepRunner; 5m schedule ⇒ workflow-timeout watchdog; daily cron ⇒ governance-graph-snapshot; governance mode transition ⇒ governance-mode-refresher |
| `citadel-backend-async-dlq-${ENV}` | 6h schedule ⇒ reconcile-apps-meta; catalog sync (24h + on-demand) ⇒ model-catalog-sync; `integration.connect/disconnect` ⇒ **gateway-registration-handler** (§3.2); `agent.fabricated`/`tool.fabricated` ⇒ app-component-registration; `message.sent_to_agent` ⇒ **agent-message-handler** (§3.2); `app.invoke.requested` ⇒ app-invoke-handler; `workflow.*` ⇒ workflow-progress-fanout |
| `citadel-telemetry-async-dlq-${ENV}` | `task.completion` / `intake.usage.captured` / `workflow.node.completed` / `eval.usage.captured` ⇒ cost-ledger-writer; hourly ⇒ cost-ledger-reconciler, cost-budget-evaluator, eval-drift-detector; eval case/sample/run events ⇒ eval-case-scorer, eval-sample-scorer, eval-run-aggregator, eval-sampling-selector, eval-drift-finding-writer |
| `citadel-governance-async-dlq-${ENV}` | 1m schedule ⇒ agent-release-rollback-evaluator; `workflow.completed/failed` + 5m sweep ⇒ eval-runner |
| `citadel-registry-async-dlq-${ENV}` | manifest result ⇒ agent-import-manifest-result-handler; `agent.fabricated/.failed` ⇒ fabrication-event-handler |
| `citadel-projects-async-dlq-${ENV}` | all-bus chatter ⇒ chatter-publisher; `intake.progress.updated` ⇒ project-progress-updater; assessment/design events ⇒ assessment-completion-notifier, design-progress-notifier |
| `citadel-services-async-dlq-${ENV}` | 1m schedule ⇒ document-ingest-poller; 15m schedule ⇒ health-monitor |

The supervisor's `TaskRequestRule`/`TaskCompletionRule` targets also carry
an explicit `RetryPolicy` (2 attempts, 2h max event age), so a
failing supervisor event reaches the arbiter DLQ in minutes instead of
after EventBridge's 24h/185-attempt default retry storm.

## 3. Per-consumer redrive matrix

### 3.1 SAFE-TO-REDRIVE — idempotent by construction, redrive directly

Redrive using the matching mechanic in §4, then run the row's verify step.
Grounding for every verdict is the consumer's own guard, cited by file.

| Consumer | Why redrive is a no-op for already-applied work | Caveat | Verify after redrive |
|---|---|---|---|
| cost-ledger-writer | Conditional put `attribute_not_exists(PK)`; ConditionalCheckFailed swallowed (`backend/src/lambda/cost-ledger-writer.ts`) | — | Ledger rows present for the redriven window; `citadel-cost-drift-high-${ENV}` stays OK |
| app-invoke-handler | `event.id` dedupe via `citadel-idempotency-${ENV}` (`backend/src/lambda/app-invoke-handler.ts`) | — | Invocation recorded once; no duplicate app run |
| project-progress-updater | Idempotency-table guard (`backend/src/lambda/project-progress-updater.ts`) | — | Progress state correct in UI |
| eval-sampling-selector; eval-case-scorer; eval-sample-scorer; eval-run-aggregator; eval-drift-finding-writer | Shared idempotency guard / single-writer idempotent `SET` / write-once finding (respective files under `backend/src/lambda/`) | — | Eval run/case rows show no double-count |
| eval-runner | Completion routes into the `completionRecorded` conditional in `backend/src/lambda/eval-run-completion.ts`; timeout sweep is no-op-safe | — | Run status terminal exactly once |
| registry-sync | Conditional put: only if record absent or incoming `updatedAt` newer (`backend/src/lambda/registry-sync.ts`) — a stale redrive cannot resurrect old cache state | — | Registry cache rows carry the newest `updatedAt` |
| stepRunner (all detail-types) | Server-side frontier re-derivation from persisted state; terminal-status idempotency; timeout watchdog reconciles lost events (`arbiter/stepRunner/`) | — | Execution reaches a terminal status; watchdog alarm quiet |
| worker-agent dispatch (`citadel-worker-agent-dlq-${ENV}`) | `CITADEL_DISPATCH_GENERATION` fence rejects stale-generation writes; tool-idempotency ledger replays recorded results (`arbiter/workerWrapper/agent_runner.py`, `tool_idempotency.py`) | Redrive still **burns a model turn**; its writes are fenced | Node completes; no duplicate side effects in tool ledger |
| eval-dispatch (`citadel-eval-dispatch-dlq-${ENV}`) | `recordCaseCompletion` conditional `attribute_not_exists(completionRecorded)` (`backend/src/lambda/eval-run-completion.ts`) | Redrive **re-invokes the target agent** (token cost, duplicate transcript row); rollup/decrement stays single-count | Case terminal once; run aggregate correct |
| Notifier relays: governance-notifier, chatter-publisher, assessment/design notifiers, workflow-progress-fanout | Stateless AppSync publishes | Redrive = duplicate UI notification only | Subscribers received the event |
| All scheduled sweeps (watchdog, reconciler, budget evaluator, drift detector, health monitor, ingest poller, model-catalog sync, reconcile-apps-meta, graph snapshot) | Next tick self-heals; each run re-derives from source state | **Don't redrive** — envelopes with `source: aws.events` cannot be re-published as-is (§4.2). Confirm the next scheduled run succeeded, then delete the DLQ message | Next tick's invocation succeeded (CloudWatch logs) |

### 3.2 RECONCILE-FIRST — do the reconcile step BEFORE any redrive

#### supervisor (`task.request` / `task.completion` → `citadel-arbiter-async-dlq-${ENV}`)

The supervisor dedupes via a conditional-put claim on the
EventBridge envelope `id` (`_claim_event_id` in
`arbiter/supervisor/index.py`; row `{eventId, consumer: "supervisor", ttl:
+7d}` in `citadel-idempotency-${ENV}`) at handler entry, **before** any
side-effecting work. Consequences for redrive:

- The claim is written before dispatch, so a failure mid-orchestration
  leaves the `eventId` **already claimed**. Re-invoking with the original
  envelope (§4.3, same `id`) is then a safe **no-op** — it will not
  reprocess until you clean the row.
- Re-publishing via `PutEvents` (§4.2) mints a **new** envelope `id`, so
  the dedupe ledger will NOT suppress it.
- Claims expire after 7 days (TTL) — a redrive after expiry reprocesses.

Procedure:

1. Extract `detail.orchestration_id` (task.completion) or the request
   payload (task.request) from the DLQ envelope.
2. Check orchestration state in the supervisor's orchestration table
   (physical name via
   `aws lambda get-function-configuration --function-name <supervisor fn, §4.5> --query 'Environment.Variables.ORCHESTRATION_TABLE'`).
   If the orchestration already completed / the continuation already ran:
   **delete the DLQ message, do not redrive.**
3. If work is genuinely missing: check the claim row
   (`§4.4 get-item` on the envelope `id`).
   - Row exists (failure happened after the claim): after confirming step 2,
     delete the row (§4.4), then re-invoke with the original envelope
     (§4.3) so the original `id` is re-claimed atomically.
   - No row (failure before the claim, e.g. DynamoDB throttle on the claim
     itself — the guard rethrows those): re-invoke directly (§4.3).
4. Verify: exactly one new dispatch per pending node
   (`citadel-worker-agent-queue-${ENV}` depth / worker logs); orchestration
   row advances; no duplicate worker results.

#### fabricator (`citadel-fabricator-queue-${ENV}` — SQS, not EventBridge)

Duplicate fabrication is the documented historical failure mode (see the
fabricatorQueue comment block in `backend/lib/arbiter-stack.ts`), and a
poisoned-then-fixed message may have **partially fabricated** (registered
agents/tools, created roles) before failing.

The fabricator uses a **two-phase claim keyed on the SQS `messageId`** (the
fabricator queue carries hand-built JSON bodies with no EventBridge
envelope, so there is no `event.id` — see the module comment in
`arbiter/fabricator/index.py`): `PENDING` written before fabrication,
promoted to `DONE` after success (`_claim_message_id` /
`_complete_message_id`).

**Poison messages no longer reach `citadel-fabricator-dlq-${ENV}`.**
Lifecycle of a message that crashes *inside* fabrication: receive #1 writes
`PENDING` and dies → visibility timeout (90m) → receive #2 sees
`ALREADY_PENDING` → logs a warning ("redelivered while a prior attempt is
still PENDING … see docs/runbooks/DLQ_REDRIVE.md") and **acks the message**
(it is deleted, never accruing the 3 receives the redrive policy needs).
The durable trace of the failure is therefore the **stale `PENDING` ledger
row, not a DLQ message**. Exceptions that still three-strike into the DLQ:
failures **before** the claim — an unparseable body (`json.loads` runs
before the claim in `lambda_handler`) or sustained Lambda throttling where
the handler never runs.

**Paging alarm (board 2b52a985):** every ALREADY_PENDING ack also emits one
`CitadelArbiter/FabricatorStalePendingClaim` CloudWatch metric (Count,
dimension `Consumer=fabricator`) from `_route_to_reconcile` in
`arbiter/fabricator/index.py`. `citadel-fabricator-stale-pending-claim-${ENV}`
(`backend/lib/arbiter-stack.ts`) alarms on `Sum > 0` over a 5-minute period
and routes through the same operational alarm-delivery path as
`FabricatorErrorAlarm` (`props.alarmTopic` → `citadel-alarms-${ENV}` SNS).
This is the paging trigger for the section below — you no longer have to
notice the stale row on your own; on page, go straight to the scan.

Triage anchor — scan for stale PENDING rows:

```bash
aws dynamodb scan --table-name citadel-idempotency-$ENV --region $REGION \
  --filter-expression "consumer = :c AND #s = :p" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":c":{"S":"fabricator"},":p":{"S":"PENDING"}}'
```

A `PENDING` row older than one visibility window (~90m; compare
`claimedAt`, epoch seconds) is a fabrication that started and never
completed. (A row can also stick at `PENDING` if fabrication *succeeded*
but the final `DONE` promotion failed — step 1 below distinguishes the
two.)

Reconcile, then re-dispatch:

1. Determine what the attempt actually did: the
   `citadel-fabrication-jobs-${ENV}` status row
   (PROCESSING/COMPLETED/FAILED), registry records for the requested
   agents/tools, and `agent.fabrication.failed` events /
   FabricatorErrorAlarm. In-run recovery of orphaned `CREATING` registry
   records is handled by `arbiter/fabricator/registry_recovery.py`; anything
   it could not recover must be cleaned by hand (delete duplicate/orphaned
   registry records and any roles the run seeded).
2. If fabrication actually completed: clean the row (§4.4) and stop.
3. If it partially fabricated: finish the cleanup from step 1 first.
4. **Operator row-clean:** delete the `PENDING` row (§4.4). Never skip
   step 1–3 before this.
5. Re-dispatch by sending a **new** message to
   `citadel-fabricator-queue-${ENV}` with the original body (a new
   `messageId` gets a fresh claim). For messages that did land in the DLQ
   (pre-claim failures), a plain §4.1 redrive is fine once the body defect
   is fixed — the two-phase ledger protects against double-fabrication
   either way.
6. Verify: `PENDING` row for the new attempt promotes to `DONE`; exactly
   one set of registry records; no repeat of the reconcile warning in the
   fabricator's log group.

#### gateway-registration-handler (`integration.connect` / `disconnect` → `citadel-backend-async-dlq-${ENV}`)

Order-sensitive with **no version guard**
(`backend/src/lambda/gateway-registration-handler.ts` creates/deletes
gateway targets and credential providers): replaying a stale `connect`
after a later `disconnect` **resurrects a removed target**.

1. Read the envelope's integration id; check the integration record's
   current status (integrations table / UI).
2. Redrive (§4.2) **only if** the event is consistent with the current
   desired state (e.g. a `connect` for an integration that should be
   connected). Otherwise delete the DLQ message and, if the live gateway
   state is wrong, fix it through the normal integration
   connect/disconnect flow instead.
3. Verify: gateway target list matches the integration record's status.

#### agent-message-handler (`message.sent_to_agent` → `citadel-backend-async-dlq-${ENV}`)

Appends conversation rows and dispatches live agent invocations
(`backend/src/lambda/agent-message-handler.ts`): a redrive can produce a
**duplicate user-visible agent response plus duplicate model cost**.

1. From the envelope, identify the conversation and check whether a
   response for that message was already stored/delivered.
2. Redrive (§4.2) only if no response exists; otherwise delete the message.
3. Verify: exactly one response row for the message in the conversation.

#### Default reconcile-first (idempotency not yet proven)

`app-component-registration-handler`, `fabrication-event-handler`,
`agent-import-manifest-result-handler`, `activator`,
`governance-mode-refresher` — payload-derived writes with no verified
dedupe/version guard. Treat as reconcile-first: inspect the target rows the
event would write, redrive only if absent. Proving each idempotent (they
are individually small) is follow-up work; promote them to §3.1 as that
lands.

### 3.3 Stream DLQs — pointers, NOT payloads: re-derive, never "redrive"

Messages in `citadel-governance-graph-snapshot-on-change-dlq-${ENV}` and
`citadel-governance-finding-fanout-dlq-${ENV}` contain DynamoDB-stream
**shard/sequence-number pointers**, not record payloads. DynamoDB trims
stream records after **24 hours**, after which the pointed-at window is
unrecoverable from the DLQ. There is nothing to move back to a source
queue.

- **graph-snapshot-on-change**: run the daily full-snapshot Lambda manually
  — it is a full reconcile from the authority tables, superseding any lost
  stream window:

  ```bash
  FN=$(aws cloudformation list-stack-resources --stack-name citadel-arbiter-$ENV --region $REGION \
    --query "StackResourceSummaries[?starts_with(LogicalResourceId, 'GovernanceGraphSnapshotFn') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
  aws lambda invoke --function-name "$FN" --payload '{}' --region $REGION /dev/null
  ```

- **finding-fanout**: the ledger row is already durable (write-once ledger);
  only the push notification was lost. The UI's poll path surfaces the
  finding — no action needed beyond confirming the row exists.

Then delete/purge the pointer messages so the DlqNotEmpty alarm clears.

## 4. Redrive mechanics

### 4.1 SQS dead-letter redrive (work-queue DLQs only)

Applies to the three DLQs fed by an SQS `RedrivePolicy`
(worker-agent, fabricator, eval-dispatch). It does **not** work for the
function async DLQs — their "source" is a Lambda, not a queue; use
§4.2/§4.3 for those.

```bash
DLQ_URL=$(aws sqs get-queue-url --queue-name citadel-worker-agent-dlq-$ENV \
          --region $REGION --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --region $REGION \
          --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Move everything back to the source queue (throttled):
aws sqs start-message-move-task --source-arn "$DLQ_ARN" \
  --max-number-of-messages-per-second 5 --region $REGION

# Watch it finish:
aws sqs list-message-move-tasks --source-arn "$DLQ_ARN" --region $REGION \
  --query 'Results[0].[Status,ApproximateNumberOfMessagesMoved,ApproximateNumberOfMessagesToMove]'
```

(Console equivalent: SQS → queue → "Start DLQ redrive".) To redrive only a
subset, receive/inspect/delete the poison ones first, then start the move
task.

### 4.2 Re-publish a function-DLQ envelope to EventBridge

Function async DLQs carry the raw EventBridge envelope, so the redrive is a
verbatim re-publish to the `citadel-agents-${ENV}` bus. **A re-published
event gets a NEW envelope `id`** — the supervisor dedupe will not
suppress it (that is exactly why §3.2 supervisor is reconcile-first).
Envelopes with `source: aws.events` (scheduled rules) cannot be re-published
this way — for sweeps, rely on the next tick (§3.1 last row).

```bash
aws sqs receive-message --queue-url "$DLQ_URL" --region $REGION \
  --max-number-of-messages 1 --output json > msg.json
BODY=$(jq -r '.Messages[0].Body' msg.json)

aws events put-events --region $REGION --entries "[{
  \"EventBusName\": \"citadel-agents-$ENV\",
  \"Source\": $(echo "$BODY" | jq '.source'),
  \"DetailType\": $(echo "$BODY" | jq '."detail-type"'),
  \"Detail\": $(echo "$BODY" | jq '.detail | tostring')
}]"
# Expect FailedEntryCount: 0. Then remove the DLQ copy:
aws sqs delete-message --queue-url "$DLQ_URL" --region $REGION \
  --receipt-handle "$(jq -r '.Messages[0].ReceiptHandle' msg.json)"
```

Note: re-publishing to the bus fans out to **every** rule matching that
`source`/`detail-type` (e.g. `task.completion` feeds both the supervisor
and the cost-ledger-writer; the chatter rule sees everything). The
duplicate deliveries land on consumers covered by §3.1 guards — but confirm
the §3 row of *each* matching consumer before re-publishing.

### 4.3 Direct Lambda re-invoke (preserves the original event `id`)

Use when you specifically want the supervisor dedupe to see the
**original** envelope `id` (§3.2), or to test a fixed handler against the
exact failed payload without bus fan-out:

```bash
jq -r '.Messages[0].Body' msg.json > envelope.json
aws lambda invoke --function-name "$FN" --region $REGION \
  --payload fileb://envelope.json /dev/stdout
```

Delete the DLQ message afterwards (§4.2 last step).

### 4.4 Idempotency-ledger query and row-clean

```bash
# Was this envelope id / messageId already processed?
aws dynamodb get-item --table-name citadel-idempotency-$ENV --region $REGION \
  --key '{"eventId":{"S":"<id>"}}'

# Operator row-clean — ONLY after the §3.2 reconcile steps:
aws dynamodb delete-item --table-name citadel-idempotency-$ENV --region $REGION \
  --key '{"eventId":{"S":"<id>"}}'
```

Rows: supervisor `{eventId, consumer: "supervisor", claimedAt, ttl}`;
fabricator adds `status: PENDING|DONE`. TTL is 7 days — chosen to cover the
realistic triage window, not the 14-day DLQ retention; a redrive after TTL
expiry reprocesses, which is why the §3.2 reconcile checks are ordered
before any redrive.

### 4.5 Resolving physical Lambda names

Most Citadel Lambdas leave `functionName` unset — physical names are
CloudFormation-generated. That's the norm; resolve from the owning stack
(stacks: `citadel-{backend,arbiter,telemetry,governance,registry,projects,services}-${ENV}`):

```bash
aws cloudformation list-stack-resources --stack-name citadel-arbiter-$ENV --region $REGION \
  --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].[LogicalResourceId,PhysicalResourceId]" \
  --output table
```

Supervisor = logical id starting `SupervisorAgent`; fabricator =
`FabricatorAgent`; watchdog = `WorkflowTimeoutWatchdogFunction`; snapshot =
`GovernanceGraphSnapshotFn`.

A handful of Lambdas across the backend stacks pin an explicit
`functionName` (`citadel-<name>-${ENV}`) instead, so their physical name is
predictable without a stack-resource lookup. Of these, two are referenced
by consumer name in this runbook: **app-invoke-handler**
(`citadel-app-invoke-handler-${ENV}`, `backend-stack.ts`) and
**governance-graph-snapshot-on-change**
(`citadel-governance-graph-snapshot-on-change-${ENV}`, `arbiter-stack.ts`,
invoked directly in §3.3). The remaining pinned exceptions:
cost-ledger-writer, cost-ledger-reconciler, cost-query-handler,
cost-budget-handler, trace-query-handler, replay-package-handler,
cost-budget-evaluator, eval-case-scorer, eval-run-aggregator,
eval-sampling-selector, eval-sample-scorer, eval-sampling-config-resolver,
eval-drift-detector, eval-drift-finding-writer (all `telemetry-stack.ts`);
pdf-generator, document-ingest-start, document-ingest-poller,
health-monitor, tool-sandbox (`services-stack.ts`);
agent-release-rollback-evaluator (`governance-stack.ts`);
registry-agent-record-resolver (`registry-stack.ts`);
app-publish-handler (`gateway-stack.ts`); pre-token-gen (`backend-stack.ts`).
For any of these, skip the stack-resource lookup and use
`citadel-<name>-${ENV}` directly.

## 5. Post-redrive verification (all consumers)

1. DLQ drains: `ApproximateNumberOfMessagesVisible` returns to 0 and
   `citadel-dlq-not-empty-${ENV}` (and `-shared-`) return to OK.
2. No boomerang: the redriven messages do not reappear in the DLQ after one
   visibility/retry cycle (if they do, the handler defect is not fixed —
   stop and fix before redriving again).
3. The consumer-specific "verify" column/step from its §3 row.
4. Spot-check the idempotency ledger (§4.4): supervisor claims
   present for processed ids; no fabricator row stuck `PENDING`.

## 6. SNS last mile — the alarm may be paging nobody

Both alarm topics — `citadel-alarms-${ENV}` (backend-stack) and
`citadel-governance-escalations-${ENV}` (arbiter-stack) — are provisioned
with **zero subscriptions** in CDK. Unless `ALARM_DELIVERY` was configured
at deploy time (`email | slack | none`, see `backend/.env.example`) or a
subscriber was attached out-of-band, `DlqNotEmpty` transitions to ALARM
"successfully" and notifies no one. Verify per environment (a
`PendingConfirmation` email subscription is equivalent to none):

```bash
TOPIC_ARN=$(aws sns list-topics --region $REGION \
  --query "Topics[?ends_with(TopicArn, ':citadel-alarms-${ENV}')].TopicArn" --output text)
aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region $REGION \
  --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output table
```

Also note: 13 alarm constructs (supervisor/fabricator/stepRunner/watchdog
function-error alarms among them) have **no SNS action at all** —
`DlqNotEmpty*` is the paging path for DLQ-visible failures; the fn-error
alarms are console-only until `alarmTopic` is threaded into
arbiter/projects (tracked separately, out of this runbook's scope).
