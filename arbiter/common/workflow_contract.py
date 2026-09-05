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

import re
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


# --- Compensation contract (CIT-123 slice 1: data only) ----------------------
#
# DATA ONLY. This section declares the optional per-node ``compensation``
# block and the workflow-level compensation policy shape. It intentionally
# contains NO executor/worker/dispatch behaviour — see the CIT-123 design
# (slices 2-5) for the template renderer, unwind orchestration, governed
# execution, and sink/UI. A node or workflow with no compensation data is
# byte-identical to pre-feature behaviour: nothing in this module is read by
# any existing code path yet, and none of the existing dispatch/result
# builders above are touched.
#
# ---------------------------------------------------------------------------
# OWNER-DECISION DEFAULTS (still open — see CIT-123 design ยง4 "Owner-call
# summary"). Every default below is deliberately conservative (opt-in / stop
# on failure) and is declared ONCE, here, so changing an owner's ruling later
# is a one-line edit in this block rather than a search across call sites.
# Do not duplicate these literals elsewhere; import the constants.
# ---------------------------------------------------------------------------

# Workflow-level trigger mode: 'off' (compensation never fires) or
# 'on_terminal_failure' (fires once, at the no-retry terminal-fail branch).
# PROVISIONAL DEFAULT: 'off' — compensation is inert until a workflow opts in.
COMPENSATION_TRIGGER_MODE_DEFAULT = 'off'
_VALID_COMPENSATION_TRIGGER_MODES = ('off', 'on_terminal_failure')

# Minimum number of completed, side-effecting, compensation-bearing nodes
# required before an unwind is worth running at all.
# PROVISIONAL DEFAULT: 0 (always unwind when enabled) — some owners may
# prefer 1 to skip a no-op unwind ceremony on an early failure.
COMPENSATION_TRIGGER_MIN_COMPLETED_NODES_DEFAULT = 0

# Behaviour when a single compensation step itself fails mid-unwind:
# 'stop' (halt the remaining unwind) or 'continue' (best-effort, keep going).
# PROVISIONAL DEFAULT: 'stop' — later compensations may depend on earlier
# ones having rolled back; continuing blindly risks a worse inconsistent
# state. See CIT-123 design D5.
COMPENSATION_ON_FAILURE_DEFAULT = 'stop'
_VALID_COMPENSATION_ON_FAILURE = ('stop', 'continue')

# --- Template syntax (D4): restricted ${output.<path>} grammar --------------
#
# Slice 1 validates SYNTAX ONLY at parse/normalize time — no resolution
# against a recorded output (that is the slice-2 renderer). The grammar is a
# root token ``output`` followed by zero or more ``.<identifier>`` or
# ``[<int>]`` segments. No function calls, arithmetic, or arbitrary attribute
# access — this is intentionally NOT eval/format/jinja-compatible so
# injection-gadget shapes (e.g. ``{0.__class__.__mro__}``) are just inert
# non-matching literals, never executed.
_TEMPLATE_TOKEN_RE = re.compile(r'\$\{([^{}]*)\}')
_TEMPLATE_PATH_RE = re.compile(r'^output(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$')


def _validate_template_syntax(value: Any, *, path: str) -> None:
    """Recursively validate ``${output...}`` token syntax in *value*.

    Only string leaves are inspected; a string is scanned for every
    ``${...}`` token and each token body must match the restricted
    ``output`` path grammar. Raises ``ValueError`` (mentioning 'template')
    on any malformed token. Non-token text (including gadget-shaped
    literals that are not well-formed ``${...}`` tokens) is left untouched.
    """
    if isinstance(value, str):
        for match in _TEMPLATE_TOKEN_RE.finditer(value):
            token_body = match.group(1)
            if not _TEMPLATE_PATH_RE.match(token_body):
                raise ValueError(
                    "compensation args: malformed template reference "
                    f"'${{{token_body}}}' at {path} — expected "
                    "'output', 'output.<key>', or 'output[<index>]' segments"
                )
        # An unmatched literal '${' or stray '}' with no balanced pair is
        # also malformed template syntax.
        if value.count('${') != len(list(_TEMPLATE_TOKEN_RE.finditer(value))):
            raise ValueError(
                f"compensation args: unbalanced template braces in value at {path}"
            )
    elif isinstance(value, dict):
        for key, nested in value.items():
            _validate_template_syntax(nested, path=f'{path}.{key}')
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _validate_template_syntax(nested, path=f'{path}[{index}]')
    # Other scalar types (int, float, bool, None) carry no template syntax.


_COMPENSATION_BLOCK_KEYS = ('tool', 'args', 'sideEffecting')


def normalize_compensation_block(node: dict) -> Optional[dict]:
    """Validate and normalize a node definition's optional ``compensation``
    block.

    Returns ``None`` when *node* carries no (or a ``None``) ``compensation``
    key — this is the byte-identical-when-absent path. Returns
    ``{'tool': str, 'args': dict, 'sideEffecting': bool}`` (defaulting
    ``sideEffecting`` to ``True``) when a well-formed block is present.

    Raises ``ValueError`` — loudly, never silently coerced — when the block
    is present but malformed: not an object, an unknown key, a missing/empty
    ``tool``, a non-object ``args``, a non-bool ``sideEffecting``, or a
    template-syntax error inside ``args`` (see ``_validate_template_syntax``).

    DATA ONLY: this function performs no I/O, no template resolution, and is
    not called from any executor/worker/dispatch path in this slice.
    """
    if not isinstance(node, dict):
        raise ValueError("compensation block: node definition must be an object")

    block = node.get('compensation')
    if block is None:
        return None

    if not isinstance(block, dict):
        raise ValueError("compensation block: 'compensation' must be an object when present")

    unknown_keys = set(block.keys()) - set(_COMPENSATION_BLOCK_KEYS)
    if unknown_keys:
        raise ValueError(
            f"compensation block: unknown key(s) {sorted(unknown_keys)}; "
            f"allowed keys are {_COMPENSATION_BLOCK_KEYS}"
        )

    tool = block.get('tool')
    if not isinstance(tool, str) or tool == '':
        raise ValueError("compensation block: field 'tool' is required and must be a non-empty string")

    args = block.get('args')
    if not isinstance(args, dict):
        raise ValueError("compensation block: field 'args' is required and must be an object")
    _validate_template_syntax(args, path='args')

    side_effecting = block.get('sideEffecting', True)
    if not isinstance(side_effecting, bool):
        raise ValueError("compensation block: field 'sideEffecting' must be a boolean when present")

    return {'tool': tool, 'args': args, 'sideEffecting': side_effecting}


_COMPENSATION_POLICY_KEYS = ('enabled', 'trigger', 'onFailure')
_COMPENSATION_TRIGGER_KEYS = ('mode', 'minCompletedNodes')


def normalize_compensation_policy(policy: Optional[dict]) -> dict:
    """Validate and normalize a workflow-level compensation policy block.

    Applies the conservative provisional defaults declared above for any
    absent field. Accepts ``None`` (workflow carries no compensation policy
    at all) and returns the fully-defaulted, all-disabled shape — this is
    the byte-identical-when-absent path for the workflow-level policy.

    Raises ``ValueError`` — loudly — on an unknown top-level or nested
    ``trigger`` key, a non-bool ``enabled``, an invalid ``trigger.mode``, a
    negative ``trigger.minCompletedNodes``, or an invalid ``onFailure``.

    DATA ONLY: no trigger evaluation, no executor wiring in this slice.
    """
    if policy is None:
        policy = {}
    if not isinstance(policy, dict):
        raise ValueError("compensation policy: 'compensation' policy must be an object")

    unknown_keys = set(policy.keys()) - set(_COMPENSATION_POLICY_KEYS)
    if unknown_keys:
        raise ValueError(
            f"compensation policy: unknown key(s) {sorted(unknown_keys)}; "
            f"allowed keys are {_COMPENSATION_POLICY_KEYS}"
        )

    enabled = policy.get('enabled', False)
    if not isinstance(enabled, bool):
        raise ValueError("compensation policy: field 'enabled' must be a boolean")

    trigger = policy.get('trigger', {})
    if not isinstance(trigger, dict):
        raise ValueError("compensation policy: field 'trigger' must be an object")
    unknown_trigger_keys = set(trigger.keys()) - set(_COMPENSATION_TRIGGER_KEYS)
    if unknown_trigger_keys:
        raise ValueError(
            f"compensation policy: unknown trigger key(s) {sorted(unknown_trigger_keys)}; "
            f"allowed keys are {_COMPENSATION_TRIGGER_KEYS}"
        )

    mode = trigger.get('mode', COMPENSATION_TRIGGER_MODE_DEFAULT)
    if mode not in _VALID_COMPENSATION_TRIGGER_MODES:
        raise ValueError(
            f"compensation policy: trigger 'mode' must be one of "
            f"{_VALID_COMPENSATION_TRIGGER_MODES}, got {mode!r}"
        )

    min_completed_nodes = trigger.get(
        'minCompletedNodes', COMPENSATION_TRIGGER_MIN_COMPLETED_NODES_DEFAULT
    )
    if (
        not isinstance(min_completed_nodes, int)
        or isinstance(min_completed_nodes, bool)
        or min_completed_nodes < 0
    ):
        raise ValueError(
            "compensation policy: trigger 'minCompletedNodes' must be a non-negative int"
        )

    on_failure = policy.get('onFailure', COMPENSATION_ON_FAILURE_DEFAULT)
    if on_failure not in _VALID_COMPENSATION_ON_FAILURE:
        raise ValueError(
            f"compensation policy: 'onFailure' must be one of "
            f"{_VALID_COMPENSATION_ON_FAILURE}, got {on_failure!r}"
        )

    return {
        'enabled': enabled,
        'trigger': {'mode': mode, 'minCompletedNodes': min_completed_nodes},
        'onFailure': on_failure,
    }


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
    # Additive (PR2 dispatch-generation fence): the per-node dispatch
    # generation the step runner incremented on this node's pending->running
    # transition. Carried to the worker so its tool-call reserve can be fenced
    # against the execution row's current generation — a stale
    # (re-dispatched-away) worker is refused before any side effect. None for a
    # pre-fence dispatcher or a malformed wire value; when None the worker's
    # reserve is unfenced (exactly-once-within-attempt only), preserving
    # back-compat.
    dispatch_generation: Optional[int] = None


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


#: Delimiter used to join segments of the tool-execution ledger's sort key
#: (``nodeId#callIndex#toolName#argsHash``, see
#: ``workerWrapper.tool_idempotency.build_sort_key``). An identifier that
#: itself contains this character can derive a ledger key indistinguishable
#: from a DIFFERENT identifier's key (e.g. node id ``n1#comp`` collides with
#: the compensation pseudo-node derived from node id ``n1``) — the colliding
#: party then replays the other's recorded result via a ledger HIT_COMPLETED
#: and skips its own real side effect. Rejected here, at message BUILD time
#: (create/send), for every identifier that flows into a ledger key segment.
#: This function is NOT called on the message PARSE/read path (see
#: ``parse_node_dispatch_message`` / ``parse_node_result_detail``), so an
#: already-stored message or workflow execution containing a legacy '#'
#: identifier still parses; only NEW build calls are rejected.
#:
#: Scope note: this module has no workflow-DEFINITION (nodes[].id)
#: create/update validator — that create/update path lives in the backend
#: TypeScript layer (``backend/src/lambda/workflow-resolver.ts``), which
#: currently applies NO character restriction to a node id either (confirmed
#: by inspection: no ``valid``/regex/pattern check on any node id field in
#: that resolver). No committed/seeded workflow definition or blueprint in
#: this repository uses ``'#'`` in a node id (confirmed by search). Extending
#: rejection to that TypeScript create/update path is out of scope for this
#: Python-side ledger-key fix; flagged here rather than silently assumed.
LEDGER_KEY_DELIMITER = '#'


def _validate_identity(kind: str, **fields: Any) -> None:
    for key, value in fields.items():
        if not isinstance(value, str) or value == '':
            raise ValueError(
                f"{kind}: field '{key}' is required and must be a non-empty string"
            )
        if LEDGER_KEY_DELIMITER in value:
            raise ValueError(
                f"{kind}: field '{key}' must not contain the reserved "
                f"delimiter {LEDGER_KEY_DELIMITER!r} (got {value!r})"
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
    dispatch_generation: Optional[int] = None,
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
    if dispatch_generation is not None and (
        not isinstance(dispatch_generation, int) or isinstance(dispatch_generation, bool)
    ):
        raise ValueError(
            "node-dispatch message: 'dispatch_generation' must be an int when present"
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
    if dispatch_generation is not None:
        message['dispatch_generation'] = dispatch_generation
    return message


def is_workflow_node_message(body: Any) -> bool:
    """True only when *body* carries the workflow-node discriminator.

    A supervisor task message (no ``message_type``) and any non-dict value
    return False, so callers can safely route a shared queue.
    """
    return isinstance(body, dict) and body.get('message_type') == MESSAGE_TYPE_WORKFLOW_NODE


# --- Compensation dispatch message (CIT-123 slice 3) ------------------------
#
# A SEPARATE discriminator from MESSAGE_TYPE_WORKFLOW_NODE — the worker-side
# governed execution path (slice 4) does not exist yet, so this message type
# is currently inert: nothing in the deployed worker recognises
# 'workflow_compensation' today, and slice 3 dispatches it only when a
# workflow has explicitly opted in (workflow_contract.normalize_compensation_
# policy().enabled). Per design D2/D4, the ``args`` on this message are the
# RAW, UNRESOLVED compensation template (e.g. '${output.id}') — rendering
# against the compensating node's recorded output happens worker-side in
# slice 4 (the slice-2 renderer module is deliberately NOT imported here).
MESSAGE_TYPE_WORKFLOW_COMPENSATION = 'workflow_compensation'


def build_compensation_dispatch_message(
    *,
    execution_id: str,
    node_id: str,
    workflow_id: str,
    tool: str,
    args: Optional[dict[str, Any]] = None,
    compensation_generation: Optional[int] = None,
    dispatched_at: Optional[str] = None,
    run_id: Optional[str] = None,
) -> dict:
    """Build a JSON-serializable compensation-dispatch message.

    ``node_id`` is the compensation PSEUDO-node id (``'{origNodeId}#comp'``),
    matching the ``nodeResults`` key the executor tracks compensation state
    under — never the original node's own id, so a compensation dispatch can
    never be confused with a forward node dispatch even on the same queue.

    ``args`` is the RAW template dict (unresolved ``${output...}`` tokens) —
    this function performs no rendering/validation of template syntax; that
    is `workflow_contract.normalize_compensation_block`'s job at data-entry
    time (slice 1) and the renderer's job worker-side (slice 4).

    ``compensation_generation`` mirrors the forward dispatch's
    ``dispatch_generation`` fence (D3/E): the per-EXECUTION monotonic counter
    minted once when the unwind starts, carried so a stale (re-dispatched-
    away) unwind worker can be fenced before any side effect. Omitted when
    not supplied, keeping the message byte-identical for any caller that
    hasn't adopted the fence.
    """
    args_data = {} if args is None else args
    # CIT-123 slice 5 fix (justified deviation from slice 3's ecb63b5, see
    # TestBuildCompensationDispatchMessagePseudoNodeId in
    # common/__tests__/test_workflow_contract.py for the full regression
    # writeup): _validate_identity's blanket '#'-delimiter rejection (added
    # by the f9ceb38e ledger-key-collision fix) is correct for
    # execution_id/workflow_id/tool, but node_id on THIS message is, by this
    # function's own docstring, ALWAYS the compensation pseudo-node id
    # ('{origNodeId}#comp') — so the blanket check made every real
    # compensation dispatch raise. node_id is validated separately below
    # with the same non-empty-string requirement, minus the delimiter
    # rejection that does not apply to it.
    _validate_identity(
        'compensation-dispatch message',
        execution_id=execution_id,
        workflow_id=workflow_id,
        tool=tool,
    )
    if not isinstance(node_id, str) or node_id == '':
        raise ValueError(
            "compensation-dispatch message: field 'node_id' is required and must be a non-empty string"
        )
    if not isinstance(args_data, dict):
        raise ValueError("compensation-dispatch message: 'args' must be an object")
    if compensation_generation is not None and (
        not isinstance(compensation_generation, int) or isinstance(compensation_generation, bool)
    ):
        raise ValueError(
            "compensation-dispatch message: 'compensation_generation' must be an int when present"
        )
    if dispatched_at is not None and not isinstance(dispatched_at, str):
        raise ValueError(
            "compensation-dispatch message: 'dispatched_at' must be a string when present"
        )
    if run_id is not None and not isinstance(run_id, str):
        raise ValueError(
            "compensation-dispatch message: 'run_id' must be a string when present"
        )

    message: dict[str, Any] = {
        'message_type': MESSAGE_TYPE_WORKFLOW_COMPENSATION,
        'execution_id': execution_id,
        'node_id': node_id,
        'workflow_id': workflow_id,
        'tool': tool,
        'args': args_data,
    }
    if compensation_generation is not None:
        message['compensation_generation'] = compensation_generation
    if dispatched_at is not None:
        message['dispatchedAt'] = dispatched_at
    if isinstance(run_id, str) and run_id:
        message['runId'] = run_id
    return message


def is_workflow_compensation_message(body: Any) -> bool:
    """True only when *body* carries the compensation-dispatch discriminator.

    Mirrors ``is_workflow_node_message`` exactly, for the same
    shared-queue-routing reason.
    """
    return isinstance(body, dict) and body.get('message_type') == MESSAGE_TYPE_WORKFLOW_COMPENSATION


# --- Compensation-result event (CIT-123 slice 5, scope A: closes the missing
#     worker -> step-runner seam) -------------------------------------------
#
# Slice 3 (executor.py) writes ``handle_compensation_result`` as the re-entry
# point that advances/stops the unwind, and slice 4 (compensation_executor.py)
# writes ``execute_compensation`` as the worker-side governed runner — but
# nothing between them was ever wired: no event carried a compensation's
# outcome from the worker back to the step runner, and no Lambda handler
# routed such an event into ``handle_compensation_result``. Confirmed by
# inspection (not assumed): neither ``arbiter/stepRunner/index.py`` nor
# ``arbiter/workerWrapper/index.py`` reference ``execute_compensation`` or
# ``handle_compensation_result`` before this slice. Every previous test drove
# ``handle_compensation_result`` directly, standing in for the not-yet-built
# wire.
#
# These two detail-type constants + the builder/parser pair below mirror
# ``NODE_COMPLETED_DETAIL_TYPE`` / ``NODE_FAILED_DETAIL_TYPE`` and
# ``build_node_result_detail`` / ``parse_node_result_detail`` exactly, scoped
# to the compensation-result shape: keyed by the ORIGINAL node id (never the
# ``'#comp'`` pseudo id — the pseudo id is a nodeResults-key convention
# internal to the step runner, not a wire concern) plus the
# ``compensation_generation`` fence value so a stale delivery can be
# recognised at the SAME point ``handle_compensation_result`` already
# fences on.
COMPENSATION_COMPLETED_DETAIL_TYPE = 'workflow.compensation.completed'
COMPENSATION_FAILED_DETAIL_TYPE = 'workflow.compensation.failed'


def build_compensation_result_detail(
    *,
    execution_id: str,
    original_node_id: str,
    workflow_id: str,
    tool: str,
    status: str,
    output: Optional[dict[str, Any]] = None,
    error: Optional[str] = None,
    compensation_generation: Optional[int] = None,
    timestamp: Optional[str] = None,
) -> dict:
    """Build the EventBridge detail body for a compensation-result event.

    ``status`` must be ``completed`` or ``failed`` (reusing
    ``STATUS_COMPLETED`` / ``STATUS_FAILED`` — never a third, parallel status
    vocabulary). ``original_node_id`` is the node whose compensation ran —
    never the ``'#comp'``-suffixed pseudo id (that suffix is derived
    step-runner-side by ``_comp_key`` from this same id).
    """
    if not isinstance(original_node_id, str) or original_node_id == '':
        raise ValueError(
            "compensation-result event: field 'original_node_id' is required and must be a non-empty string"
        )
    _validate_identity(
        'compensation-result event',
        execution_id=execution_id,
        workflow_id=workflow_id,
        tool=tool,
    )
    if status not in _VALID_STATUSES:
        raise ValueError(
            f"compensation-result event: 'status' must be one of {_VALID_STATUSES}, got {status!r}"
        )
    ts = timestamp if timestamp is not None else datetime.now(timezone.utc).isoformat()

    detail: dict[str, Any] = {
        'executionId': execution_id,
        'originalNodeId': original_node_id,
        'workflowId': workflow_id,
        'tool': tool,
        'status': status,
        'timestamp': ts,
    }
    if status == STATUS_COMPLETED:
        detail['output'] = output if isinstance(output, dict) else {}
    else:
        if not isinstance(error, str) or error == '':
            raise ValueError(
                "compensation-result event: a 'failed' result requires a non-empty 'error' string"
            )
        detail['error'] = error
    if compensation_generation is not None:
        detail['compensationGeneration'] = compensation_generation
    return detail


def parse_compensation_result_detail(detail: Any) -> dict:
    """Parse a compensation-result event detail body into the keyword
    arguments ``executor.handle_compensation_result`` accepts directly —
    returned as a plain dict (not a dataclass) since the step runner's
    handler already takes keyword args, not an object; this avoids adding a
    parallel dataclass nothing else needs to construct.
    """
    if not isinstance(detail, dict):
        raise ValueError('compensation-result event: detail must be an object')
    execution_id = detail.get('executionId')
    original_node_id = detail.get('originalNodeId')
    status = detail.get('status')
    if not isinstance(execution_id, str) or execution_id == '':
        raise ValueError("compensation-result event: field 'executionId' is required")
    if not isinstance(original_node_id, str) or original_node_id == '':
        raise ValueError("compensation-result event: field 'originalNodeId' is required")
    if status not in _VALID_STATUSES:
        raise ValueError(f"compensation-result event: 'status' must be one of {_VALID_STATUSES}")
    return {
        'execution_id': execution_id,
        'original_node_id': original_node_id,
        'success': status == STATUS_COMPLETED,
        'output': detail.get('output') if status == STATUS_COMPLETED else None,
        'error': detail.get('error') if status == STATUS_FAILED else None,
        'compensation_generation': detail.get('compensationGeneration'),
    }


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

    dispatch_generation = body.get('dispatch_generation')
    if isinstance(dispatch_generation, bool) or not isinstance(dispatch_generation, int):
        # Best-effort, never gates parsing (PR2 fence): a malformed/absent
        # generation degrades to None -> the worker's reserve is unfenced.
        dispatch_generation = None

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
        dispatch_generation=dispatch_generation,
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
