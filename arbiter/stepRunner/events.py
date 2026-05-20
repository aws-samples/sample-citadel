"""Events module — EventBridge publishing helpers for workflow execution lifecycle.

Publishes structured events to EventBridge for every workflow execution
state transition. All events include ISO 8601 timestamp and correlationId
(set to executionId) for cross-service traceability.

Source: citadel.workflows
Bus: citadel-agents-{env} (from EVENT_BUS_NAME env var)
"""

import boto3
import json
from datetime import datetime, timezone
import os

eb_client = boto3.client('events')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', 'citadel-agents-dev')
SOURCE = 'citadel.workflows'


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
