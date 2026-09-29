"""Enumeration of the dispatch entry points that MUST call the record-approval
gate (CIT-041), consumed by ``test_approval_gate_enumeration.py``.

Why a fixture and not a hardcoded list in the test: this is the cross-file
contract. Adding a new agent-dispatch path anywhere in the three modules below
must either register it HERE (with the gate names it calls and the dispatch
side effect the gate must precede) or add it to ``EXEMPT`` with a reason. The
completeness test fails loudly on anything that does neither.

Module paths are relative to ``arbiter/``. Call names are matched against the
callee of an ``ast.Call``: a bare ``Name`` matches on its ``id``; an
``Attribute`` chain matches on its dotted form (``_executions_table.update_item``)
or on its trailing segment (``update_item``) — see the test's ``_callee_name``.
"""
from __future__ import annotations

import re
from typing import NamedTuple


class DispatchEntryPoint(NamedTuple):
    module: str
    """Path relative to arbiter/ (e.g. ``"supervisor/index.py"``)."""

    function: str
    """Name of the entry-point function inside ``module``."""

    required_gates: tuple[str, ...]
    """Every one of these must be called inside ``function``. For the
    supervisor the gate is two calls (resolve then decide); for the two
    ``_check_approval_gate`` adapters it is a single call."""

    anchor: str
    """The dispatch / first side-effect call inside ``function``. Every
    required gate call must appear BEFORE the first occurrence of this
    call, so a refusal leaves no partial dispatch trace."""

    note: str
    """Where the gate sits and what the anchor is, for the failure message."""


DISPATCH_ENTRY_POINTS: tuple[DispatchEntryPoint, ...] = (
    DispatchEntryPoint(
        module="supervisor/index.py",
        function="governed_process_agent_call",
        # ``approval_decide`` is the module-level alias for
        # ``_gov_pkg.record_approval.decide`` (bound in the governance import
        # block); the source never spells the call as ``decide(...)``.
        required_gates=("resolve_record_approval", "approval_decide"),
        anchor="process_agent_call",
        note=(
            "step 5c: resolve_record_approval(agent_cfg) + approval_decide(...) "
            "must run before the un-gated process_agent_call primitive"
        ),
    ),
    DispatchEntryPoint(
        module="stepRunner/executor.py",
        function="invoke_node",
        required_gates=("_check_approval_gate",),
        anchor="_executions_table.update_item",
        note=(
            "gate is evaluated before any state mutation; the anchor is the "
            "pending->running nodeResults update_item write"
        ),
    ),
    DispatchEntryPoint(
        module="workerWrapper/index.py",
        function="_process_workflow_node",
        required_gates=("_check_approval_gate",),
        anchor="run_agent_in_subprocess",
        note=(
            "second-layer gate on the already-fetched agent record, before "
            "the agent subprocess invocation"
        ),
    ),
    DispatchEntryPoint(
        module="workerWrapper/index.py",
        function="process_event",
        required_gates=("_check_approval_gate",),
        anchor="run_agent_in_subprocess",
        note=(
            "task path: second-layer gate on the already-fetched agent record, "
            "before the agent subprocess invocation (the workflow-node path "
            "delegates to _process_workflow_node, which is gated separately)"
        ),
    ),
)


# Functions whose NAME looks like a dispatch entry point. Every function in the
# guarded modules matching this must be in DISPATCH_ENTRY_POINTS or in EXEMPT.
DISPATCH_NAME_PATTERN = re.compile(
    r"invoke_node|process_agent_call|_process_workflow_node|process_event|dispatch"
)


# (module, function) -> reason. Keep reasons concrete: a reviewer must be able
# to decide from the reason alone whether the exemption is still justified.
EXEMPT: dict[tuple[str, str], str] = {
    ("supervisor/index.py", "_emit_release_dispatch_metric"): (
        "CloudWatch metric emitter for the release gate outcome; dispatches nothing."
    ),
    ("supervisor/index.py", "_emit_approval_dispatch_metric"): (
        "CloudWatch metric emitter for the approval gate outcome; dispatches nothing."
    ),
    ("supervisor/index.py", "process_agent_call"): (
        "The un-gated inner dispatch primitive. It is the ANCHOR that "
        "governed_process_agent_call's gate must precede, not an entry point "
        "of its own; callers must go through governed_process_agent_call."
    ),
    ("stepRunner/executor.py", "_extract_dispatch_generation"): (
        "Parses the dispatchGeneration attribute out of an update_item "
        "response; pure, no dispatch."
    ),
    ("stepRunner/executor.py", "_emit_release_dispatch_metric"): (
        "CloudWatch metric emitter for the release gate outcome; dispatches nothing."
    ),
    ("stepRunner/executor.py", "_emit_approval_dispatch_metric"): (
        "CloudWatch metric emitter for the approval gate outcome; dispatches nothing."
    ),
    ("stepRunner/executor.py", "_dispatch_compensation"): (
        "Saga compensation: writes the #comp pseudo-node to 'compensating' and "
        "sends a tool-compensation message (tool + raw args, no agent_id) over "
        "the worker SQS queue. It does not dispatch an agent node, so the "
        "per-agent record-approval gate has no agent record to evaluate here; "
        "any agent work on the worker side still passes through the gated "
        "_process_workflow_node / process_event paths."
    ),
}
