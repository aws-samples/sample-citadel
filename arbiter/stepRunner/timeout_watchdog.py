"""Watchdog module — scheduled sweep that fails stuck workflow executions.

A self-contained Lambda handler, run on an EventBridge schedule, that scans the
executions table for executions still in the ``running`` state whose
``startedAt`` is older than a configurable timeout (env
``WORKFLOW_TIMEOUT_SECONDS``, default 1 hour). Each stuck execution is marked
``failed`` — idempotently, via a conditional update guarding
``status == 'running'`` — and a ``workflow.failed`` event is emitted through the
shared events module so the rest of the system (fan-out, UI, metrics) reacts to
the timeout exactly as it would to any other terminal failure.

Design constraints:
  * Self-contained: talks ONLY to the executions table (read via Scan +
    conditional write) and the events module. It deliberately does NOT import
    the executor's mutating internals — the sweep is independent of the DAG
    advance logic and must not couple to it.
  * Idempotent: the conditional update means a concurrent sweep, a redelivered
    schedule tick, or a race with the executor moving the execution out of
    ``running`` all resolve to a no-op (no duplicate workflow.failed).
  * Best-effort telemetry: a CloudWatch metric of the number of timed-out
    executions is emitted per sweep but never allowed to break the sweep.

All timestamps are ISO 8601 UTC, matching the executor's ``startedAt`` writes.
"""

import boto3
import logging
import os
from datetime import datetime, timezone, timedelta

from botocore.exceptions import ClientError

import events

# DynamoDB table name from environment (same convention as executor.py).
EXECUTIONS_TABLE = os.environ.get('EXECUTIONS_TABLE', 'citadel-executions-dev')

# Shared workflow metric namespace — kept in sync with the fan-out Lambda and
# the arbiter node-metric emitters so all workflow telemetry lands in one place.
METRIC_NAMESPACE = 'Citadel/Workflows'
TIMEOUT_METRIC_NAME = 'WorkflowTimedOut'

# Sensible default timeout: 1 hour. A workflow still running after an hour is
# almost certainly stuck (a lost node-completed event, a crashed worker, etc.).
DEFAULT_TIMEOUT_SECONDS = 3600

# DynamoDB resource (constructed at import; neutralised by boto3 stubs in tests).
_dynamodb = boto3.resource('dynamodb')
_executions_table = _dynamodb.Table(EXECUTIONS_TABLE)

# Lazy CloudWatch client — constructed on first use so module import never
# resolves credentials (same lazy pattern the executor uses for SQS).
_cw_client = None

_logger = logging.getLogger(__name__)


def _get_cw_client():
    """Lazily construct the boto3 CloudWatch client. Cached per process."""
    global _cw_client
    if _cw_client is None:
        _cw_client = boto3.client('cloudwatch')
    return _cw_client


def _now() -> datetime:
    """Return current UTC time (aware)."""
    return datetime.now(timezone.utc)


def _timeout_seconds() -> int:
    """Resolve the timeout window from the environment.

    Falls back to DEFAULT_TIMEOUT_SECONDS if the env var is unset, non-numeric,
    or non-positive — a misconfigured timeout must never make the watchdog fail
    live executions aggressively (or scan with a nonsensical window).
    """
    raw = os.environ.get('WORKFLOW_TIMEOUT_SECONDS')
    if raw is None:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def _parse_iso(ts: str):
    """Parse an ISO 8601 timestamp into an aware UTC datetime, or None."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _scan_running() -> list:
    """Scan the executions table for items with status == 'running'.

    The table is keyed only by executionId (no status index), so a filtered
    Scan is the correct access pattern for this low-frequency sweep. Terminal
    executions (completed/failed/cancelled) are excluded at the source by the
    filter, so they are never even considered for timeout.
    """
    items: list = []
    scan_kwargs = {
        'FilterExpression': '#s = :running',
        'ExpressionAttributeNames': {'#s': 'status'},
        'ExpressionAttributeValues': {':running': 'running'},
    }
    while True:
        resp = _executions_table.scan(**scan_kwargs)
        items.extend(resp.get('Items', []))
        last_key = resp.get('LastEvaluatedKey')
        if not last_key:
            break
        scan_kwargs['ExclusiveStartKey'] = last_key
    return items


def _fail_stuck(execution: dict, now: datetime, timeout: int) -> bool:
    """Idempotently mark a single stuck execution as failed and emit an event.

    Returns True if THIS invocation performed the transition (and emitted the
    event), False if the execution was already terminal (conditional check
    failed) — the caller uses this to count and to avoid double-emitting.
    """
    execution_id = execution.get('executionId')
    workflow_id = execution.get('workflowId', '')
    failed_at = now.isoformat()
    error = f'Workflow execution timed out after exceeding {timeout}s while running'

    try:
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET #status = :failed, #error = :error, #failedAt = :failedAt',
            # Guard: only transition while still running. This is the
            # idempotency lock — a racing sweep or the executor beating us to
            # a terminal state makes this a no-op.
            ConditionExpression='#status = :running',
            ExpressionAttributeNames={
                '#status': 'status',
                '#error': 'error',
                '#failedAt': 'failedAt',
            },
            ExpressionAttributeValues={
                ':failed': 'failed',
                ':running': 'running',
                ':error': error,
                ':failedAt': failed_at,
            },
        )
    except ClientError as exc:
        code = exc.response.get('Error', {}).get('Code')
        if code == 'ConditionalCheckFailedException':
            _logger.info(
                'watchdog: execution executionId=%s no longer running; skipping',
                execution_id,
            )
            return False
        # Any other DynamoDB error is unexpected — log with context and re-raise
        # so the sweep surfaces the failure (never swallow DB write errors).
        _logger.error(
            'watchdog: update_item failed for executionId=%s: %s',
            execution_id, exc,
        )
        raise

    _logger.warning(
        'watchdog: failing stuck execution executionId=%s workflowId=%s startedAt=%s',
        execution_id, workflow_id, execution.get('startedAt', ''),
    )

    # Emit the terminal workflow.failed via the shared events module. Timeout is
    # execution-level, so there is no single failing node (failed_node_id='').
    events.publish_workflow_failed(
        execution_id=execution_id,
        workflow_id=workflow_id,
        failed_node_id='',
        error=error,
        failed_at=failed_at,
    )
    return True


def _emit_metric(timed_out_count: int) -> None:
    """Best-effort CloudWatch metric of timed-out executions for this sweep."""
    try:
        _get_cw_client().put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[{
                'MetricName': TIMEOUT_METRIC_NAME,
                'Value': timed_out_count,
                'Unit': 'Count',
                'Timestamp': _now(),
            }],
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must not raise
        _logger.warning('watchdog: metric emit failed: %s', exc)


def handler(event, context):
    """Scheduled entry point: fail every stuck running execution.

    Returns a small summary dict (scanned / timed_out) for observability in the
    Lambda invocation result and step-through logs.
    """
    now = _now()
    timeout = _timeout_seconds()
    cutoff = now - timedelta(seconds=timeout)

    scanned = 0
    timed_out = 0
    for execution in _scan_running():
        scanned += 1
        started = _parse_iso(execution.get('startedAt', ''))
        if started is None:
            # No usable startedAt — cannot judge age. Skip conservatively rather
            # than fail a possibly-healthy execution.
            _logger.info(
                'watchdog: execution executionId=%s has no parseable startedAt; skipping',
                execution.get('executionId'),
            )
            continue
        if started <= cutoff:
            if _fail_stuck(execution, now, timeout):
                timed_out += 1

    _emit_metric(timed_out)
    return {'scanned': scanned, 'timedOut': timed_out}
