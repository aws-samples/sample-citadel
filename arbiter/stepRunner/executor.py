"""Executor module — orchestration logic for workflow step execution.

Coordinates workflow execution by loading state from DynamoDB, advancing
through the DAG, evaluating conditional edges, handling convergence barriers,
retrying failed nodes, and publishing lifecycle events via EventBridge.

All operations are idempotent — re-processing the same event checks
DynamoDB state first to avoid duplicate work.
"""

import boto3
import json
import os
from datetime import datetime, timezone

import events
from dag import find_root_nodes, find_ready_nodes, find_convergence_nodes
from condition import evaluate_condition
from retry import calculate_backoff, should_retry

# DynamoDB table names from environment
WORKFLOWS_TABLE = os.environ.get('WORKFLOWS_TABLE', 'citadel-workflows-dev')
EXECUTIONS_TABLE = os.environ.get('EXECUTIONS_TABLE', 'citadel-executions-dev')

# DynamoDB resource
_dynamodb = boto3.resource('dynamodb')
_workflows_table = _dynamodb.Table(WORKFLOWS_TABLE)
_executions_table = _dynamodb.Table(EXECUTIONS_TABLE)


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


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
    4. Publish workflow.node.invoke event (picked up by worker wrapper)
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
    agent_id = node_data.get('agentId', '')

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

    # Publish node.completed event
    events.publish_node_completed(
        execution_id=execution_id,
        workflow_id=execution.get('workflowId', ''),
        node_id=node_id,
        agent_id=agent_id,
        completed_at=now,
        output=output,
    )

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

        events.publish_node_failed(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            node_id=node_id,
            agent_id=agent_id,
            error=error,
            retry_count=retry_count,
        )

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
