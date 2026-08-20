# Tool-Call Idempotency (PR1 of 2)

Makes a **governed worker tool call** exactly-once *within an attempt* and safe
under a reservation race, using an org-scoped, TTL'd DynamoDB ledger.

## What PR1 guarantees — stated precisely

- **Exactly-once execution of a side effect is GUARANTEED for calls that resolve
  to the same idempotency key** — SQS/redelivery, same-attempt SDK/Strands
  retries, and concurrent split-brain with identical keys. The reservation's
  conditional first-write-wins is the mechanism: one caller wins and executes;
  every other caller is absorbed (recorded result) or bounced with a
  **retryable no-execution error** and never executes.
- **Reservation-race safety**: the concurrent loser bounded-polls for the
  winner's result, then returns a retryable error — it never runs the tool. A
  dead holder is reclaimed via a conditional CAS.

## What PR1 does NOT guarantee (and why)

- It is **NOT** exactly-once across nondeterministic re-dispatch. The key is
  attempt-scoped — `(orgId#executionId, nodeId#callIndex#toolName#argsHash)`.
  A watchdog re-dispatch runs a fresh LLM body whose tool calls may reorder or
  reword, yielding *different* keys the ledger cannot recognize.
- Closing that gap requires a **worker `dispatchGeneration` fence** (a stale
  re-dispatched worker refused at reserve time). That fence is **DEFERRED to
  PR2** and is **REQUIRED for the complete guarantee**. Do not read PR1 as the
  complete exactly-once guarantee.

Also deferred to PR2: S3 offload of oversized results (PR1 records a
deterministic marker instead), and client-token passthrough to adapters that
support end-to-end dedupe.

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
