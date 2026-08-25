"""
Approval-required tool gating — pre-grantable, single-use approval store
(finding c947aa77).

CHECK-AND-REFUSE v1 (decision 6ac67191): a gated tool is REFUSED at the
governance seam unless a valid, pre-granted, not-yet-consumed approval covers
this call. There is NO pause-and-resume and NO in-flight approval — a call
lacking a pre-existing approval is refused, never parked for a human to approve
mid-run. See docs/APPROVAL_GATING.md.

Scope (decision f0056afe): an approval is PRE-GRANTED per the FULL tuple
``(orgId, workflowDefinitionId, nodeId, toolName)`` — NOT per execution
(un-grantable before dispatch) and NOT per tool (a standing bearer grant). The
grant carries a short APPLICATION validity (``expiresAt``) that is DISTINCT
from the row's DynamoDB ``ttl`` retention attribute: the ``ttl`` keeps the
audit row for the 90-day accountability window, while ``expiresAt`` is the
application-checked validity used here. NEVER conflate the two — a TTL deletion
must never be the mechanism that "expires" an approval, and an expired approval
must never delete the audit record.

Single-use consumption (decision f0056afe): consumption is recorded against
the consuming ``executionId`` as a SEPARATE write-once row whose id derives
from the grant tuple ONLY (never the executionId), so exactly one execution can
ever claim a given grant. Consumption is an atomic conditional
``PutItem(attribute_not_exists(findingId))`` — the same first-write-wins
primitive the tool-execution ledger's ``reserve`` uses — so two concurrent
executions can never both consume one approval; the loser gets
``ConditionalCheckFailedException`` and is refused.

Storage (settled constraint): both rows live in ``GOVERNANCE_LEDGER_TABLE``
(PK ``findingId``, sole key — a deterministic-id lookup is a GetItem, NOT a
Query) under two new categories, ``tool-approval`` (grant) and
``tool-approval-consumption`` (single-use marker). The grant is written by the
``decideToolApproval`` backend mutation (server-derived ``decidedBy``); the
worker only READS the grant (GetItem) and WRITES the consumption marker
(conditional PutItem) at the seam.

Finding-id derives from the FULL tuple (decision f0056afe) — NO prefix
matching. Any two distinct tuples produce distinct ids; a partial match can
never widen an approval's scope.

Fail direction:
  * a gated tool whose grant is ABSENT / EXPIRED / already-CONSUMED ⇒ a POLICY
    refusal (:class:`ApprovalRequiredError`, non-retryable) — the node FAILS
    (decision c0ca4576), distinct from a governance policy-DENY which COMPLETES
    (a deny is settled; an absent approval is transient and human-changeable).
  * an UNREADABLE gated set or UNREADABLE / un-writable approval record ⇒ an
    INFRASTRUCTURE refusal (:class:`ApprovalReadError`, retryable) — the node
    FAILS loud, never silently permits.

Marshalling: all writes route through the single ``marshal_ddb_item`` boundary
(finding 96d24639) and store INTEGER epoch timestamps — a native float is
rejected by DynamoDB.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# Single marshalling boundary (finding 96d24639) — same helper the governance
# ledger + tool-execution ledger write through. FAIL LOUD on ImportError (no
# identity-shim fallback): an unimportable boundary means a mis-deployed bundle,
# and a bare float reaching DynamoDB is exactly what this boundary prevents.
from common.ddb_marshalling import marshal_ddb_item

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Categories + id derivation
# ---------------------------------------------------------------------------

APPROVAL_GRANT_CATEGORY = "tool-approval"
APPROVAL_CONSUMPTION_CATEGORY = "tool-approval-consumption"

# Deterministic finding-id prefixes so a grant row and its single-use
# consumption marker can never collide even though both derive from the same
# scope tuple. The scope digest itself is over the FULL 4-tuple.
_GRANT_ID_PREFIX = "tool-approval:"
_CONSUMPTION_ID_PREFIX = "tool-approval-consumption:"

# Default application validity window (seconds) for a pre-granted approval when
# the grant writer does not stamp its own expiresAt. Deliberately short — an
# approval is meaningful only for the imminent run it was granted for. This is
# the APPLICATION validity, NOT the row's DDB ttl retention (see module doc).
DEFAULT_APPROVAL_VALIDITY_SECONDS = 3600  # 1h

# Retention window for the consumption marker's DDB ttl attribute. Matches the
# governance ledger's 90-day accountability retention — the consumption row is
# an audit artifact of single-use, kept well beyond the approval's validity so
# TTL deletion never races the audit trail.
_CONSUMPTION_TTL_DAYS = 90


def _scope_digest(org_id: str, workflow_definition_id: str, node_id: str, tool_name: str) -> str:
    """SHA-256 over the canonical FULL tuple (decision f0056afe: no prefix
    matching). Uses a JSON array with an unambiguous encoding so no component
    boundary can be forged by embedding a separator — ``["a#b","c"]`` and
    ``["a","b#c"]`` produce distinct digests."""
    canonical = json.dumps(
        [org_id, workflow_definition_id, node_id, tool_name],
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def grant_finding_id(org_id: str, workflow_definition_id: str, node_id: str, tool_name: str) -> str:
    """Deterministic finding-id of the pre-granted approval row for the FULL
    tuple. This is the sole HASH key, so a lookup by this id is a GetItem."""
    return _GRANT_ID_PREFIX + _scope_digest(org_id, workflow_definition_id, node_id, tool_name)


def consumption_finding_id(org_id: str, workflow_definition_id: str, node_id: str, tool_name: str) -> str:
    """Deterministic finding-id of the single-use consumption marker. Derived
    from the grant tuple ONLY (never the executionId) so exactly one execution
    can win the conditional write and consume the grant."""
    return _CONSUMPTION_ID_PREFIX + _scope_digest(org_id, workflow_definition_id, node_id, tool_name)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ApprovalError(Exception):
    """Base for approval-gating failures. ``retryable`` mirrors the ledger
    exception hierarchy so the refusal sink can carry it into retry.py."""

    retryable = False


class ApprovalRequiredError(ApprovalError):
    """POLICY refusal: a gated tool has no valid, unconsumed approval (absent /
    expired / already-consumed). The node FAILS (decision c0ca4576).
    Non-retryable — an absent approval is human-changeable, not transient at
    the infrastructure level; a human grants a new approval and re-triggers the
    workflow (v1 is check-and-refuse, no in-flight approval)."""

    retryable = False


class ApprovalReadError(ApprovalError):
    """INFRASTRUCTURE refusal: the gated set or the approval record could not
    be read/written (table unset, transport/credential error). FAIL LOUD — the
    node FAILS, never silently permits. Retryable — a transport blip may
    recover on re-dispatch."""

    retryable = True


# ---------------------------------------------------------------------------
# Lazy DDB resource (mirror ledger.py — patchable, no import-time creds)
# ---------------------------------------------------------------------------

_ddb_resource: Any = None


def _get_dynamodb_resource() -> Any:
    global _ddb_resource
    if _ddb_resource is None:
        _ddb_resource = boto3.resource("dynamodb")
    return _ddb_resource


def __reset_approval_client_for_test() -> None:
    """Test-only: clear the cached boto3 resource so mocks/moto can bind."""
    global _ddb_resource
    _ddb_resource = None


def _table():
    table_name = os.environ.get("GOVERNANCE_LEDGER_TABLE")
    if not table_name:
        # FAIL LOUD: an approval check with no ledger table configured cannot
        # validate an approval, and must not silently permit a gated tool.
        raise ApprovalReadError(
            "GOVERNANCE_LEDGER_TABLE not configured — cannot read/write approval "
            "records (fail-loud)"
        )
    return _get_dynamodb_resource().Table(table_name)


# ---------------------------------------------------------------------------
# Grant read + application-validity check
# ---------------------------------------------------------------------------


def read_grant(
    org_id: str, workflow_definition_id: str, node_id: str, tool_name: str,
) -> dict[str, Any] | None:
    """GetItem the pre-granted approval row for the FULL tuple. Returns the item
    dict, or ``None`` when no grant exists.

    Raises :class:`ApprovalReadError` on any transport/credential/config error
    (infra refusal → FAIL LOUD). NEVER returns ``None`` on an error — an
    unreadable record must fail the node, not read as "absent" (which would be
    indistinguishable from a genuine absence and could be exploited to force
    the absent-⇒-refuse path to look benign)."""
    finding_id = grant_finding_id(org_id, workflow_definition_id, node_id, tool_name)
    try:
        resp = _table().get_item(Key={"findingId": finding_id})
    except (ClientError, BotoCoreError) as exc:
        raise ApprovalReadError(
            f"approval grant read failed for {finding_id!r}: {exc}"
        ) from exc
    except ApprovalReadError:
        raise
    except Exception as exc:  # noqa: BLE001 — never let an unexpected error read as absent
        raise ApprovalReadError(
            f"unexpected error reading approval grant {finding_id!r}: {exc}"
        ) from exc
    return resp.get("Item")


def grant_is_valid(
    grant: dict[str, Any] | None,
    org_id: str,
    workflow_definition_id: str,
    node_id: str,
    tool_name: str,
    *,
    now: float | None = None,
) -> bool:
    """Application-level validity check (DISTINCT from the row's DDB ttl).

    Returns True iff the grant exists, its stored tuple matches the requested
    tuple (defense-in-depth against a mis-keyed row), it is a ``tool-approval``
    grant, and its APPLICATION ``expiresAt`` lies in the future. Fail-safe: a
    malformed grant (missing/garbage ``expiresAt``, wrong category, tuple
    mismatch) is treated as INVALID — a gated tool then requires a fresh
    approval rather than running on an unparseable record."""
    if not grant:
        return False
    now = time.time() if now is None else now
    if grant.get("category") != APPROVAL_GRANT_CATEGORY:
        return False
    # Tuple match: the id is derived from the tuple, so a matching GetItem
    # already implies the tuple; re-check the stored attributes so a row
    # hand-written with a colliding id but different scope cannot be honoured.
    if (
        grant.get("orgId") != org_id
        or grant.get("workflowDefinitionId") != workflow_definition_id
        or grant.get("nodeId") != node_id
        or grant.get("toolName") != tool_name
    ):
        return False
    expires_at = grant.get("expiresAt")
    try:
        expires_at = float(expires_at)
    except (TypeError, ValueError):
        return False  # malformed validity ⇒ fail-safe invalid
    return expires_at > now


# ---------------------------------------------------------------------------
# Single-use atomic consumption
# ---------------------------------------------------------------------------


def consume(
    org_id: str,
    workflow_definition_id: str,
    node_id: str,
    tool_name: str,
    execution_id: str,
    *,
    now: float | None = None,
) -> bool:
    """Atomically claim single-use of the approval for the consuming
    ``execution_id``. Returns True if THIS caller won the claim, False if the
    approval was already consumed (by any execution).

    Implemented as a conditional first-write-wins ``PutItem`` of a write-once
    consumption marker keyed by the grant tuple (NOT the executionId), so two
    concurrent executions can never both win. The winner's ``executionId`` is
    recorded on the row. Raises :class:`ApprovalReadError` on any other write
    error (infra refusal → FAIL LOUD)."""
    now = time.time() if now is None else now
    now_i = int(now)
    finding_id = consumption_finding_id(org_id, workflow_definition_id, node_id, tool_name)
    item = {
        "findingId": finding_id,
        "category": APPROVAL_CONSUMPTION_CATEGORY,
        "orgId": org_id,
        "workflowDefinitionId": workflow_definition_id,
        "nodeId": node_id,
        "toolName": tool_name,
        # The consuming execution — the single-use attribution (decision
        # f0056afe). Stored as an attribute; NEVER part of the key.
        "consumedByExecutionId": execution_id,
        "consumedAt": now_i,
        # DDB retention ttl (accountability), DISTINCT from any approval
        # validity — this row is the durable single-use audit marker.
        "ttl": now_i + _CONSUMPTION_TTL_DAYS * 86400,
    }
    try:
        _table().put_item(
            Item=marshal_ddb_item(item),
            ConditionExpression="attribute_not_exists(findingId)",
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            # Already consumed by another execution — single-use exhausted.
            return False
        raise ApprovalReadError(
            f"approval consumption write failed for {finding_id!r}: {exc}"
        ) from exc
    except BotoCoreError as exc:
        raise ApprovalReadError(
            f"approval consumption transport error for {finding_id!r}: {exc}"
        ) from exc


def read_consumption(
    org_id: str, workflow_definition_id: str, node_id: str, tool_name: str,
) -> dict[str, Any] | None:
    """Test/inspection helper: GetItem the single-use consumption marker (or
    None). Raises :class:`ApprovalReadError` on a transport error."""
    finding_id = consumption_finding_id(org_id, workflow_definition_id, node_id, tool_name)
    try:
        resp = _table().get_item(Key={"findingId": finding_id})
    except (ClientError, BotoCoreError) as exc:
        raise ApprovalReadError(
            f"approval consumption read failed for {finding_id!r}: {exc}"
        ) from exc
    return resp.get("Item")
