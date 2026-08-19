"""Watchdog module — scheduled sweep that reconciles lost node-completed events.

A self-contained Lambda handler, run on an EventBridge schedule, that scans the
executions table for executions still in the ``running`` state whose
``startedAt`` is older than a configurable timeout (env
``WORKFLOW_TIMEOUT_SECONDS``, default 1 hour). Each stuck execution is
reconciled: the watchdog shares the executor's schedule_frontier as the single
dispatch serialization point, re-evaluates frontier readiness (schedule-triggered
read-mostly operation), and dispatches ready nodes atomically. Nodes that have
been completed but whose event was lost recover via their durable checkpoint
(``EXECUTIONS_TABLE.nodeResults[nodeId]`` persisted by the Worker before event
emission). If reconciliation finds no recoverable nodes, the execution is marked
``failed`` — idempotently, via a conditional update guarding
``status == 'running'`` — and a ``workflow.failed`` event is emitted through the
shared events module so the rest of the system (fan-out, UI, metrics) reacts to
the timeout exactly as it would to any other terminal failure.

Design contract (Decision O4):
  * Shared executor internals: imports and reuses schedule_frontier as the single
    dispatch serialization point. Reconcile-or-fail semantics ensure a lost
    node-completed event is recovered within one watchdog cycle without doubling
    dispatch.
  * Scoped read-mostly grants: once schedule_frontier is evaluated, the
    watchdog operates schedule-triggered (read-only probe of frontier state;
    write only on final failure). No mutual-exclusion coupling — executor may
    advance concurrently; frontier evaluation is atomic per execution.
  * Idempotent: the conditional update (status == 'running' guard) means a
    concurrent sweep, a redelivered schedule tick, or a race with the executor
    advancing the execution all resolve to a no-op (no duplicate workflow.failed).
  * Best-effort telemetry: a CloudWatch metric of the number of reconciled
    executions is emitted per sweep but never allowed to break the sweep.

All timestamps are ISO 8601 UTC, matching the executor's ``startedAt`` writes.
"""

import boto3
import json
import logging
import os
from datetime import datetime, timezone, timedelta

from botocore.exceptions import ClientError

# Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c):
# this module is its own Lambda entry point (workflowTimeoutWatchdogFunction),
# not reached via executor.py's import chain — import BEFORE the boto3
# client(s) below and before `import events` (which constructs its own
# EventBridge client at module scope) so patch_all() instruments botocore
# ahead of any client creation.
import common.tracing as tracing  # import activates tracing as a side effect

import events

# Decision O4: the watchdog is no longer "executions-table + events only".
# It now READS the workflows table and SHARES the executor's re-entry
# primitive (schedule_frontier) + failure path, so reconcile/re-dispatch use
# exactly one implementation of ready-set + conditional-dispatch logic
# (build-once, never a parallel reconcile impl). This is a deliberate revision
# of the old "no executor coupling" constraint, justified by the acceptance
# target "a lost node-completed event reconciles within one watchdog cycle".
import executor
from dag import find_ready_nodes

# DynamoDB table name from environment (same convention as executor.py).
EXECUTIONS_TABLE = os.environ.get('EXECUTIONS_TABLE', 'citadel-executions-dev')
WORKFLOWS_TABLE = os.environ.get('WORKFLOWS_TABLE', 'citadel-workflows-dev')

# Shared workflow metric namespace — kept in sync with the fan-out Lambda and
# the arbiter node-metric emitters so all workflow telemetry lands in one place.
METRIC_NAMESPACE = 'Citadel/Workflows'
TIMEOUT_METRIC_NAME = 'WorkflowTimedOut'

# Sensible default timeout: 1 hour. A workflow still running after an hour is
# almost certainly stuck (a lost node-completed event, a crashed worker, etc.).
DEFAULT_TIMEOUT_SECONDS = 3600

# Per-node stall detection (decisions O6). A node still 'running' with no
# persisted completion after NODE_STALL_TIMEOUT_SECONDS * NODE_STALL_FACTOR is
# treated as stalled (worker crashed / dispatch lost). Default 900s (the
# worker Lambda's 15-min ceiling) * 2. Clamped per-node overrides are DEFERRED
# (decision O6) — a workflow definition cannot set a per-node timeout yet.
DEFAULT_NODE_STALL_TIMEOUT_SECONDS = 900
DEFAULT_NODE_STALL_FACTOR = 2

# DynamoDB resource (constructed at import; neutralised by boto3 stubs in tests).
_dynamodb = boto3.resource('dynamodb')
_executions_table = _dynamodb.Table(EXECUTIONS_TABLE)
_workflows_table = _dynamodb.Table(WORKFLOWS_TABLE)

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


def _node_stall_seconds() -> int:
    """Resolve the per-node stall threshold: NODE_STALL_TIMEOUT_SECONDS *
    NODE_STALL_FACTOR, each falling back to its default on unset/invalid/non-
    positive values (a misconfigured value must never make the watchdog
    re-dispatch or fail nodes aggressively)."""
    def _pos(name: str, default: int) -> int:
        raw = os.environ.get(name)
        if raw is None:
            return default
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    return _pos('NODE_STALL_TIMEOUT_SECONDS', DEFAULT_NODE_STALL_TIMEOUT_SECONDS) * \
        _pos('NODE_STALL_FACTOR', DEFAULT_NODE_STALL_FACTOR)


def _load_workflow(workflow_id: str) -> dict:
    """Load a workflow row (read-only GetItem). Returns {} when absent."""
    if not workflow_id:
        return {}
    resp = _workflows_table.get_item(Key={'workflowId': workflow_id})
    return resp.get('Item') or {}


def _definition_nodes_edges(workflow: dict) -> tuple[list, list]:
    definition = workflow.get('definition', '{}')
    if isinstance(definition, str):
        try:
            definition = json.loads(definition)
        except ValueError:
            definition = {}
    return definition.get('nodes', []) or [], definition.get('edges', []) or []


def _has_reconcilable_frontier(execution: dict, nodes: list, edges: list) -> bool:
    """True when persisted state shows a lost-event frontier to re-drive: a
    pending node whose predecessors are all terminal (its dispatch signal was
    lost), OR all nodes terminal while the execution is still 'running' (a lost
    finalize). This is checked BEFORE any fail path so a lost event never fails
    a healthy run."""
    node_results = execution.get('nodeResults', {})
    status_map = {n['id']: node_results.get(n['id'], {}).get('status', 'pending') for n in nodes}
    if find_ready_nodes(nodes, edges, status_map):
        return True
    if nodes and all(
        status_map.get(n['id'], 'pending') in ('completed', 'skipped', 'failed') for n in nodes
    ):
        return execution.get('status') == 'running'
    return False


def _find_stalled_node(execution: dict, now: datetime, node_stall: int):
    """Return the id of a node 'running' past the node-stall threshold with no
    persisted completion, else None. Absence of a parseable startedAt means the
    node's age can't be judged — skip it conservatively (never re-dispatch/fail
    on unknown age)."""
    cutoff = now - timedelta(seconds=node_stall)
    for nid, nr in (execution.get('nodeResults') or {}).items():
        if nr.get('status') != 'running':
            continue
        started = _parse_iso(nr.get('startedAt', ''))
        if started is not None and started <= cutoff:
            return nid
    return None


def _reconcile_or_fail_node(execution: dict, workflow: dict, node_id: str) -> str:
    """A stalled node: re-dispatch if retries remain (a stall is a transient
    infra/timeout condition), else drive it (and the execution) to terminal
    failure via the executor's own failure path.

    Re-dispatch flips the node running->pending under a conditional guard
    (status = running) so if the original worker completed in the meantime the
    flip is a no-op; the executor's shared schedule_frontier then re-dispatches
    it via the conditional pending->running guard. First-write-wins on the
    completion means a late original completion + the re-dispatch converge to a
    single recorded completion (recorded-state exactly-once; agent body may run
    twice — decision O7)."""
    execution_id = execution['executionId']
    nodes, _edges = _definition_nodes_edges(workflow)
    node_def = next((n for n in nodes if n['id'] == node_id), None)
    retry_policy = (node_def or {}).get('data', {}).get('retryPolicy', {}) if node_def else {}
    max_retries = retry_policy.get('maxRetries', 0)
    retry_count = execution.get('nodeResults', {}).get(node_id, {}).get('retryCount', 0)

    if retry_count < max_retries:
        try:
            _executions_table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression='SET nodeResults.#nid.#status = :pending, nodeResults.#nid.#rc = :rc',
                ConditionExpression='nodeResults.#nid.#status = :running',
                ExpressionAttributeNames={'#nid': node_id, '#status': 'status', '#rc': 'retryCount'},
                ExpressionAttributeValues={
                    ':pending': 'pending', ':running': 'running', ':rc': retry_count + 1,
                },
            )
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                # The node left 'running' meanwhile (worker completed / another
                # sweep acted) — benign, nothing to re-dispatch.
                return 'node_progressed'
            _logger.error('watchdog: stall re-dispatch flip failed for %s/%s: %s',
                          execution_id, node_id, exc)
            raise
        fresh = executor._load_execution(execution_id) or execution
        executor.schedule_frontier(fresh, workflow)
        _logger.warning('watchdog: re-dispatched stalled node executionId=%s nodeId=%s (retry %d/%d)',
                        execution_id, node_id, retry_count + 1, max_retries)
        return 're_dispatched'

    # Retries exhausted (or none configured) -> terminal via the executor's
    # failure path (marks node + execution failed, emits workflow.failed).
    executor.handle_node_failure(
        execution_id, node_id,
        'Node execution stalled and exceeded the node stall timeout',
    )
    _logger.warning('watchdog: failed stalled node (retries exhausted) executionId=%s nodeId=%s',
                    execution_id, node_id)
    return 'node_failed'


def _reconcile(execution: dict, workflow: dict) -> str:
    """Re-drive a lost-event frontier: repair any false-branch skip lost to a
    crash, then re-derive + dispatch/finalize via the shared schedule_frontier.
    Idempotent (conditional dispatch/finalize guards)."""
    execution_id = execution['executionId']
    executor._reconcile_completed_edges(execution, workflow)
    fresh = executor._load_execution(execution_id) or execution
    executor.schedule_frontier(fresh, workflow)
    _logger.info('watchdog: reconciled lost-event frontier executionId=%s', execution_id)
    return 'reconciled'


def _process_execution(execution: dict, now: datetime, exec_timeout: int, node_stall: int) -> str:
    """Give one running execution a DEFINITE disposition (never silence a stuck
    run). Ordered: reconcile lost-event frontier BEFORE any fail path, then
    stalled-node reconcile-or-fail, then the execution-level backstop.

    Returns one of: reconciled, re_dispatched, node_progressed, node_failed,
    execution_failed, healthy, skipped, race_noop."""
    node_results = execution.get('nodeResults') or {}

    # Per-node reconcile/stall only when we have per-node state AND a workflow
    # to read the graph from. (Executions without nodeResults fall straight to
    # the execution-level backstop.)
    if node_results:
        workflow = _load_workflow(execution.get('workflowId', ''))
        if workflow:
            nodes, edges = _definition_nodes_edges(workflow)
            if _has_reconcilable_frontier(execution, nodes, edges):
                return _reconcile(execution, workflow)
            stalled = _find_stalled_node(execution, now, node_stall)
            if stalled is not None:
                return _reconcile_or_fail_node(execution, workflow, stalled)

    # Execution-level backstop (preserved original behavior): fail an execution
    # with no reconcilable/stalled state that is older than the exec timeout.
    started = _parse_iso(execution.get('startedAt', ''))
    if started is None:
        _logger.info(
            'watchdog: execution executionId=%s has no parseable startedAt; skipping',
            execution.get('executionId'),
        )
        return 'skipped'
    if started <= now - timedelta(seconds=exec_timeout):
        return 'execution_failed' if _fail_stuck(execution, now, exec_timeout) else 'race_noop'
    return 'healthy'


def handler(event, context):
    """Scheduled entry point: reconcile or fail every stuck running execution.

    Ordered per execution (never silence a stuck run): reconcile a lost-event
    frontier, else reconcile-or-fail a stalled node, else fail the execution at
    the execution-level backstop. Returns a small summary dict for
    observability.
    """
    now = _now()
    timeout = _timeout_seconds()
    node_stall = _node_stall_seconds()

    scanned = 0
    timed_out = 0
    reconciled = 0
    re_dispatched = 0
    node_failed = 0
    for execution in _scan_running():
        scanned += 1
        disposition = _process_execution(execution, now, timeout, node_stall)
        if disposition == 'execution_failed':
            timed_out += 1
        elif disposition == 'reconciled':
            reconciled += 1
        elif disposition == 're_dispatched':
            re_dispatched += 1
        elif disposition == 'node_failed':
            node_failed += 1

    _emit_metric(timed_out)
    return {
        'scanned': scanned,
        'timedOut': timed_out,
        'reconciled': reconciled,
        'reDispatched': re_dispatched,
        'nodeFailed': node_failed,
    }
