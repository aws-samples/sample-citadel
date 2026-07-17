"""Canonical message contract for workflow node dispatch and node results.

This module is the single, pure source of truth shared by the workflow step
runner and the worker. It encodes two coordination decisions:

1. **Node dispatch (step runner -> worker).** The step runner dispatches a
   workflow node to the worker by reusing the shared worker SQS queue. Because
   that queue also carries supervisor task messages, every workflow-node
   message stamps a discriminator field (``message_type``) so the worker can
   tell the two apart. The supervisor task message (orchestration_id /
   agent_use_id / agent_input / node) carries no such discriminator, so the
   two shapes never collide.

2. **Node result (worker -> EventBridge).** The worker is the sole producer of
   the node-completed / node-failed events. Their event source and detail-type
   strings mirror exactly what the step runner's ``events`` module already
   emits; the accompanying test suite pins this to prevent drift. The event
   detail is consumed by the step runner (to advance the DAG) and by the
   fan-out (for progress), so this module defines both building and parsing.

Wire-format conventions follow each message's existing neighbour:

* The node-dispatch message uses ``snake_case`` keys, matching the supervisor
  task message it shares a queue with.
* The node-result detail uses ``camelCase`` keys (executionId, workflowId,
  nodeId, agentId, output, error), matching the detail bodies the step runner
  already publishes for these very detail-types.

The module is deterministic and dependency-free: no boto3, no network, no
environment reads. The only non-input-derived value is an optional result
timestamp, which callers may supply explicitly for full determinism.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

# --- EventBridge identifiers (mirror the step runner's event helpers) --------

# Event source stamped on every workflow lifecycle event. Matches ``SOURCE``
# in the step runner's events module.
WORKFLOW_EVENT_SOURCE = 'citadel.workflows'

# Detail-type strings for the node-result events the worker emits. These match
# the literals the step runner's publish_node_completed / publish_node_failed
# helpers emit for these events.
NODE_COMPLETED_DETAIL_TYPE = 'workflow.node.completed'
NODE_FAILED_DETAIL_TYPE = 'workflow.node.failed'

# --- Dispatch discriminator --------------------------------------------------

# Discriminator value stamped on every node-dispatch message so a workflow
# node can be told apart from a supervisor task message on the shared queue.
MESSAGE_TYPE_WORKFLOW_NODE = 'workflow_node'

# --- Result status values ----------------------------------------------------

STATUS_COMPLETED = 'completed'
STATUS_FAILED = 'failed'
_VALID_STATUSES = (STATUS_COMPLETED, STATUS_FAILED)


# --- Typed structures --------------------------------------------------------


@dataclass
class NodeDispatchMessage:
    """A workflow node handed to the worker over the shared SQS queue."""

    execution_id: str
    node_id: str
    workflow_id: str
    agent_id: str
    input: dict[str, Any] = field(default_factory=dict)
    configuration: dict[str, Any] = field(default_factory=dict)
    correlation_id: Optional[str] = None
    message_type: str = MESSAGE_TYPE_WORKFLOW_NODE


@dataclass
class NodeResultDetail:
    """The EventBridge detail body of a node-completed / node-failed event.

    A completed result carries ``output`` (and no ``error``); a failed result
    carries ``error`` (and no ``output``).
    """

    execution_id: str
    node_id: str
    workflow_id: str
    agent_id: str
    status: str
    timestamp: str
    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None


# --- Internal validation helpers ---------------------------------------------


def _require_non_empty_str(mapping: dict, key: str, kind: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or value == '':
        raise ValueError(
            f"{kind}: field '{key}' is required and must be a non-empty string"
        )
    return value


def _validate_identity(kind: str, **fields: Any) -> None:
    for key, value in fields.items():
        if not isinstance(value, str) or value == '':
            raise ValueError(
                f"{kind}: field '{key}' is required and must be a non-empty string"
            )


# --- Node-dispatch message ---------------------------------------------------


def build_node_dispatch_message(
    *,
    execution_id: str,
    node_id: str,
    workflow_id: str,
    agent_id: str,
    input: Optional[dict[str, Any]] = None,  # noqa: A002 — field name is part of the contract
    configuration: Optional[dict[str, Any]] = None,
    correlation_id: Optional[str] = None,
) -> dict:
    """Build a JSON-serializable node-dispatch message for the worker queue.

    Validates identifiers and field types up front so a producer cannot emit a
    message the consumer would later reject. ``correlation_id`` is omitted from
    the wire body when not supplied.
    """
    input_data = {} if input is None else input
    config = {} if configuration is None else configuration

    _validate_identity(
        'node-dispatch message',
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
    )
    if not isinstance(input_data, dict):
        raise ValueError("node-dispatch message: 'input' must be an object")
    if not isinstance(config, dict):
        raise ValueError("node-dispatch message: 'configuration' must be an object")
    if correlation_id is not None and not isinstance(correlation_id, str):
        raise ValueError(
            "node-dispatch message: 'correlation_id' must be a string when present"
        )

    message: dict[str, Any] = {
        'message_type': MESSAGE_TYPE_WORKFLOW_NODE,
        'execution_id': execution_id,
        'node_id': node_id,
        'workflow_id': workflow_id,
        'agent_id': agent_id,
        'input': input_data,
        'configuration': config,
    }
    if correlation_id is not None:
        message['correlation_id'] = correlation_id
    return message


def is_workflow_node_message(body: Any) -> bool:
    """True only when *body* carries the workflow-node discriminator.

    A supervisor task message (no ``message_type``) and any non-dict value
    return False, so callers can safely route a shared queue.
    """
    return isinstance(body, dict) and body.get('message_type') == MESSAGE_TYPE_WORKFLOW_NODE


def parse_node_dispatch_message(body: Any) -> NodeDispatchMessage:
    """Parse and validate a node-dispatch message.

    Raises ``ValueError`` if *body* is not a workflow-node message (wrong or
    missing discriminator) or if any required identifier is missing/empty.
    ``input`` and ``configuration`` default to empty objects when absent but
    must be objects when present.
    """
    if not is_workflow_node_message(body):
        raise ValueError(
            "node-dispatch message: missing or invalid 'message_type' "
            "discriminator; not a workflow-node message"
        )

    execution_id = _require_non_empty_str(body, 'execution_id', 'node-dispatch message')
    node_id = _require_non_empty_str(body, 'node_id', 'node-dispatch message')
    workflow_id = _require_non_empty_str(body, 'workflow_id', 'node-dispatch message')
    agent_id = _require_non_empty_str(body, 'agent_id', 'node-dispatch message')

    input_data = body.get('input', {})
    if not isinstance(input_data, dict):
        raise ValueError("node-dispatch message: 'input' must be an object")
    configuration = body.get('configuration', {})
    if not isinstance(configuration, dict):
        raise ValueError("node-dispatch message: 'configuration' must be an object")

    correlation_id = body.get('correlation_id')
    if correlation_id is not None and not isinstance(correlation_id, str):
        raise ValueError(
            "node-dispatch message: 'correlation_id' must be a string when present"
        )

    return NodeDispatchMessage(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
        correlation_id=correlation_id,
    )


# --- Node-result event detail ------------------------------------------------


def build_node_result_detail(
    *,
    execution_id: str,
    node_id: str,
    workflow_id: str,
    agent_id: str,
    status: str,
    output: Optional[dict[str, Any]] = None,
    error: Optional[str] = None,
    timestamp: Optional[str] = None,
) -> dict:
    """Build the EventBridge detail body for a node-result event.

    ``status`` must be ``completed`` or ``failed``. A completed result requires
    an ``output`` object; a failed result requires a non-empty ``error``
    string. ``timestamp`` defaults to the current UTC time (ISO 8601) when not
    supplied; pass it explicitly for deterministic output.
    """
    _validate_identity(
        'node-result event',
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
    )
    if status not in _VALID_STATUSES:
        raise ValueError(
            f"node-result event: 'status' must be one of {_VALID_STATUSES}, got {status!r}"
        )

    ts = timestamp if timestamp is not None else datetime.now(timezone.utc).isoformat()
    if not isinstance(ts, str) or ts == '':
        raise ValueError("node-result event: 'timestamp' must be a non-empty string")

    detail: dict[str, Any] = {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'nodeId': node_id,
        'agentId': agent_id,
        'status': status,
        'timestamp': ts,
    }
    if status == STATUS_COMPLETED:
        if not isinstance(output, dict):
            raise ValueError(
                "node-result event: a 'completed' result requires an 'output' object"
            )
        detail['output'] = output
    else:  # STATUS_FAILED
        if not isinstance(error, str) or error == '':
            raise ValueError(
                "node-result event: a 'failed' result requires a non-empty 'error' string"
            )
        detail['error'] = error
    return detail


def parse_node_result_detail(detail: Any) -> NodeResultDetail:
    """Parse and validate a node-result event detail body.

    Raises ``ValueError`` on a missing/empty identifier, a status outside
    ``{completed, failed}``, a completed result without an ``output`` object,
    or a failed result without a non-empty ``error`` string.
    """
    if not isinstance(detail, dict):
        raise ValueError("node-result event: detail must be an object")

    execution_id = _require_non_empty_str(detail, 'executionId', 'node-result event')
    node_id = _require_non_empty_str(detail, 'nodeId', 'node-result event')
    workflow_id = _require_non_empty_str(detail, 'workflowId', 'node-result event')
    agent_id = _require_non_empty_str(detail, 'agentId', 'node-result event')
    timestamp = _require_non_empty_str(detail, 'timestamp', 'node-result event')

    status = detail.get('status')
    if status not in _VALID_STATUSES:
        raise ValueError(
            f"node-result event: 'status' must be one of {_VALID_STATUSES}, got {status!r}"
        )

    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    if status == STATUS_COMPLETED:
        output = detail.get('output')
        if not isinstance(output, dict):
            raise ValueError(
                "node-result event: a 'completed' result requires an 'output' object"
            )
    else:  # STATUS_FAILED
        error = detail.get('error')
        if not isinstance(error, str) or error == '':
            raise ValueError(
                "node-result event: a 'failed' result requires a non-empty 'error' string"
            )

    return NodeResultDetail(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        status=status,
        timestamp=timestamp,
        output=output,
        error=error,
    )
