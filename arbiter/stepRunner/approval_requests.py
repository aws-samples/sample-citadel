"""Approval-request helpers for the execution pause/resume engine (CIT-030).

Pure functions and constants for building, validating, and querying
approval-request records persisted as additive DynamoDB attributes on the
execution row.  No AWS calls — all I/O is the caller's responsibility.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Status constants — shared between executor, watchdog, and future resume path
# ---------------------------------------------------------------------------

AWAITING_APPROVAL = 'awaiting_approval'
"""Node and execution status while a human decision is outstanding."""

EXECUTION_SENTINEL = '__execution__'
"""Sentinel key in ``approvalRequests`` for execution-scoped pause requests.

Real node ids come from the workflow definition's ``nodes[].id``, which the
frontend validator disallows containing ``__`` double-underscore prefixes
(confirmed: ``^[a-zA-Z0-9-]+$``), so no collision is possible.
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def build_approval_request(
    request_type: str,
    reason: str,
    requested_by: str,
    expires_at: str | None = None,
    metadata: dict | None = None,
    org_id: str | None = None,
    *,
    scope: str | None = None,
    node_ids: list[str] | None = None,
) -> dict:
    """Build an approval-request record for one node or execution-wide.

    ``resumeToken`` is a server-generated, unguessable, URL-safe token
    (``secrets.token_urlsafe``) — never logged, never included in events.
    The token gates the one-time approve/deny mutation (PR3).

    ``expiresAt`` is optional; ``None`` means no automatic timeout.

    ``orgId`` is persisted on the request for audit completeness; the
    approve/deny fence checks the *execution-level* ``orgId`` attribute
    (not this copy) so the field is informational only.

    ``scope`` is ``'execution'`` for execution-scoped pause requests,
    absent/``None`` for legacy per-node requests.

    ``node_ids`` records which nodes are parked under this request
    (execution-scoped only).  Validated: node ids starting with ``'__'``
    are rejected (reserved namespace) EXCEPT the ``EXECUTION_SENTINEL``
    itself (which is the map key, never an element of ``node_ids``).
    """
    if node_ids is not None:
        bad = [nid for nid in node_ids if nid.startswith('__')]
        if bad:
            raise ValueError(
                f"node ids starting with '__' are reserved and cannot appear "
                f"in an approval request's nodeIds list: {bad}"
            )

    record: dict = {
        'requestType': request_type,
        'reason': reason,
        'requestedBy': requested_by,
        'requestedAt': datetime.now(timezone.utc).isoformat(),
        'resumeToken': secrets.token_urlsafe(32),
        'expiresAt': expires_at,
        'decidedBy': None,
        'decidedAt': None,
        'decision': None,
        'orgId': org_id,
        'metadata': metadata if metadata is not None else {},
    }
    if scope is not None:
        record['scope'] = scope
    if node_ids is not None:
        record['nodeIds'] = list(node_ids)
    return record


def is_awaiting(status: str | None) -> bool:
    """Return ``True`` when *status* represents a parked approval wait."""
    return status == AWAITING_APPROVAL


def validate_transition(current: str, target: str) -> bool:
    """Return ``True`` when *current → target* is a legal status transition
    involving ``awaiting_approval``.

    Allowed transitions (design §1):
      - ``pending`` → ``awaiting_approval``  (park before dispatch)
      - ``awaiting_approval`` → ``pending``  (approved — ready for dispatch)
      - ``running`` → ``awaiting_approval``  (execution-level: all nodes settled)
      - ``awaiting_approval`` → ``running``  (execution-level: resume)
    """
    _ALLOWED = {
        ('pending', AWAITING_APPROVAL),
        (AWAITING_APPROVAL, 'pending'),
        ('running', AWAITING_APPROVAL),
        (AWAITING_APPROVAL, 'running'),
    }
    return (current, target) in _ALLOWED
