"""Events module — EventBridge publishing helpers for workflow execution lifecycle.

Publishes structured events to EventBridge for every workflow execution
state transition. All events include ISO 8601 timestamp and correlationId
(set to executionId) for cross-service traceability.

Source: citadel.workflows
Bus: citadel-agents-{env} (from EVENT_BUS_NAME env var)
"""

import boto3
import json
import logging
import uuid
from datetime import datetime, timezone
import os

eb_client = boto3.client('events')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', 'citadel-agents-dev')
SOURCE = 'citadel.workflows'

# US-ARB-016: cross-system correlation hooks for supervisor governance.
SUPERVISOR_CHATTER_DETAIL_TYPE = 'supervisor.chatter'
STEP_RUNNER_INVOKE_NODE_SOURCE = 'stepRunner.invoke_node'

_logger = logging.getLogger(__name__)


def publish_event(detail_type: str, detail: dict) -> None:
    """Publish a single event to EventBridge with timestamp injection."""
    detail['timestamp'] = datetime.now(timezone.utc).isoformat()
    eb_client.put_events(Entries=[{
        'Source': SOURCE,
        'DetailType': detail_type,
        'Detail': json.dumps(detail),
        'EventBusName': EVENT_BUS_NAME,
    }])


def publish_workflow_started(execution_id: str, workflow_id: str, app_id: str, started_at: str) -> None:
    """Publish workflow.started event when execution transitions pending → running."""
    publish_event('workflow.started', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'appId': app_id,
        'startedAt': started_at,
        'correlationId': execution_id,
    })


def publish_node_started(execution_id: str, workflow_id: str, node_id: str, agent_id: str, started_at: str) -> None:
    """Publish workflow.node.started event when a node begins execution."""
    publish_event('workflow.node.started', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'nodeId': node_id,
        'agentId': agent_id,
        'startedAt': started_at,
        'correlationId': execution_id,
    })


def publish_node_completed(execution_id: str, workflow_id: str, node_id: str, agent_id: str, completed_at: str, output: dict) -> None:
    """Publish workflow.node.completed event when a node completes successfully."""
    publish_event('workflow.node.completed', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'nodeId': node_id,
        'agentId': agent_id,
        'completedAt': completed_at,
        'output': output,
        'correlationId': execution_id,
    })


def publish_node_failed(execution_id: str, workflow_id: str, node_id: str, agent_id: str, error: str, retry_count: int) -> None:
    """Publish workflow.node.failed event when a node fails."""
    publish_event('workflow.node.failed', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'nodeId': node_id,
        'agentId': agent_id,
        'error': error,
        'retryCount': retry_count,
        'correlationId': execution_id,
    })


def publish_node_retrying(execution_id: str, workflow_id: str, node_id: str, agent_id: str, retry_count: int, backoff: float) -> None:
    """Publish workflow.node.retrying event when a node is scheduled for retry."""
    publish_event('workflow.node.retrying', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'nodeId': node_id,
        'agentId': agent_id,
        'retryCount': retry_count,
        'backoff': backoff,
        'correlationId': execution_id,
    })


def publish_workflow_completed(execution_id: str, workflow_id: str, completed_at: str, output: dict) -> None:
    """Publish workflow.completed event when all nodes complete successfully."""
    publish_event('workflow.completed', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'completedAt': completed_at,
        'output': output,
        'correlationId': execution_id,
    })


def publish_workflow_failed(execution_id: str, workflow_id: str, failed_node_id: str, error: str, failed_at: str) -> None:
    """Publish workflow.failed event when execution fails."""
    publish_event('workflow.failed', {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'failedNodeId': failed_node_id,
        'error': error,
        'failedAt': failed_at,
        'correlationId': execution_id,
    })


def publish_supervisor_chatter(
    execution_id: str,
    workflow_id: str,
    node_id: str,
    *,
    correlation_id: str | None = None,
) -> str:
    """Emit a supervisor.chatter event for cross-system correlation (US-ARB-016).

    Returns the correlationId used (freshly generated if not provided) so the
    caller can include it in its own log line. Fire-and-forget semantics:
    emit failures are logged but never raised — chatter is best-effort
    telemetry, not a governance-critical path.
    """
    cid = correlation_id or str(uuid.uuid4())
    detail = {
        'correlationId': cid,
        'source': STEP_RUNNER_INVOKE_NODE_SOURCE,
        'executionId': execution_id,
        'workflowId': workflow_id,
        'nodeId': node_id,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
    try:
        publish_event(SUPERVISOR_CHATTER_DETAIL_TYPE, detail)
    except Exception as exc:  # noqa: BLE001 — telemetry must not raise
        # Telemetry-only: never break the workflow on chatter failure.
        _logger.warning(
            'supervisor.chatter emit failed for execution=%s node=%s: %s',
            execution_id, node_id, exc,
        )
    return cid
