"""Executor module — orchestration logic for workflow step execution.

Coordinates workflow execution by loading state from DynamoDB, advancing
through the DAG, evaluating conditional edges, handling convergence barriers,
retrying failed nodes, and publishing lifecycle events via EventBridge.

All operations are idempotent — re-processing the same event checks
DynamoDB state first to avoid duplicate work.
"""

import boto3
import json
import logging
import os
from datetime import datetime, timezone

import events
from dag import find_root_nodes, find_ready_nodes, find_convergence_nodes
from condition import evaluate_condition
from retry import calculate_backoff, should_retry
from common import workflow_contract

# DynamoDB table names from environment
WORKFLOWS_TABLE = os.environ.get('WORKFLOWS_TABLE', 'citadel-workflows-dev')
EXECUTIONS_TABLE = os.environ.get('EXECUTIONS_TABLE', 'citadel-executions-dev')

# DynamoDB resource
_dynamodb = boto3.resource('dynamodb')
_workflows_table = _dynamodb.Table(WORKFLOWS_TABLE)
_executions_table = _dynamodb.Table(EXECUTIONS_TABLE)

_logger = logging.getLogger(__name__)

# CloudWatch custom-metric namespace. Shared convention with the workflow
# infrastructure (fan-out error metric + alarms live in the same namespace).
METRIC_NAMESPACE = 'Citadel/Workflows'

# Lazy SQS client for dispatching workflow nodes to the worker. Constructed on
# first use (not at import) so module import never resolves credentials — the
# same pattern the worker uses for its boto3 clients.
_sqs_client = None

# Lazy CloudWatch client for best-effort node telemetry. Same lazy pattern as
# the SQS client: never resolve credentials at import time.
_cloudwatch_client = None


def _get_sqs_client():
    """Lazily construct the boto3 SQS client. Cached per process."""
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = boto3.client('sqs')
    return _sqs_client


def _get_cloudwatch_client():
    """Lazily construct the boto3 CloudWatch client. Cached per process."""
    global _cloudwatch_client
    if _cloudwatch_client is None:
        _cloudwatch_client = boto3.client('cloudwatch')
    return _cloudwatch_client


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _log_event(action: str, **fields) -> None:
    """Emit a structured JSON log line for cross-system correlation.

    Every line carries an ``executionId`` (and, where relevant, ``nodeId`` /
    ``workflowId``) so a log search can stitch one execution together across
    the step runner and the worker. Emitted via stdout (Lambda ships stdout to
    CloudWatch Logs), matching the worker's structured-logging convention.
    None-valued fields are dropped to keep lines terse.
    """
    payload = {'component': 'StepRunner', 'action': action}
    payload.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(payload))


def _duration_ms(started_at, completed_at) -> float | None:
    """Return elapsed milliseconds between two ISO 8601 timestamps.

    Returns None when either bound is missing or unparseable — the duration
    metric is best-effort and must never be fabricated.
    """
    if not started_at or not completed_at:
        return None
    try:
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(completed_at)
    except (TypeError, ValueError):
        return None
    return max(0.0, (end - start).total_seconds() * 1000.0)


def _emit_metric(metric_name: str, value: float, unit: str, *, workflow_id: str = '') -> None:
    """Emit a single CloudWatch custom metric, best-effort.

    Wrapped so a telemetry backend failure (throttling, missing
    cloudwatch:PutMetricData permission, network) can NEVER break workflow
    execution. A WorkflowId dimension is attached when available to keep
    cardinality bounded while still allowing per-workflow drill-down.
    """
    try:
        datum = {'MetricName': metric_name, 'Value': float(value), 'Unit': unit}
        if workflow_id:
            datum['Dimensions'] = [{'Name': 'WorkflowId', 'Value': workflow_id}]
        _get_cloudwatch_client().put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[datum],
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must never raise
        _logger.warning('cloudwatch metric emit failed metric=%s: %s', metric_name, exc)


def _load_workflow(workflow_id: str) -> dict:
    """Load workflow item from DynamoDB."""
    resp = _workflows_table.get_item(Key={'workflowId': workflow_id})
    return resp.get('Item', {})


def _load_execution(execution_id: str) -> dict:
    """Load execution item from DynamoDB."""
    resp = _executions_table.get_item(Key={'executionId': execution_id})
    return resp.get('Item', {})


def _parse_definition(workflow: dict) -> dict:
    """Parse the workflow definition JSON string."""
    defn = workflow.get('definition', '{}')
    if isinstance(defn, str):
        return json.loads(defn)
    return defn


def start_execution(execution_id: str, workflow_id: str) -> None:
    """Start a workflow execution.

    1. Load workflow + execution from DynamoDB
    2. Idempotency: skip if execution is already 'running'
    3. Update execution status → running
    4. Publish workflow.started event
    5. Find root nodes → invoke them
    """
    workflow = _load_workflow(workflow_id)
    if not workflow:
        raise ValueError(f"Workflow {workflow_id} not found")

    execution = _load_execution(execution_id)
    if not execution:
        raise ValueError(f"Execution {execution_id} not found")

    # Idempotency check: skip if already running or completed
    if execution.get('status') in ('running', 'completed', 'failed', 'cancelled'):
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    edges = definition.get('edges', [])

    # Update execution status to running
    now = _now_iso()
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET #status = :status, #startedAt = :startedAt',
        ExpressionAttributeNames={'#status': 'status', '#startedAt': 'startedAt'},
        ExpressionAttributeValues={':status': 'running', ':startedAt': now},
    )

    # Publish workflow.started event
    events.publish_workflow_started(
        execution_id=execution_id,
        workflow_id=workflow_id,
        app_id=execution.get('appId', ''),
        started_at=now,
    )
    _log_event('execution_start', executionId=execution_id, workflowId=workflow_id)

    # Find and invoke root nodes
    root_ids = find_root_nodes(nodes, edges)
    configuration = workflow.get('configuration', '{}')
    if isinstance(configuration, str):
        configuration = json.loads(configuration)

    for node_id in root_ids:
        node = next((n for n in nodes if n['id'] == node_id), None)
        if node:
            invoke_node(execution_id, workflow_id, node, {}, configuration)


def invoke_node(execution_id: str, workflow_id: str, node: dict, input_data: dict, configuration: dict) -> None:
    """Invoke a single workflow node.

    1. Emit supervisor.chatter event for cross-system correlation (US-ARB-016)
    2. Update node status → running in DynamoDB
    3. Publish workflow.node.started event
    4. Dispatch the node to the worker by sending a discriminated message to
       the worker SQS queue (WORKER_QUEUE_URL)
    """
    # US-ARB-016: fire-and-forget chatter event for cross-system correlation.
    # The returned correlationId is currently a local only; it becomes the
    # hook for US-ARB-008's governed dispatch to link findings back to the
    # stepRunner node that triggered them.
    correlation_id = events.publish_supervisor_chatter(  # noqa: F841
        execution_id=execution_id,
        workflow_id=workflow_id,
        node_id=node.get('id', 'unknown'),
    )

    node_id = node['id']
    # Canonical persisted shape: top-level node.agentId.
    # The frontend's ReactFlow runtime puts agentId under node.data.agentId,
    # but workflowService.ts converts this to top-level on serialization
    # (see WorkflowNodeDefinition in frontend/src/types/workflow.ts).
    # All backend writers (seed-blueprints, importBlueprint) and the TS
    # validator (workflow-resolver.validateDefinition) use the top-level
    # shape, so executor must read top-level too.
    agent_id = node.get('agentId', '')
    now = _now_iso()

    # Correlation log: one line per node dispatch, tagged with the ids a log
    # search needs to stitch this node to its worker-side execution.
    _log_event(
        'node_dispatch',
        executionId=execution_id,
        workflowId=workflow_id,
        nodeId=node_id,
        agentId=agent_id or None,
    )

    # Update node status to running
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET nodeResults.#nid.#status = :status, nodeResults.#nid.#startedAt = :startedAt',
        ExpressionAttributeNames={
            '#nid': node_id,
            '#status': 'status',
            '#startedAt': 'startedAt',
        },
        ExpressionAttributeValues={':status': 'running', ':startedAt': now},
    )

    # Publish node.started event
    events.publish_node_started(
        execution_id=execution_id,
        workflow_id=workflow_id,
        node_id=node_id,
        agent_id=agent_id,
        started_at=now,
    )

    # Dispatch the node to the worker over the shared SQS queue. The message
    # carries the workflow-node discriminator so the worker can tell it apart
    # from a supervisor task message on the same queue. The worker runs the
    # agent and emits the node-completed / node-failed event that this step
    # runner consumes (via its EventBridge rules) to advance the DAG.
    queue_url = os.environ.get('WORKER_QUEUE_URL')
    if not queue_url:
        _logger.warning(
            'WORKER_QUEUE_URL is not set; cannot dispatch node %s of execution %s',
            node_id, execution_id,
        )
        return

    message = workflow_contract.build_node_dispatch_message(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
    )
    _get_sqs_client().send_message(
        QueueUrl=queue_url,
        MessageBody=json.dumps(message),
    )


def handle_node_completion(execution_id: str, node_id: str, output: dict) -> None:
    """Handle a completed node and advance the workflow.

    1. Update node status → completed in DynamoDB
    2. Publish workflow.node.completed event
    3. Evaluate conditional edges on outgoing edges
    4. For conditional edges that evaluate to false → mark downstream as skipped
    5. For convergence nodes → check if all predecessors complete
    6. Invoke ready nodes
    7. If all nodes complete → mark execution completed
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    workflow = _load_workflow(execution.get('workflowId', ''))
    if not workflow:
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    edges = definition.get('edges', [])
    node_results = execution.get('nodeResults', {})

    # Find the completed node's agent ID
    node_data = node_results.get(node_id, {})

    # Idempotency guard against duplicate deliveries. At-least-once transports
    # (SQS / EventBridge) can redeliver the same node-completed event. If the
    # persisted node status is already the terminal 'completed', this is a
    # replay — return without re-updating state, re-advancing the DAG,
    # re-invoking downstream nodes, or re-emitting the terminal
    # workflow.completed event.
    if node_data.get('status') == 'completed':
        return

    now = _now_iso()

    # Update node to completed
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET nodeResults.#nid.#status = :status, nodeResults.#nid.#completedAt = :completedAt, nodeResults.#nid.#output = :output',
        ExpressionAttributeNames={
            '#nid': node_id,
            '#status': 'status',
            '#completedAt': 'completedAt',
            '#output': 'output',
        },
        ExpressionAttributeValues={':status': 'completed', ':completedAt': now, ':output': output},
    )

    # Best-effort telemetry (WF-053). A metric or log failure must never break
    # DAG advancement, so both are wrapped / fire-and-forget.
    workflow_id = execution.get('workflowId', '')
    _log_event(
        'node_completed',
        executionId=execution_id,
        workflowId=workflow_id,
        nodeId=node_id,
        agentId=node_data.get('agentId') or None,
    )
    duration = _duration_ms(node_data.get('startedAt'), now)
    if duration is not None:
        _emit_metric('NodeDurationMs', duration, 'Milliseconds', workflow_id=workflow_id)

    # NOTE: workflow.node.completed is NOT re-emitted here. This handler is
    # triggered BY that event (the worker is its sole producer), and the step
    # runner's own EventBridge rule consumes workflow.node.completed — so
    # re-emitting it would self-trigger an infinite loop. We only advance the
    # DAG below and emit the terminal workflow.completed when all nodes finish.

    # Update local state for ready-node calculation
    node_results[node_id] = {**node_data, 'status': 'completed', 'output': output}

    # Evaluate outgoing edges from this node
    outgoing_edges = [e for e in edges if e['source'] == node_id]
    for edge in outgoing_edges:
        condition = edge.get('condition')
        if condition:
            if not evaluate_condition(condition, output):
                # Condition false → skip the target node
                target_id = edge['target']
                node_results[target_id] = {**node_results.get(target_id, {}), 'status': 'skipped'}
                _executions_table.update_item(
                    Key={'executionId': execution_id},
                    UpdateExpression='SET nodeResults.#nid.#status = :status',
                    ExpressionAttributeNames={'#nid': target_id, '#status': 'status'},
                    ExpressionAttributeValues={':status': 'skipped'},
                )

    # Build node list with current statuses for find_ready_nodes
    nodes_with_status = []
    for n in nodes:
        nid = n['id']
        status = node_results.get(nid, {}).get('status', 'pending')
        nodes_with_status.append(n)
        node_results.setdefault(nid, {})['status'] = status

    status_map = {nid: nr.get('status', 'pending') for nid, nr in node_results.items()}

    # Find ready nodes
    ready_ids = find_ready_nodes(nodes, edges, status_map)

    configuration = workflow.get('configuration', '{}')
    if isinstance(configuration, str):
        configuration = json.loads(configuration)

    for ready_id in ready_ids:
        node = next((n for n in nodes if n['id'] == ready_id), None)
        if node:
            invoke_node(execution_id, execution.get('workflowId', ''), node, output, configuration)

    # Check if all nodes are terminal (completed, skipped, or failed)
    all_terminal = all(
        status_map.get(n['id'], 'pending') in ('completed', 'skipped', 'failed')
        for n in nodes
    )

    if all_terminal:
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET #status = :status, #completedAt = :completedAt',
            ExpressionAttributeNames={'#status': 'status', '#completedAt': 'completedAt'},
            ExpressionAttributeValues={':status': 'completed', ':completedAt': now},
        )
        events.publish_workflow_completed(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            completed_at=now,
            output=output,
        )


def handle_node_failure(execution_id: str, node_id: str, error: str) -> None:
    """Handle a failed node — retry or fail the execution.

    1. Check retry policy for the node
    2. If retryable → increment retryCount, calculate backoff, schedule retry
    3. If not retryable or retries exhausted → mark node failed
    4. Publish appropriate events
    5. Mark execution as failed if no retry
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    workflow = _load_workflow(execution.get('workflowId', ''))
    if not workflow:
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    node_results = execution.get('nodeResults', {})

    node_data = node_results.get(node_id, {})
    agent_id = node_data.get('agentId', '')
    retry_count = node_data.get('retryCount', 0)

    # Idempotency guard against duplicate deliveries. If the persisted node
    # status is already the terminal 'failed' (retries exhausted), this is a
    # replay of the same node-failed event — return without re-updating state
    # or re-emitting the terminal workflow.failed event. A node still
    # 'running'/'pending' is NOT terminal, so the legitimate retry path below
    # (retries remaining) still runs.
    if node_data.get('status') == 'failed':
        return

    # Find the node definition to check retry policy
    node_def = next((n for n in nodes if n['id'] == node_id), None)
    retry_policy = node_def.get('data', {}).get('retryPolicy', {}) if node_def else {}

    max_retries = retry_policy.get('maxRetries', 0)
    retryable_errors = retry_policy.get('retryableErrors', [])
    backoff_base = retry_policy.get('backoffBase', 1.0)
    backoff_max = retry_policy.get('backoffMax', 60.0)

    now = _now_iso()

    if should_retry(error, retryable_errors, retry_count, max_retries):
        # Retry the node
        backoff = calculate_backoff(retry_count, backoff_base, backoff_max)
        new_retry_count = retry_count + 1

        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET nodeResults.#nid.#rc = :rc, nodeResults.#nid.#status = :status',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#rc': 'retryCount',
                '#status': 'status',
            },
            ExpressionAttributeValues={':rc': new_retry_count, ':status': 'pending'},
        )

        events.publish_node_retrying(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            node_id=node_id,
            agent_id=agent_id,
            retry_count=new_retry_count,
            backoff=backoff,
        )
        # Correlation log only — a retry is not a terminal failure, so it does
        # NOT emit the NodeFailure metric (that would double-count retries).
        _log_event(
            'node_retrying',
            executionId=execution_id,
            workflowId=execution.get('workflowId', ''),
            nodeId=node_id,
            agentId=agent_id or None,
            retryCount=new_retry_count,
        )
    else:
        # No retry — mark node and execution as failed
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET nodeResults.#nid.#status = :nstatus, nodeResults.#nid.#error = :error, #status = :estatus, #failedAt = :failedAt',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#status': 'status',
                '#failedAt': 'failedAt',
                '#nstatus': 'status',
                '#error': 'error',
            },
            ExpressionAttributeValues={
                ':nstatus': 'failed',
                ':error': error,
                ':estatus': 'failed',
                ':failedAt': now,
            },
        )

        # NOTE: workflow.node.failed is NOT re-emitted here. Like completion,
        # this handler is triggered BY that event (the worker is its sole
        # producer) and the step runner's own EventBridge rule consumes it, so
        # re-emitting would self-trigger. We keep the terminal workflow.failed.

        # Best-effort telemetry (WF-053): terminal failure count + correlation
        # log. Both are non-fatal — execution failure handling proceeds
        # regardless of the telemetry backend.
        workflow_id = execution.get('workflowId', '')
        _log_event(
            'node_failed',
            executionId=execution_id,
            workflowId=workflow_id,
            nodeId=node_id,
            agentId=agent_id or None,
            error=error,
        )
        _emit_metric('NodeFailure', 1, 'Count', workflow_id=workflow_id)

        events.publish_workflow_failed(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            failed_node_id=node_id,
            error=error,
            failed_at=now,
        )


def cancel_execution(execution_id: str) -> None:
    """Cancel a running execution.

    1. Load execution from DynamoDB
    2. Update execution status → cancelled
    3. Mark all pending/running nodes as cancelled
    4. Publish workflow.failed event with cancellation reason
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    now = _now_iso()
    node_results = execution.get('nodeResults', {})

    # Mark all pending/running nodes as cancelled
    for nid, nr in node_results.items():
        if nr.get('status') in ('pending', 'running'):
            _executions_table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression='SET nodeResults.#nid.#status = :status',
                ExpressionAttributeNames={'#nid': nid, '#status': 'status'},
                ExpressionAttributeValues={':status': 'cancelled'},
            )

    # Update execution status to cancelled
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET #status = :status, #completedAt = :completedAt',
        ExpressionAttributeNames={'#status': 'status', '#completedAt': 'completedAt'},
        ExpressionAttributeValues={':status': 'cancelled', ':completedAt': now},
    )

    events.publish_workflow_failed(
        execution_id=execution_id,
        workflow_id=execution.get('workflowId', ''),
        failed_node_id='',
        error='Execution cancelled',
        failed_at=now,
    )
