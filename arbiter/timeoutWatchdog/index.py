"""Approval-timeout watchdog — scheduled sweep that denies expired approval requests.

A self-contained Lambda handler, run on an EventBridge schedule, that scans the
executions table for executions in the ``awaiting_approval`` state AND running
executions that may contain parked nodes.  For each ``awaiting_approval`` node
whose approval request has expired (``expiresAt`` past, or ``requestedAt`` +
``APPROVAL_TIMEOUT_SECONDS`` when ``expiresAt`` is absent), the watchdog denies
the request via the executor's ``deny_execution`` path (reason
``approval_timeout``).

Design contract (CIT-030 §4):
  * Stall detection NEVER re-drives an ``awaiting_approval`` node — only the
    ``running`` status triggers the forward-progress stall detector.
  * Expired approval requests are fail-closed: deny via the engine's deny path.
  * ``APPROVAL_TIMEOUT_SECONDS`` env (default 86400 = 24h) is the fallback
    when a request has no ``expiresAt``.
  * Idempotent: ``deny_execution``'s conditional write (decision == None) makes
    duplicate sweeps a no-op.

All timestamps are ISO 8601 UTC.
"""

import logging
import os
import sys
from datetime import datetime, timezone, timedelta

import boto3
from botocore.exceptions import ClientError

# Ensure stepRunner is importable (executor, approval_requests live there).
_step_runner_dir = os.path.join(os.path.dirname(__file__), '..', 'stepRunner')
if _step_runner_dir not in sys.path:
    sys.path.insert(0, _step_runner_dir)

import common.tracing as tracing  # noqa: E402  — activate tracing before clients

import executor  # noqa: E402
from approval_requests import AWAITING_APPROVAL  # noqa: E402

EXECUTIONS_TABLE = os.environ.get('EXECUTIONS_TABLE', 'citadel-executions-dev')
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 86_400  # 24 hours

_dynamodb = boto3.resource('dynamodb')
_executions_table = _dynamodb.Table(EXECUTIONS_TABLE)

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _approval_timeout_seconds() -> int:
    """Resolve the approval-timeout window from the environment."""
    raw = os.environ.get('APPROVAL_TIMEOUT_SECONDS')
    if raw is None:
        return DEFAULT_APPROVAL_TIMEOUT_SECONDS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_APPROVAL_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_APPROVAL_TIMEOUT_SECONDS


def _parse_iso(ts) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _scan_awaiting_or_running() -> list:
    """Scan executions with status IN ('running', 'awaiting_approval').

    Running executions may contain individual parked nodes that need timeout
    checks (the execution-level status only flips to ``awaiting_approval``
    when ALL non-terminal nodes are settled).
    """
    items: list = []
    scan_kwargs = {
        'FilterExpression': '#s IN (:running, :awaiting)',
        'ExpressionAttributeNames': {'#s': 'status'},
        'ExpressionAttributeValues': {
            ':running': 'running',
            ':awaiting': AWAITING_APPROVAL,
        },
    }
    while True:
        resp = _executions_table.scan(**scan_kwargs)
        items.extend(resp.get('Items', []))
        last_key = resp.get('LastEvaluatedKey')
        if not last_key:
            break
        scan_kwargs['ExclusiveStartKey'] = last_key
    return items


def _find_expired_approval_requests(
    execution: dict, now: datetime, timeout_seconds: int,
) -> list[tuple[str, dict]]:
    """Return ``[(nodeId, request), ...]`` for expired, undecided requests."""
    approval_requests = execution.get('approvalRequests') or {}
    expired: list[tuple[str, dict]] = []

    for node_id, req in approval_requests.items():
        # Already decided — nothing to do.
        if req.get('decision') is not None:
            continue

        # Determine the effective expiry.
        expires_at = _parse_iso(req.get('expiresAt'))
        if expires_at is None:
            # No expiresAt → fall back to requestedAt + APPROVAL_TIMEOUT_SECONDS.
            requested_at = _parse_iso(req.get('requestedAt'))
            if requested_at is None:
                # Can't judge age — skip conservatively.
                continue
            expires_at = requested_at + timedelta(seconds=timeout_seconds)

        if now >= expires_at:
            expired.append((node_id, req))

    return expired


def _deny_expired_request(
    execution_id: str, node_id: str, req: dict,
) -> bool:
    """Deny one expired approval request via the executor's deny path.

    Returns True if the denial was performed, False on no-op.
    """
    resume_token = req.get('resumeToken', '')
    org_id = req.get('orgId', '')
    return executor.deny_execution(
        execution_id=execution_id,
        node_id=node_id,
        resume_token=resume_token,
        decided_by='system:approval_timeout',
        org_id=org_id,
        reason='approval_timeout',
    )


def _process_execution(
    execution: dict, now: datetime, timeout_seconds: int,
) -> int:
    """Process one execution for expired approval requests.

    Returns the count of requests denied in this call.
    """
    execution_id = execution.get('executionId', '')
    expired = _find_expired_approval_requests(execution, now, timeout_seconds)
    denied = 0
    for node_id, req in expired:
        if _deny_expired_request(execution_id, node_id, req):
            _logger.warning(
                'approval_timeout_watchdog: denied expired request '
                'executionId=%s nodeId=%s',
                execution_id, node_id,
            )
            denied += 1
    return denied


def handler(event, context):
    """Scheduled entry point: deny every expired approval request.

    Returns a summary dict for observability.
    """
    now = _now()
    timeout_seconds = _approval_timeout_seconds()
    scanned = 0
    denied = 0

    for execution in _scan_awaiting_or_running():
        scanned += 1
        denied += _process_execution(execution, now, timeout_seconds)

    return {'scanned': scanned, 'denied': denied}
