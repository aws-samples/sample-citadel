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
