# Approval-Required Tool Gating (v1: check-and-refuse)

Finding c947aa77. Implements a governance gate that **refuses** a designated
("gated") tool call at dispatch time unless a **valid, pre-granted, single-use
approval** already covers it.

## ⚠️ What v1 is NOT

**In-flight / mid-run approval is UNSUPPORTED.** This is **check-and-refuse**
(decision 6ac67191), not pause-and-resume. There is **no human-in-the-loop
pause**: a gated tool call that lacks a valid pre-existing approval is
**refused** — the agent subprocess cannot pause its turn to wait for a human to
approve, and the workflow does not park in an `awaiting_approval` state. The
approver must grant the approval **ahead of time**; a human granting an approval
**during** a run does not unblock the in-flight call — grant, then re-run.

Do not describe or market v1 as "request-and-approve" or a "human-in-the-loop
pause". It is a **pre-authorization gate**.

## Model

An approval is **pre-grantable** per the FULL tuple
`(orgId, workflowDefinitionId, nodeId, toolName)` (decision f0056afe):

- **NOT per execution** — the executionId is unknown before dispatch, so an
  approval cannot be scoped to it at grant time.
- **NOT per tool** — a bare `(tool)` grant would be a standing bearer grant
  usable by any workflow/node/org.

The grant carries a short **application validity** (`expiresAt`) that is
**distinct** from the DynamoDB **retention** attribute (`ttl`, 90 days). The
`ttl` keeps the audit row for accountability long after the approval stops
being usable; validity is checked in application code. **These are never
conflated** — a TTL deletion must never be the mechanism that "expires" an
approval, and an expired approval must never delete the audit record.

**Single-use consumption** (decision f0056afe): the first execution to use a
grant atomically **consumes** it (a conditional first-write-wins `PutItem` of a
consumption marker keyed by the grant tuple, recording the consuming
`executionId`). Two concurrent executions can never both consume one approval —
the loser is refused. A consumed grant is spent; a re-run needs a fresh grant.

`findingId` derives from the **full tuple** via SHA-256 (no prefix matching):
any two distinct tuples produce distinct ids, so a partial match can never
widen an approval's scope.

## Node status on refusal (decision c0ca4576)

An approval-required-but-**absent** call **FAILS the node** (it does not
complete). This deliberately differs from a governance policy **DENY**, which
*completes* the node: a deny is **settled** (the policy will not change on a
re-run), whereas an absent approval is **transient and human-changeable** (a
human can grant one and re-trigger). Either way an **always-visible
`APPROVAL_REQUIRED` finding** is written to the governance ledger.

## Fail directions

| Situation | Outcome |
|---|---|
| Gated tool, no/expired/malformed grant | POLICY refusal → node **FAILS**, visible finding (`ApprovalRequiredError`, non-retryable) |
| Gated tool, grant already consumed | POLICY refusal → node **FAILS** (single-use exhausted) |
| Gated tool, incomplete scope context (e.g. supervisor path) | Fail-safe refusal → never runs unapproved |
| Unreadable gated set / approval record | INFRA refusal → node **FAILS loud** (`ApprovalReadError`, retryable) |
| Malformed grant record | Treated as invalid → **requires** approval (fail-safe) |
| Ungated tool | Unaffected (opt-in set) |

## Wiring

- The gated set is **opt-in and explicit** (`APPROVAL_REQUIRED_TOOLS`),
  assembled **server-side** on the dispatch path exactly like `DENIED_TOOLS`,
  and delivered via the subprocess env — **never** via the S3-hosted tool
  module (finding 588c7fb8, which runs stale). Configure it via the CDK context
  key `approvalRequiredTools` (comma-separated).
- The check runs **inside the governance evaluation, before the idempotency
  reserve** (`ComposedToolHook`), so a refusal leaves **zero** tool-execution
  ledger reservations (inherits the deny-before-reserve proof, finding
  027c4a89). The refusal yields an **error-status ToolResult** — it never
  raises (finding ee38af53).
- Approvals are stored in `GOVERNANCE_LEDGER_TABLE` (sole HASH key `findingId`,
  so a lookup is a **GetItem**, not a Query) under new categories
  `tool-approval` (grant) and `tool-approval-consumption` (single-use marker).
- Granting: the `decideToolApproval` mutation, gated by the dedicated
  **`tool:approve`** permission (architect/admin only) with an **org match**.
  `decidedBy` is **server-derived** from the caller's Cognito identity — there
  is no `decidedBy` input field; a caller can never author who decided.

## Separation of duties (explicit v1 choice)

The pre-grant model **decouples** the approver (`decidedBy`, at grant time)
from the executor (the principal that triggers the run and whose executionId
consumes the grant). v1 does **not** hard-block an operator approving a tool
they will later trigger — pre-granting is inherently ahead-of-time and there is
no single "requester" identity at grant time to diff against. The consuming
`executionId` is recorded on the consumption marker so an auditor can correlate
who approved vs which run consumed it. A strict `requester ≠ approver`
enforcement is **deferred**, not silently assumed.
