# Tool-Call Idempotency

Makes a **governed worker tool call** exactly-once and safe under a reservation
race, using an org-scoped, TTL'd DynamoDB ledger, a worker
`dispatchGeneration` fence, and CMK-encrypted S3 offload of oversized results.

> History: PR1 shipped canonicalization + ledger + reserve/execute/finalize
> (exactly-once *within an attempt*). PR2 landed the `dispatchGeneration`
> fence, the S3 result offload, and client-token passthrough — completing the
> capability. The guarantee below is the current, post-fence statement.

## What is guaranteed — stated precisely

- **Exactly-once execution of a side effect is GUARANTEED for calls that resolve
  to the same idempotency key** — SQS/redelivery, same-attempt SDK/Strands
  retries, and concurrent split-brain with identical keys. The reservation's
  conditional first-write-wins is the mechanism: one caller wins and executes;
  every other caller is absorbed (recorded result) or bounced with a
  **retryable no-execution error** and never executes.
- **Exactly-once across a watchdog re-dispatch is GUARANTEED for workflow-node
  tool calls** (the case PR1 could not close). The step runner increments a
  per-node `dispatchGeneration` on every conditional `pending→running`
  transition; the worker carries the generation it was dispatched under; and
  the reserve is a `TransactWriteItems` whose fence — a `ConditionCheck` on the
  execution row's `nodeResults.<nodeId>.dispatchGeneration`, evaluated in the
  **same atomic write** as the reserve `Put` (no read-then-check TOCTOU
  window) — **refuses a stale (re-dispatched-away) worker before any side
  effect** (`StaleWorkerFencedError`). So a stalled-but-alive original worker
  and a nondeterministic re-dispatch body can no longer both reach an adapter:
  only the current generation's worker executes.
- **Reservation-race safety**: the concurrent loser bounded-polls for the
  winner's result, then returns a retryable error — it never runs the tool. A
  dead holder is reclaimed via a conditional CAS.
- **Faithful replay of large results**: an oversized result is offloaded to a
  CMK-encrypted, org/execution-prefixed S3 object (not truncated), so a
  deduped caller receives the FULL recorded body. The stored `resultRef` is
  re-checked against the caller's org prefix on read (`CrossOrgResultRefError`).

## What is still NOT guaranteed (and why)

- The fence covers tool calls that flow through the ledger **inside the fence
  envelope**. Two paths deliberately opt out and are therefore NOT
  generation-fenced (they retain exactly-once-within-attempt + reservation-race
  safety only):
  - a **supervisor task** tool call (no execution/node/generation context —
    the fence has nothing to evaluate against); and
  - a tool flagged `idempotency.mode='bypass'` (read-only; skips the ledger,
    and therefore the fence). A side-effecting tool mis-flagged `bypass` loses
    both dedupe and the fence — which is why the fail-safe default is `ledger`
    and the write-verb-in-bypass guard blocks in strict enforcement.
- Fence soundness is a JOINT property of the atomic reserve-before-execute seam
  ∧ no bypass path ∧ a generation actually threaded. It is not a standalone
  guarantee for a call that never reserves.
- Concurrent-loser *result delivery* (not *execution*) remains best-effort.

## Client-token passthrough (optional, per tool)

For a target that supports an end-to-end idempotency token, the idempotency
hook injects one **server-side, AFTER canonicalization** (so it never perturbs
the `argsHash`) and **overwrites any model-supplied value** (so the model
cannot impersonate another org's idempotency namespace). The token is
`sha256(pk|sk)` — deterministic per logical call (a retry re-derives it) and
org-scoped via the `orgId#executionId` partition key. Wiring is gated by a
per-tool `idempotency.clientTokenParam` config.

Inventory note (grounded in the code, not assumed): no existing adapter —
neither the agent-source import adapters nor the integration adapters — reads a
client/idempotency token today. The single server-controlled chokepoint that
sees both the derived key and the tool input is the hook, so injection lives
there; `clientTokenParam` is the forwarding contract for a tool/target that
supports it.

## Key derivation

`argsHash = sha256(canonicalize(toolInput))`. Canonicalization rejects
non-string dict keys deterministically, collapses integral floats and `-0.0`
(`2.0 == 2`, `-0.0 == 0`), rejects `NaN`/`Infinity`, and preserves `null`
(`{"a": null}` never equals `{}`). Dispatch generation is deliberately NOT in
the key — putting it there would mint a fresh key on every re-dispatch and
guarantee duplicates.

## Ledger table

`citadel-tool-execution-ledger-{env}` — PK `orgId#executionId`, SK
`nodeId#callIndex#toolName#argsHash`, TTL attribute `ttl` (48h, derived from the
**server** write time, not a producer clock). It is an **operational dedupe**
table, **NOT an audit artifact** (distinct from the 90-day governance ledger).
`orgId` is resolved server-side from the execution row — never trusted from a
subprocess payload — so the PK prefix gives structural cross-org isolation.

Worker IAM is least-privilege: `PutItem` / `GetItem` / `UpdateItem` on this one
table only — no `DeleteItem` (release is a status transition), no `Scan`/`Query`.

## Failure matrix

| Outcome | Ledger action | Retryable | Re-executed? |
|---|---|---|---|
| Success | `completed` + result | — | No (replay returns recorded result) |
| Terminal (4xx / `applied`) | `failed` | No | No (replay returns recorded failure) |
| Retryable, provably not sent | `released` | Yes | Yes (next attempt re-reserves) |
| Unknown outcome (5xx/timeout after send, un-tokened) | `failed`, `outcomeIndeterminate` | No | **Never** — fail-safe, surfaced |

## Strands seam

Verified against `strands-agents==1.30.0`: there is no `AgentToolHandler`;
`Agent.__init__` takes `hooks: list[HookProvider]`. The single atomic seam is a
`BeforeToolCallEvent` hook that replaces `selected_tool` with a wrapper whose
`stream()` runs reserve → execute → finalize in one coroutine (no pre/post
window). The synchronous `execute_idempotent` coordinator is the unit-tested
authority for the invariant.

## Manual smoke procedure (non-prod only)

Everything above is unit-tested against fakes. Nothing in the deployed system
previously exercised the seam through a real workflow dispatch — the seam only
installs for a workflow-dispatched node (`CITADEL_EXECUTION_ID`/
`CITADEL_NODE_ID` set), and the one pre-existing seeded runnable agent
(`demo-echo-agent`) has `tools: []`, so it never reached
`_install_idempotency_hook`'s tool-wrapping path in practice.

A dedicated, non-prod-only diagnostic fixture closes that gap:

- **Smoke tool**: `smoke_write_marker`, defined inline in
  `arbiter/seedConfig/smoke_idempotency_agent.py`. It declares no
  `idempotency` config, so `classify_idempotency_mode` fail-safes it to
  `MODE_LEDGER` (side-effecting, never bypassed) — independently reinforced
  by production wiring, since `agent_runner._install_idempotency_hook` never
  passes a `mode_resolver` at all. Each execution that actually runs appends
  one row — keyed by a **freshly minted `uuid.uuid4()`**, never a
  deterministic id — to a dedicated `citadel-smoke-idempotency-{env}`
  DynamoDB table (org-scoped PK, 24h TTL). A duplicate execution is visible
  as a **second row**, never a silent overwrite.
- **Smoke agent**: `smoke-idempotency-agent`, seeded by
  `arbiter/seedConfig/index.py` alongside `demo-echo-agent`, gated on
  `SMOKE_FIXTURES_ENABLED` (set by CDK only when `props.environment !== "prod"`
  in `backend/lib/arbiter-stack.ts` / `backend-stack.ts`). It carries exactly
  the one smoke tool.
- **Smoke workflow**: "Idempotency Smoke Workflow", a single-node blueprint
  seeded by `backend/src/lambda/seed-blueprints/index.ts` under the same gate,
  whose one node dispatches `smoke-idempotency-agent`.
- **Table + IAM**: `SmokeIdempotencyTable` in `backend/lib/arbiter-stack.ts`,
  created only in non-prod. The worker's grant on it is `dynamodb:PutItem`
  ONLY — no Get/Query/Scan/Update/Delete, no wildcard, no path to any
  product table.

### Procedure

1. In a **non-production** environment, open the Workflows tab and Run
   "Idempotency Smoke Workflow" (it will already be published — seeded
   `PUBLISHED`, matching the Echo Demo Workflow's seed pattern).
2. **Check the `WorkerAgentWrapper` CloudWatch log group** for the one node's
   invocation. You should see the idempotency hook's reserve→execute→finalize
   pair for the `smoke_write_marker` tool call — no `StaleWorkerFencedError`,
   no `RetryableNoExecutionError`, one `finalize_success`.
3. **Check the tool-execution ledger table**
   (`citadel-tool-execution-ledger-{env}`) for exactly **one** row keyed by
   this execution/node/call-index/tool-name/argsHash, `status = completed`,
   with a `ttl` attribute set (48h out).
4. **Check the smoke table** (`citadel-smoke-idempotency-{env}`) for exactly
   **one** row — a fresh `markerId` uuid, `orgId`, `writtenAt`, and `ttl` (24h
   out). One row = the fence held for a normal, non-retried run.

### Exercising the fence (forced retry / re-dispatch)

To prove the `dispatchGeneration` fence actually holds under a re-dispatch
(not just a normal run):

1. Trigger a re-dispatch of the smoke node — either let the workflow timeout
   watchdog re-dispatch it (reduce the node's timeout for this one test run),
   or manually force a re-dispatch via the same mechanism used to test the
   fence elsewhere (bump the execution row's
   `nodeResults.<nodeId>.dispatchGeneration` and re-invoke the worker with the
   OLD generation to simulate a stale, still-running worker).
2. **Confirm no second smoke row appears** in `citadel-smoke-idempotency-{env}`
   — the stale worker must be refused at the reserve fence
   (`StaleWorkerFencedError`) BEFORE it ever calls `smoke_write_marker`, so no
   second `PutItem` happens.
3. **Confirm the ledger still shows exactly one `completed` row** for the
   original (current-generation) call, and that a legitimate retry under the
   SAME key (not a re-dispatch — an in-attempt retry) returns the **recorded
   result** rather than executing again: the tool's response should echo the
   ORIGINAL `markerId`, not a new one, proving the replay path
   (`_recorded_result`) served the cached success rather than re-running the
   tool.
4. If either check fails (a second smoke row appears, or a retry's `markerId`
   changes), the fence did not hold — file a finding against
   `arbiter/workerWrapper/tool_idempotency_hook.py` /
   `arbiter/governance/tool_execution_ledger.py`, not against the smoke
   fixture itself (the fixture's only job is to make the failure visible).
