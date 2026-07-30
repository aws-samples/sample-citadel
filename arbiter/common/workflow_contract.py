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

from common.usage import parse_usage_array

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
    # Additive (queue-wait metric): the step runner's dispatch-time ISO 8601
    # timestamp, carried so the worker/step-runner can compute a queue-wait
    # duration (dispatch -> worker-start) without a second round trip. None
    # for any pre-feature dispatcher or a malformed wire value — the queue-
    # wait metric is best-effort and must never be fabricated.
    dispatched_at: Optional[str] = None
    # Additive (Pass 1, decision f1cbd5ef): the server-minted correlation id
    # carried from the execution row through dispatch to the worker. None
    # for any pre-runId dispatcher, a pre-runId execution row, or a
    # malformed wire value — best-effort, never fabricated.
    run_id: Optional[str] = None


@dataclass
class NodeResultDetail:
    """The EventBridge detail body of a node-completed / node-failed event.

    A completed result carries ``output`` (and no ``error``); a failed result
    carries ``error`` (and no ``output``). ``usage`` is additive: a sanitized
    list of worker usage records lifted to the top level for a completed
    result (``[]`` when absent or when the result is failed).

    ``dispatched_at`` / ``worker_started_at`` are additive (queue-wait
    metric): the step runner's dispatch timestamp and the worker's
    invocation-start timestamp, both echoed back so the step runner can
    compute a dispatch -> worker-start delta without a second round trip.
    Both default to ``None`` — absent on any pre-feature producer.
    """

    execution_id: str
    node_id: str
    workflow_id: str
    agent_id: str
    status: str
    timestamp: str
    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    usage: list[dict[str, Any]] = field(default_factory=list)
    dispatched_at: Optional[str] = None
    worker_started_at: Optional[str] = None


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
    trace_context: Optional[dict[str, Any]] = None,
    dispatched_at: Optional[str] = None,
    run_id: Optional[str] = None,
) -> dict:
    """Build a JSON-serializable node-dispatch message for the worker queue.

    Validates identifiers and field types up front so a producer cannot emit a
    message the consumer would later reject. ``correlation_id`` is omitted from
    the wire body when not supplied.

    ``trace_context`` is additive and optional (architect task
    f4f4bab3-7a07-4acf-ba43-ba43bb488444, H3 SQS hop): a carried traceContext
    dict promoted to a top-level ``traceContext`` key when supplied. Omitted
    entirely when not passed, keeping the message byte-identical to
    pre-feature callers.

    ``dispatched_at`` is additive and optional (queue-wait metric): the ISO
    8601 timestamp of this dispatch call, promoted to a top-level
    ``dispatchedAt`` key when supplied. Omitted entirely when not passed, so
    the message stays byte-identical to pre-feature callers.

    ``run_id`` is additive, optional, and nullable (Pass 1, decision
    f1cbd5ef): the server-minted correlation id, promoted to a top-level
    ``runId`` key ONLY when a non-empty string is supplied. Never read from
    anywhere except this explicit kwarg — there is no path from an inbound
    dict to the emitted ``runId``, honoring the server-minted-only invariant
    at this layer too.
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
    if dispatched_at is not None and not isinstance(dispatched_at, str):
        raise ValueError(
            "node-dispatch message: 'dispatched_at' must be a string when present"
        )
    if run_id is not None and not isinstance(run_id, str):
        raise ValueError(
            "node-dispatch message: 'run_id' must be a string when present"
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
    if trace_context is not None:
        message['traceContext'] = trace_context
    if dispatched_at is not None:
        message['dispatchedAt'] = dispatched_at
    if isinstance(run_id, str) and run_id:
        message['runId'] = run_id
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

    dispatched_at = body.get('dispatchedAt')
    if dispatched_at is not None and not isinstance(dispatched_at, str):
        dispatched_at = None

    run_id = body.get('runId')
    if run_id is not None and not isinstance(run_id, str):
        # Best-effort, never gates parsing (Pass 1, decision f1cbd5ef) —
        # mirrors dispatched_at's malformed-wire-value degradation above.
        run_id = None

    return NodeDispatchMessage(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
        correlation_id=correlation_id,
        dispatched_at=dispatched_at,
        run_id=run_id,
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
    usage: Optional[list[dict[str, Any]]] = None,
    trace_context: Optional[dict[str, Any]] = None,
    dispatched_at: Optional[str] = None,
    worker_started_at: Optional[str] = None,
    run_id: Optional[str] = None,
) -> dict:
    """Build the EventBridge detail body for a node-result event.

    ``status`` must be ``completed`` or ``failed``. A completed result requires
    an ``output`` object; a failed result requires a non-empty ``error``
    string. ``timestamp`` defaults to the current UTC time (ISO 8601) when not
    supplied; pass it explicitly for deterministic output.

    ``usage`` is additive and optional: a list of worker usage records
    promoted to a top-level ``detail['usage']`` key for a completed result
    (additive to, and separate from, any ``usage`` nested inside ``output``).
    Sanitized via ``parse_usage_array`` — a malformed value degrades to ``[]``
    rather than raising. Only set when a completed result AND a non-None
    ``usage`` was supplied, so omitting it keeps the detail byte-identical to
    pre-feature callers. A failed result never carries a top-level ``usage``
    key, even if one is passed, since there is no output to attribute it to.

    ``trace_context`` is additive and optional (architect task
    f4f4bab3-7a07-4acf-ba43-ba43bb488444): a carried traceContext dict
    promoted to a top-level ``traceContext`` key when supplied, regardless of
    ``status``. Omitted entirely when not passed, keeping the detail
    byte-identical to pre-feature callers.

    ``dispatched_at`` / ``worker_started_at`` are additive and optional
    (queue-wait metric): echoed back verbatim as top-level ``dispatchedAt`` /
    ``workerStartedAt`` keys, regardless of ``status``, so the step runner can
    compute queue-wait without re-fetching state. Each key is omitted
    individually when its value is ``None``, keeping the detail
    byte-identical to pre-feature callers when neither is supplied.

    ``run_id`` is additive, optional, and nullable (Pass 1, decision
    f1cbd5ef): promoted to a top-level ``runId`` key ONLY when a non-empty
    string is supplied, regardless of ``status``. Omitted entirely
    otherwise, keeping the detail byte-identical to pre-runId callers.
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
    if dispatched_at is not None:
        detail['dispatchedAt'] = dispatched_at
    if worker_started_at is not None:
        detail['workerStartedAt'] = worker_started_at
    if status == STATUS_COMPLETED:
        if not isinstance(output, dict):
            raise ValueError(
                "node-result event: a 'completed' result requires an 'output' object"
            )
        detail['output'] = output
        if usage is not None:
            detail['usage'] = parse_usage_array(usage)
    else:  # STATUS_FAILED
        if not isinstance(error, str) or error == '':
            raise ValueError(
                "node-result event: a 'failed' result requires a non-empty 'error' string"
            )
        detail['error'] = error
    if trace_context is not None:
        detail['traceContext'] = trace_context
    if isinstance(run_id, str) and run_id:
        detail['runId'] = run_id
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

    def _optional_str(key: str) -> Optional[str]:
        value = detail.get(key)
        return value if isinstance(value, str) and value else None

    return NodeResultDetail(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        status=status,
        timestamp=timestamp,
        output=output,
        error=error,
        usage=parse_usage_array(detail.get('usage')),
        dispatched_at=_optional_str('dispatchedAt'),
        worker_started_at=_optional_str('workerStartedAt'),
    )
